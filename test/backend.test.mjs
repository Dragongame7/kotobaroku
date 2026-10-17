import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createApplication } from '../server/app.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, handler) {
  const mock = http.createServer(handler);
  const upstream = await listen(mock);
  const application = createApplication({ asrUrl: upstream, ollamaUrl: upstream, model: 'test:4b' });
  const base = await listen(application.server);
  t.after(async () => {
    for (const client of application.sockets.clients) client.terminate();
    application.sockets.close();
    application.server.closeAllConnections(); mock.closeAllConnections();
    await Promise.all([new Promise(resolve => application.server.close(resolve)), new Promise(resolve => mock.close(resolve))]);
  });
  return { ...application, base, mock };
}

test('health reports actual ASR readiness and installed models', async t => {
  const { base } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/ready' ? { ready: true, device: 'cuda' } : { models: [{ name: 'test:4b' }] }));
  });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.asr.ready, true); assert.equal(health.asr.device, 'cuda');
  assert.deepEqual(health.ollama.models, ['test:4b']);
});

test('LLM request preserves input and handles fragmented UTF-8 NDJSON', async t => {
  let received;
  const { base } = await fixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'application/x-ndjson');
    const stream = Buffer.from(JSON.stringify({ message: { content: '明日の会議は15時です。' } }) + '\n' + JSON.stringify({ done: true, done_reason: 'stop' }));
    res.write(stream.subarray(0, 28));
    setTimeout(() => res.end(stream.subarray(28)), 5);
  });
  const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'えっと、明日の会議は15時です。', mode: 'cleanup', model: 'test:4b' }) });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(response.status, 200); assert.equal(events[0].delta, '明日の会議は15時です。'); assert.equal(events.at(-1).done, true);
  assert.match(received.messages[1].content, /えっと、明日の会議は15時です/); assert.equal(received.think, false);
});

test('rejects invalid, overly long and cross-origin requests', async t => {
  const { base } = await fixture(t, (_req, res) => res.end('{}'));
  for (const input of [{ text: '' }, { text: 'a', mode: 'invalid' }, { text: 'あ'.repeat(4000) }, { text: 'a', model: 'bad model' }]) {
    const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(response.status, 403);
});

test('reports missing models instead of fabricating a result', async t => {
  const { base } = await fixture(t, (_req, res) => { res.writeHead(404); res.end('{"error":"model missing"}'); });
  const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(response.status, 502); assert.match((await response.json()).error, /モデル/);
});

test('flags an incomplete LLM stream', async t => {
  const { base } = await fixture(t, (_req, res) => res.end(JSON.stringify({ message: { content: '途中' } }) + '\n'));
  const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].delta, '途中'); assert.match(events.at(-1).error, /途中/);
});

test('relays PCM binary frames, final transcript and commit; locks LLM while recording', async t => {
  const { base, mock } = await fixture(t, (_req, res) => res.end('{}'));
  const upstream = new WebSocketServer({ server: mock });
  t.after(() => { for (const client of upstream.clients) client.terminate(); upstream.close(); });
  let audioBytes = 0;
  upstream.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.on('message', (data, binary) => {
      if (binary) { audioBytes += data.length; return; }
      const event = JSON.parse(data.toString());
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'テストです。' }));
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed' }));
      }
    });
  });
  const client = new WebSocket(base.replace('http:', 'ws:') + '/ws/transcribe');
  const events = [];
  const committed = new Promise((resolve, reject) => { client.on('error', reject); client.on('message', data => { const event = JSON.parse(data.toString()); events.push(event); if (event.type === 'input_audio_buffer.committed') resolve(); }); });
  await once(client, 'open');
  const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(response.status, 409);
  client.send(JSON.stringify({ type: 'session.update', session: { language: 'ja-JP', sample_rate: 16000 } }));
  client.send(Buffer.alloc(3200)); client.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  await committed;
  assert.equal(audioBytes, 3200); assert.equal(events.at(-2).transcript, 'テストです。');
  assert.equal((await (await fetch(`${base}/api/health`)).json()).recording, false);
  if (client.readyState !== WebSocket.CLOSED) { client.close(); await once(client, 'close'); }
});
