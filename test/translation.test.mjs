import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { LiveTranslation, splitUtterance, translateText, validateTranslation } from '../server/translation.mjs';
import { createApplication } from '../server/app.mjs';

const direction = { sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' };
const ndjson = text => new Response([JSON.stringify({ message: { content: text } }), JSON.stringify({ done: true, done_reason: 'stop' })].join('\n') + '\n');
async function until(predicate, timeout = 3000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('translation validates language direction and splits long Unicode utterances without losing source', () => {
  assert.throws(() => validateTranslation({ ...direction, targetLanguage: 'ja-JP' }), /翻訳方向/);
  assert.throws(() => validateTranslation({ ...direction, model: 'bad model' }), /モデル名/);
  assert.throws(() => validateTranslation({ model: 'test:4b', text: 'Missing direction' }), /翻訳方向/);
  assert.throws(() => validateTranslation({ ...direction, text: 'あ'.repeat(500) }), /長すぎ/);
  assert.throws(() => validateTranslation({ ...direction, sentenceMode: 'invalid' }), /区切りモード/);
  assert.throws(() => validateTranslation({ ...direction, sentenceMode: '__proto__' }), /区切りモード/);
  assert.equal(validateTranslation(direction).sentenceMode, 'balanced');
  assert.equal(validateTranslation({ ...direction, sentenceMode: 'context' }).sentenceMode, 'context');
  const source = '翻訳テスト😀'.repeat(200);
  const chunks = splitUtterance(source); assert.equal(chunks.join(''), source);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 1200));
});

test('translation streams only content, bounds context and preserves original numbers', async () => {
  let request; const deltas = [];
  const result = await translateText({ ...direction, text: '会議は15時です。', context: [{ source: 'previous'.repeat(1000), translation: 'old'.repeat(1000) }], ollamaUrl: 'http://example.invalid', signal: new AbortController().signal, onDelta: delta => deltas.push(delta), fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return ndjson('The meeting is at 15:00.');
  } });
  assert.equal(result.text, 'The meeting is at 15:00.'); assert.deepEqual(deltas, [result.text]);
  assert.equal(request.think, false); assert.equal(request.stream, true); assert.equal(request.options.num_ctx, 4096);
  assert.equal(request.messages.length, 2); assert.match(request.messages[1].content, /15時/);
  assert.match(request.messages[0].content, /Japanese into English/);
});

test('a live session translates utterances serially and drains after stop', async () => {
  let active = 0, maximum = 0, finished = false; const events = [], requests = [];
  const session = new LiveTranslation({ ...direction, ollamaUrl: 'http://example.invalid', signal: new AbortController().signal, emit: event => events.push(event), drained: () => { finished = true; }, fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body)); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 15)); active--; return ndjson('Translated.');
  } });
  session.enqueue('発話1。'); session.enqueue('発話2。'); session.finishInput();
  assert.equal(finished, false); await until(() => finished);
  assert.equal(maximum, 1); assert.equal(requests.length, 2);
  assert.deepEqual(events.filter(event => event.type === 'translation.completed').map(event => event.id), [1, 2]);
  assert.equal(events.at(-1).type, 'translation.finished');
  assert.equal(requests[1].messages.length, 3); assert.match(requests[1].messages[1].content, /発話1/);
});

