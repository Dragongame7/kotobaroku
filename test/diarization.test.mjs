import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { speakerSegments } from '../server/speaker-segments.mjs';
import { LiveTranslation } from '../server/translation.mjs';
import { SessionStore } from '../server/session-store.mjs';
import { SpeechSettings, validateSpeech } from '../server/speech-settings.mjs';
import { apiUrl } from '../server/speech-transport.mjs';
import { createSparkGateway } from '../spark-gateway/app.mjs';
import { createApplication } from '../server/app.mjs';
import { createLlmTransport } from '../server/llm-transport.mjs';
import { documentChunks } from '../server/attributed-document.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-v1-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const source = '次の案件です承知しました';
const words = [{ word: '次の案件です', start: 0, end: 1.2, speaker: 1 }, { word: '承知しました', start: 1.3, end: 2.4, speaker: 2 }];
const key = 'private-gateway-test-key';

test('speaker alignment preserves original whitespace, Japanese, punctuation and Unicode', () => {
  const transcript = '  A😀です。\n承知しました！  ';
  const rows = speakerSegments({ transcript, words: [{ word: 'A😀です。', start: 0, end: 1, speaker: 1 }, { word: '承知しました', start: 1, end: 2, speaker: 2 }] }, { sessionId: 'a', diarization: true });
  assert.equal(rows.map(row => row.source).join(''), transcript); assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.speaker.speakerId), ['spk-1', 'spk-2']);
  assert.equal(rows[1].speechSpans[0].sourceStart, 0); assert.equal(rows[1].audioStart, 1);
  const unknown = speakerSegments({ transcript: '欠落した単語があります', words: [{ word: 'あります', start: 0, end: 1, speaker: 1 }] }, { sessionId: 'a', diarization: true });
  assert.equal(unknown[0].speaker.status, 'unknown'); assert.equal(unknown[0].source, '欠落した単語があります');
  assert.equal(speakerSegments({ transcript: source }, { diarization: true })[0].source, source);
  assert.deepEqual(speakerSegments({ transcript: source }, { diarization: false }), [{ source }]);
});

test('invalid times, missing labels and speakers beyond eight remain unknown', () => {
  for (const invalid of [{ speaker: 9 }, { speaker: 0 }, { speaker: undefined }, { start: -1 }, { end: NaN }]) {
    const row = speakerSegments({ transcript: '確認', words: [{ word: '確認', start: 0, end: 1, speaker: 1, ...invalid }] }, { sessionId: 'a', diarization: true })[0];
    assert.equal(row.speaker.speakerId, null);
  }
});