test('cancel marks active and queued translations, keeps accepting original utterances', async () => {
  const events = []; let finished = false, calls = 0;
  const session = new LiveTranslation({ ...direction, ollamaUrl: 'http://example.invalid', signal: new AbortController().signal, emit: event => events.push(event), drained: () => { finished = true; }, fetcher: async (_url, options) => {
    calls++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  session.enqueue('一つ目です。'); await until(() => calls === 1);
  session.enqueue('二つ目です。'); session.sentences.settle(); session.cancel();
  session.enqueue('中断後の原文'); session.enqueue('さらに続く原文'); session.finishInput();
  await until(() => finished);
  assert.equal(calls, 1); assert.equal(events.filter(event => event.type === 'translation.error' && event.canceled).length, 2);
  assert.equal(events.find(event => event.type === 'translation.segment' && event.segment.id === 3).segment.status, 'canceled');
  assert.ok(events.some(event => event.type === 'translation.segment' && event.segment.source === 'さらに続く原文'));
});

test('a failed utterance does not stop translation of later speech', async () => {
  const events = []; let finished = false, calls = 0;
  const session = new LiveTranslation({ ...direction, ollamaUrl: 'http://example.invalid', signal: new AbortController().signal, emit: event => events.push(event), drained: () => { finished = true; }, fetcher: async () => ++calls === 1 ? new Response('error', { status: 503 }) : ndjson('Recovered.') });
  session.enqueue('最初です。'); session.enqueue('次です。'); session.finishInput(); await until(() => finished);
  assert.ok(events.some(event => event.type === 'translation.error' && event.id === 1));
  assert.ok(events.some(event => event.type === 'translation.completed' && event.id === 2));
});

test('WebSocket translates during recording, keeps receiving PCM, and waits for translations after commit', async t => {
  const payloads = []; let audioBytes = 0;
  const mock = http.createServer(async (req, res) => {
    if (req.url !== '/api/chat') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ready: true, models: [] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); payloads.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (!body.messages.length) { res.end('{}'); return; }
    setTimeout(() => res.end(JSON.stringify({ message: { content: 'Translation.' } }) + '\n' + JSON.stringify({ done: true }) + '\n'), 150);
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); const upstreamUrl = `http://127.0.0.1:${mock.address().port}`;
  const asr = new WebSocketServer({ server: mock });
  asr.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.on('message', (data, binary) => {
      if (binary) {
        audioBytes += data.length;
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '認識途中' }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: `原文${audioBytes}です。${audioBytes === 3200 ? '続き' : ''}` })); return;
      }
      const event = JSON.parse(data.toString());
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed' }));
    });
  });
  const application = createApplication({ asrUrl: upstreamUrl, ollamaUrl: upstreamUrl, model: 'test:4b' });
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
  const base = `http://127.0.0.1:${application.server.address().port}`;
  t.after(async () => {
    application.cancelProcessing(); for (const client of application.sockets.clients) client.terminate(); for (const client of asr.clients) client.terminate();
    asr.close(); application.sockets.close(); application.server.closeAllConnections(); mock.closeAllConnections();
    await Promise.all([new Promise(resolve => application.server.close(resolve)), new Promise(resolve => mock.close(resolve))]);
  });
  const client = new WebSocket(base.replace('http:', 'ws:') + '/ws/translate'); const events = [];
  client.on('message', data => { const event = JSON.parse(data.toString()); events.push(event); if (event.type === 'session.created') client.send(JSON.stringify({ type: 'session.update', session: { language: 'ja-JP', sample_rate: 16000 }, translation: { targetLanguage: 'en-US', model: 'test:4b', sentenceMode: 'context', correctionMode: 'off' } })); });
  await until(() => events.some(event => event.type === 'session.updated'));
  client.send(Buffer.alloc(3200)); await until(() => events.some(event => event.type === 'translation.started'));
  client.send(Buffer.alloc(3200)); await until(() => audioBytes === 6400);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).recording, true);
  const blocked = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'cannot run concurrently' }) }); assert.equal(blocked.status, 409);
  client.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  await until(() => events.some(event => event.type === 'input_audio_buffer.committed'));
  assert.equal(client.readyState, WebSocket.OPEN);
  await until(() => events.some(event => event.type === 'translation.finished'));
  assert.equal(events.filter(event => event.type === 'translation.completed').length, 2);
  assert.deepEqual(events.filter(event => event.type === 'conversation.item.input_audio_transcription.delta').map(event => event.translationSegmentId), [null, 2]);
  const firstCompleted = events.findIndex(event => event.type === 'conversation.item.input_audio_transcription.completed');
  assert.ok(firstCompleted < events.findIndex(event => event.type === 'translation.segment'));
  assert.equal(events.find(event => event.type === 'translation.ready').sentenceMode, 'context');
  assert.ok(events.filter(event => event.type === 'translation.segment').every(event => event.segment.sentenceMode === 'context'));
  await until(() => client.readyState === WebSocket.CLOSED);
  const health = await (await fetch(`${base}/api/health`)).json(); assert.equal(health.recording, false); assert.equal(health.processing, false);
  assert.equal(payloads.length, 3); // One shared model warmup plus two translations.
  const retryResult = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...direction, text: '再試行' }) });
  assert.match(await retryResult.text(), /Translation/);
});