test('speaker changes cannot combine people, and word provenance survives sentence splits', async () => {
  const events = [], controller = new AbortController(); let drained;
  const done = new Promise(resolve => { drained = resolve; });
  const live = new LiveTranslation({ sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test', correctionMode: 'off', translateEnabled: false, boundaryMode: 'rules', signal: controller.signal, emit: event => events.push(event), drained });
  await live.warm();
  for (const row of speakerSegments({ transcript: source, words }, { sessionId: 'session-a', diarization: true })) live.enqueue(row.source, row);
  live.finishInput(); await done;
  const rows = [...live.rows.values()];
  assert.equal(rows.length, 2); assert.equal(rows.map(row => row.source).join(''), source);
  assert.deepEqual(rows.map(row => row.speaker.speakerId), ['spk-1', 'spk-2']);
  assert.deepEqual(rows.map(row => row.audioStart), [0, 1.3]);
  assert.ok(events.some(event => event.type === 'translation.finished')); controller.abort();
});

test('session journals recover after interruption and preserve names without storing PCM', t => {
  const dir = directory(t), store = new SessionStore(dir);
  const id = store.create({ speech: { diarization: true } });
  store.append(id, { type: 'speech.final', transcript: source });
  store.append(id, { type: 'translation.segment', segment: { id: 1, source, speaker: { sessionId: id, speakerId: 'spk-1' }, revision: 1, status: 'queued' } });
  store.append(id, { type: 'translation.completed', id: 1, revision: 1, text: 'Confirmed.' });
  store.rename(id, 'spk-1', '田中'); store.finish(id);
  const restored = new SessionStore(dir);
  assert.equal(restored.read(id).rows[0].translation, 'Confirmed.'); assert.equal(restored.read(id).speakers['spk-1'], '田中');
  fs.appendFileSync(store.location(id), '{incomplete');
  assert.equal(restored.read(id).incomplete, true); restored.rename(id, 'spk-2', '佐藤');
  assert.equal(restored.read(id).speakers['spk-2'], '佐藤'); assert.equal(restored.read(id).utterances[0].transcript, source);
  assert.throws(() => store.location('../elsewhere')); assert.throws(() => store.rename(id, 'spk-9', 'name'));
  assert.deepEqual(fs.readdirSync(path.dirname(store.location(id))), ['events.jsonl', 'summary.json']);
});

async function fixture(t, { leaseMs = 60000 } = {}) {
  const dir = directory(t), requests = [], audio = [];
  const upstream = http.createServer(async (req, res) => {
    requests.push(req.url); res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/ready')) return res.end(JSON.stringify({ ready: true, device: 'cuda' }));
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const text = body.response_format ? '{"ok":true}' : 'Confirmed.';
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n'); return setTimeout(() => res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'), 5); }
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  const upstreamUrl = await listen(upstream), wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws, req) => {
    audio.push(req.url); let spoken = false;
    ws.send(JSON.stringify({ type: 'session.created' }));
    ws.on('message', (data, binary) => {
      if (binary) { spoken ||= data.some(value => value !== 0); return; }
      const event = JSON.parse(data);
      if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.commit') {
        const final = { type: 'conversation.item.input_audio_transcription.completed', event_id: 'final-1', transcript: spoken ? source : '', words: spoken ? words : [] };
        ws.send(JSON.stringify(final)); if (spoken) ws.send(JSON.stringify(final));
        ws.send(JSON.stringify({ type: 'input_audio_buffer.committed' }));
      }
    });
  });
  const gateway = createSparkGateway({ apiKey: key, asrUrl: upstreamUrl + '/engine', llmUrl: upstreamUrl + '/llm/v1', leaseMs });
  const base = await listen(gateway.server), headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const apps = [];
  const app = async () => {
    const value = createApplication({ speech: { mode: 'spark', baseUrl: base + '/speech', gatewayUrl: base, apiKey: key, diarization: true }, llm: { provider: 'openai', baseUrl: base + '/v1', model: 'test-model', apiKey: key }, settingsPath: path.join(dir, `llm-${apps.length}.json`), sessionDirectory: path.join(dir, `sessions-${apps.length}`) });
    apps.push(value); return { ...value, base: await listen(value.server) };
  };
  t.after(async () => {
    for (const value of apps) { value.cancelProcessing(); for (const ws of value.sockets.clients) ws.terminate(); value.server.closeAllConnections(); await new Promise(resolve => value.server.close(resolve)); }
    await gateway.close(); for (const ws of wss.clients) ws.terminate(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  });
  return { dir, base, headers, gateway, app, requests, audio };
}

test('gateway authenticates, verifies integrated speech, enforces a single lease and expires it', async t => {
  const f = await fixture(t, { leaseMs: 80 });
  assert.equal((await fetch(f.base + '/v1/models')).status, 401);
  const lease = await (await fetch(f.base + '/kotoba/v1/leases', { method: 'POST', headers: f.headers, body: '{"purpose":"meeting"}' })).json();
  assert.ok(lease.token); assert.equal(f.gateway.state.verified, true);
  assert.ok(f.audio.includes('/engine/v1/audio/transcriptions/realtime'));
  assert.equal((await fetch(f.base + '/kotoba/v1/leases', { method: 'POST', headers: f.headers, body: '{"purpose":"meeting"}' })).status, 409);
  assert.equal((await fetch(f.base + '/v1/chat/completions', { method: 'POST', headers: f.headers, body: '{}' })).status, 409);
  assert.equal((await fetch(f.base + '/admin', { headers: f.headers })).status, 404);
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal((await fetch(f.base + `/kotoba/v1/leases/${lease.id}/heartbeat`, { method: 'POST', headers: f.headers, body: JSON.stringify({ token: lease.token }) })).status, 409);
  assert.equal(f.gateway.state.busy, false);
});

test('speech settings require an exact successful test, redact credentials, and keep prefixes', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'speech.json');
  const settings = new SpeechSettings({ file });
  const draft = { ...settings.public(), mode: 'spark', baseUrl: f.base + '/speech/', gatewayUrl: f.base, diarization: true, apiKeyAction: 'replace', apiKey: key };
  assert.equal(apiUrl('https://host/prefix/speech/', '/v1/audio/transcriptions/realtime', true), 'wss://host/prefix/speech/v1/audio/transcriptions/realtime');
  assert.throws(() => validateSpeech({ mode: 'spark', baseUrl: 'http://user:password@host/' }));
  assert.throws(() => settings.save(draft));
  const proof = await settings.test(draft, new AbortController().signal);
  assert.throws(() => settings.save({ ...draft, diarization: false, token: proof.token }));
  const saved = settings.save({ ...draft, token: proof.token });
  assert.equal(saved.diarization, true); assert.equal(JSON.stringify(saved).includes(key), false);
  assert.equal(new SpeechSettings({ file }).current.apiKey, key);
});

test('two terminal apps share Spark exclusion, persist speaker turns, and release after final drain', async t => {
  const f = await fixture(t), a = await f.app(), b = await f.app();
  const ws = new WebSocket(a.base.replace('http:', 'ws:') + '/ws/translate');
  const events = [];
  const done = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', raw => {
      const event = JSON.parse(raw); events.push(event);
      if (event.type === 'session.created') ws.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, language: 'ja-JP' }, translation: { targetLanguage: 'en-US', correctionMode: 'off', boundaryMode: 'rules' } }));
      if (event.type === 'session.updated') resolve();
    });
  });
  await done;
  const blocked = await fetch(b.base + '/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '試験' }) });
  assert.equal(blocked.status, 409);
  const closed = once(ws, 'close'); ws.send(Buffer.from([1, 0, 1, 0])); ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); await closed;
  const finalRows = events.filter(event => event.type === 'translation.segment' && !event.segment.provisional).map(event => event.segment);
  assert.equal(finalRows.length, 2); assert.equal(finalRows.map(row => row.source).join(''), source);
  assert.deepEqual(finalRows.map(row => row.speaker.speakerId), ['spk-1', 'spk-2']);
  assert.equal(events.filter(event => event.type === 'translation.completed').length, 2);
  const history = await (await fetch(a.base + '/api/sessions')).json(); assert.equal(history.sessions.length, 1);
  const id = history.sessions[0].id, record = await (await fetch(a.base + `/api/sessions/${id}`)).json();
  assert.equal(record.utterances.length, 1); assert.equal(record.status, 'completed'); assert.equal(record.rows[1].translation, 'Confirmed.'); assert.equal(record.gaps.length, 0);
  const renamed = await fetch(a.base + `/api/sessions/${id}/speakers/spk-1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"name":"田中"}' });
  assert.equal((await renamed.json())['spk-1'], '田中');
  for (let i = 0; i < 50 && f.gateway.state.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const retry = await fetch(a.base + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id, segmentId: 1, inputRevision: record.rows[0].revision, text: record.rows[0].source, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', correctionMode: 'off' }) });
  assert.equal(retry.status, 200); assert.match(await retry.text(), /"done":true/);
  const retried = await (await fetch(a.base + `/api/sessions/${id}`)).json(); assert.equal(retried.rows[0].llm.provider, 'openai'); assert.equal(retried.rows[0].speaker.speakerId, 'spk-1');
  for (let i = 0; i < 50 && f.gateway.state.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const response = await fetch(b.base + '/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"終了後"}' }); const result = await response.text(); assert.equal(response.status, 200, JSON.stringify({ result, gateway: f.gateway.state }));
});

test('vLLM thinking is disabled only for an explicitly selected profile', async () => {
  let body;
  const transport = createLlmTransport({ provider: 'openai', baseUrl: 'http://test/v1', model: 'm', disableThinking: true }, async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); });
  await transport('http://test/v1/api/chat', { body: '{"messages":[{"role":"user","content":"test"}],"stream":false}' });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test('speaker-attributed document chunks retain source identity and reject edited mismatches', () => {
  const rows = [{ id: 'one', speaker: '話者1', text: '賛成です。' }, { id: 'two', speaker: '話者2', text: '反対です。' }];
  const chunks = documentChunks('賛成です。\n反対です。', rows).flatMap(JSON.parse);
  assert.equal(chunks[0].sourceId, 'one'); assert.equal(chunks[1].speaker, '話者2'); assert.equal(chunks.map(row => row.text).join(''), '賛成です。反対です。');
  assert.throws(() => documentChunks('手編集された別の原稿', rows));
  assert.deepEqual(documentChunks('従来の原稿', undefined), ['従来の原稿']);
});

test('expiring an active audio lease closes upstream and allows the next meeting', { timeout: 5000 }, async t => {
  const f = await fixture(t, { leaseMs: 150 });
  const getLease = () => fetch(f.base + '/kotoba/v1/leases', { method: 'POST', headers: f.headers, body: '{"purpose":"meeting"}' });
  const lease = await (await getLease()).json();
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/speech/v1/audio/transcriptions/realtime', { headers: { ...f.headers, 'X-Kotoba-Lease': lease.token } });
  await once(ws, 'open'); await once(ws, 'close');
  for (let i = 0; i < 50 && f.gateway.state.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.gateway.state.busy, false);
  const next = await getLease(); assert.equal(next.status, 200);
});

test('Spark speech settings never send a lease or credential to a different audio endpoint', () => {
  assert.throws(() => validateSpeech({ mode: 'spark', gatewayUrl: 'https://spark', baseUrl: 'https://other-server/speech', diarization: true }));
});
