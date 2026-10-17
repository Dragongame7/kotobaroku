import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { LlmSettings, environmentConnection, validateConnection } from '../server/llm-settings.mjs';
import { createLlmTransport } from '../server/llm-transport.mjs';
import { createApplication } from '../server/app.mjs';
import { structuredChat } from '../server/llm-client.mjs';
import { detectSentenceBoundary, translateText } from '../server/translation.mjs';

const candidate = { provider: 'openai', baseUrl: 'http://example.invalid/proxy/v1/', model: 'served-model' };
const output = text => ({ choices: [{ index: 0, message: { content: text }, finish_reason: 'stop' }] });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function sse(text, { incomplete = false, length = false } = {}) {
  const value = ': heartbeat\r\n\r\n' + [{ choices: [{ index: 0, delta: { reasoning_content: 'IGNORE' } }] }, { choices: [{ index: 0, delta: { content: text } }] }, ...(!incomplete ? [{ choices: [{ index: 0, delta: {}, finish_reason: length ? 'length' : 'stop' }] }] : [])].map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join('') + (incomplete ? '' : 'data: [DONE]\r\n\r\n');
  const bytes = new TextEncoder().encode(value); let cursor = 0;
  return new Response(new ReadableStream({ pull(controller) { if (cursor === bytes.length) return controller.close(); const next = Math.min(cursor + 7, bytes.length); controller.enqueue(bytes.slice(cursor, next)); cursor = next; } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function provider() {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const body = options.body && JSON.parse(options.body); calls.push({ url, body, authorization: new Headers(options.headers).get('authorization') });
    if (url.endsWith('/models')) return json({ data: [{ id: 'served-model' }] });
    assert.ok(url.endsWith('/chat/completions'), url);
    assert.equal(body.model, 'served-model');
    for (const key of ['options', 'format', 'think', 'keep_alive']) assert.ok(!(key in body));
    const properties = body.response_format?.json_schema.schema.properties;
    const text = properties ? JSON.stringify(properties.ok ? { ok: true } : properties.completeThrough ? { completeThrough: 0 } : properties.nearSynonym ? { nearSynonym: false } : properties.id ? { id: 0 } : { text: '天気がいいので洗濯しようと思います。' }) : body.messages.some(item => item.content?.includes('Japanese into English')) ? 'Laundry.' : '確認しました。';
    return body.stream ? sse(text) : json(output(text));
  };
  return { fetcher, calls };
}
function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-llm-test-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
const draft = (settings, changes = {}) => ({ ...candidate, revision: settings.revision, apiKeyAction: 'clear', ...changes });

test('connection validation preserves prefixes and rejects credentials, query, schemes and incomplete env', () => {
  assert.equal(validateConnection(candidate).baseUrl, 'http://example.invalid/proxy/v1');
  for (const baseUrl of ['file:///temp/x', 'http://user:pass@host/v1', 'http://host/v1?key=x', 'http://host/v1#x', 'http://host/v1/chat/completions']) assert.throws(() => validateConnection({ ...candidate, baseUrl }));
  assert.throws(() => environmentConnection({ LLM_PROVIDER: 'openai' }), /一組/);
  assert.equal(environmentConnection({ LLM_PROVIDER: 'openai', LLM_BASE_URL: candidate.baseUrl, LLM_MODEL: candidate.model }).provider, 'openai');
  assert.equal(environmentConnection({ OLLAMA_URL: 'http://localhost:1234', OLLAMA_MODEL: 'legacy-model' }).model, 'legacy-model');
});

test('authenticated Ollama uses the same transport and does not echo its key', async () => {
  const fetcher = createLlmTransport({ provider: 'ollama', apiKey: 'private-value' }, async (_url, options) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer private-value');
    return json({ error: 'private-value' });
  });
  const response = await fetcher('http://localhost/api/chat');
  assert.ok(!(await response.text()).includes('private-value'));
});

test('vLLM chat, JSON and fragmented SSE normalize without Ollama-only options or reasoning', async () => {
  const mock = provider(), fetcher = createLlmTransport({ ...candidate, baseUrl: candidate.baseUrl.slice(0, -1), apiKey: 'test-secret' }, mock.fetcher);
  const result = await translateText({ ollamaUrl: candidate.baseUrl.slice(0, -1), model: candidate.model, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', text: '洗濯します。', signal: new AbortController().signal, fetcher });
  assert.equal(result.text, 'Laundry.');
  const decision = await structuredChat({ ollamaUrl: candidate.baseUrl.slice(0, -1), model: candidate.model, messages: [{ role: 'user', content: 'test' }], format: { type: 'object', properties: { ok: { type: 'boolean' } } }, signal: new AbortController().signal, fetcher });
  assert.equal(decision.ok, true);
  assert.ok(mock.calls.every(call => call.authorization === 'Bearer test-secret'));
  assert.ok(mock.calls.every(call => call.url === 'http://example.invalid/proxy/v1/chat/completions'));
});

for (const mode of ['incomplete', 'length', 'unauthorized']) test(`vLLM ${mode} keeps received text and cannot masquerade as completion`, async () => {
  const fetcher = createLlmTransport(candidate, async () => mode === 'unauthorized' ? new Response('echo-secret', { status: 401 }) : sse('途中の訳文', { [mode]: true }));
  const response = await fetcher(`${candidate.baseUrl}/api/chat`, { body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'text' }] }) });
  const text = await response.text();
  if (mode === 'unauthorized') { assert.equal(response.status, 401); assert.ok(!text.includes('echo-secret')); assert.match(text, /認証/); }
  else { assert.match(text, /途中の訳文/); assert.match(text, /error/); assert.ok(!text.includes('"done":true')); }
});

test('configuration applies only an exact tested draft; secrets, recovery, endpoint and revision rules persist', async t => {
  const mock = provider(), file = path.join(directory(t), 'settings', 'llm.json');
  const settings = new LlmSettings({ file, initial: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'old-model' }, fetcher: mock.fetcher });
  const input = draft(settings, { apiKeyAction: 'replace', apiKey: 'test-secret' });
  assert.throws(() => settings.save(input), /テスト/);
  const proof = await settings.test(input, AbortSignal.timeout(3000));
  assert.equal(settings.public().model, 'old-model'); assert.equal(fs.existsSync(file), false);
  assert.throws(() => settings.save({ ...input, model: 'changed', token: proof.token }), /テスト/);
  settings.save({ ...input, token: proof.token });
  assert.equal(settings.public().hasApiKey, true); assert.ok(!JSON.stringify(settings.public()).includes('test-secret'));
  const restored = new LlmSettings({ file, initial: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'ignored' } });
  assert.equal(restored.public().model, 'served-model'); assert.equal(restored.current.apiKey, 'test-secret');
  assert.throws(() => settings.draft({ ...input, revision: settings.revision, apiKeyAction: 'keep', baseUrl: 'http://other.invalid/v1' }), /キー/);
  assert.throws(() => settings.save({ ...input, token: proof.token }), /更新/);
  fs.writeFileSync(file, '{broken'); const corrupt = new LlmSettings({ file }); assert.match(corrupt.public().error, /読み込めません/);
  await assert.rejects(corrupt.transport()('http://localhost/api/tags'), /設定/);
});

test('save failure does not change the applied connection; models list is optional and authentication can be cleared', async t => {
  const mock = provider(), dir = directory(t), blocked = path.join(dir, 'not-a-directory'); fs.writeFileSync(blocked, 'x');
  const settings = new LlmSettings({ file: path.join(blocked, 'llm.json'), initial: { ...candidate, apiKey: 'old-secret' }, fetcher: async (url, options) => url.endsWith('/models') ? new Response('not available', { status: 405 }) : mock.fetcher(url, options) });
  const input = draft(settings);
  await assert.rejects(settings.models(input, AbortSignal.timeout(3000)));
  const proof = await settings.test(input, AbortSignal.timeout(3000));
  assert.throws(() => settings.save({ ...input, token: proof.token }), /保存できません/);
  assert.equal(settings.current.apiKey, 'old-secret');
  assert.equal(settings.draft(input).apiKey, '');
});

test('a pending connection test locks other work and aborting it releases the lock without applying settings', async t => {
  const temporary = directory(t); let started = false, canceled = false;
  const app = createApplication({ settingsPath: path.join(temporary, 'llm.json'), asrUrl: 'http://127.0.0.1:1', llm: candidate, fetcher: async (url, options) => {
    if (url.endsWith('/models')) return json({ data: [{ id: 'served-model' }] });
    started = true;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { canceled = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.cancelProcessing(); app.sockets.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const current = await (await fetch(base + '/api/llm/settings')).json();
  const controller = new AbortController();
  const pending = fetch(base + '/api/llm/settings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ ...current, apiKeyAction: 'clear' }) }).catch(error => error);
  await until(() => started);
  const blocked = await fetch(base + '/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'blocked' }) });
  assert.equal(blocked.status, 409);
  controller.abort(); await pending; await until(() => canceled);
  let unlocked = false;
  for (let i = 0; i < 30; i++) { unlocked = !(await (await fetch(base + '/api/health')).json()).processing; if (unlocked) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(unlocked, true);
  assert.equal(fs.existsSync(path.join(temporary, 'llm.json')), false);
  assert.equal((await (await fetch(base + '/api/llm/settings')).json()).revision, current.revision);
});

async function until(predicate) { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } }
test('settings API, all inference paths, live revisions and server locks share the selected external model', async t => {
  const mock = provider(), temporary = directory(t);
  const asrServer = http.createServer((_req, res) => res.end('{"ready":true}'));
  asrServer.listen(0, '127.0.0.1'); await once(asrServer, 'listening');
  const asr = new WebSocketServer({ server: asrServer });
  asr.on('connection', socket => { socket.send('{"type":"session.created"}'); socket.on('message', (data, binary) => {
    if (binary) { socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '天気がいいので選択しようと思います。' })); return; }
    const event = JSON.parse(data.toString());
    if (event.type === 'session.update') socket.send('{"type":"session.updated"}');
    if (event.type === 'input_audio_buffer.commit') socket.send('{"type":"input_audio_buffer.committed"}');
  }); });
  const app = createApplication({ settingsPath: path.join(temporary, 'private', 'llm.json'), asrUrl: `http://127.0.0.1:${asrServer.address().port}`, llm: { ...candidate, apiKey: 'test-secret' }, fetcher: mock.fetcher });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.cancelProcessing(); for (const socket of [...app.sockets.clients, ...asr.clients]) socket.terminate(); app.sockets.close(); asr.close(); app.server.closeAllConnections(); asrServer.closeAllConnections(); await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => asrServer.close(resolve))]); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const current = await (await fetch(base + '/api/llm/settings')).json();
  assert.equal(current.hasApiKey, true); assert.ok(!JSON.stringify(current).includes('test-secret'));
  const input = { ...current, apiKeyAction: 'keep' };
  const proofResponse = await post('/api/llm/settings/test', input); assert.equal(proofResponse.status, 200);
  const proof = await proofResponse.json();
  assert.equal((await post('/api/llm/settings/save', { ...input, token: proof.token })).status, 200);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.llm.ready, true); assert.equal(health.ollama.ready, false); assert.equal(health.translation.comparisonSupported, false); assert.ok(!JSON.stringify(health).includes('test-secret'));
  assert.equal((await post('/api/translate/compare', {})).status, 400);
  for (const mode of ['cleanup', 'summary']) { const response = await post('/api/process', { text: '原文です', mode }); assert.match(await response.text(), /確認しました/); }
  const corrected = await (await post('/api/correct', { text: '天気がいいので選択しようと思います。' })).text();
  assert.match(corrected, /洗濯/); assert.match(corrected, /選択/);
  const translated = await (await post('/api/translate', { text: '天気がいいので選択しようと思います。', sourceLanguage: 'ja-JP', targetLanguage: 'en-US' })).text();
  assert.match(translated, /Laundry/); assert.match(translated, /"provider":"openai"/);
  const client = new WebSocket(base.replace('http:', 'ws:') + '/ws/translate'), events = [];
  client.on('message', data => { const event = JSON.parse(data); events.push(event); if (event.type === 'session.created') client.send(JSON.stringify({ type: 'session.update', session: { language: 'ja-JP', sample_rate: 16000 }, translation: { model: 'served-model', targetLanguage: 'en-US' } })); });
  await until(() => events.some(event => event.type === 'session.updated'));
  const fresh = await (await fetch(base + '/api/llm/settings')).json();
  assert.equal((await post('/api/llm/settings/test', { ...fresh, apiKeyAction: 'keep' })).status, 409);
  assert.equal((await post('/api/llm/settings/save', { ...fresh, apiKeyAction: 'keep', token: proof.token })).status, 409);
  client.send(Buffer.alloc(3200)); await until(() => events.some(event => event.type === 'translation.completed'));
  assert.equal(events.find(event => event.type === 'translation.segment').segment.llm.provider, 'openai');
  client.send('{"type":"input_audio_buffer.commit"}'); await until(() => events.some(event => event.type === 'translation.finished'));
  const boundary = await detectSentenceBoundary({ ollamaUrl: candidate.baseUrl.slice(0, -1), model: 'served-model', sourceLanguage: 'en-US', snapshot: { source: 'Report ready', candidates: [{ end: 12, text: 'Report ready' }] }, signal: AbortSignal.timeout(3000), fetcher: createLlmTransport({ ...candidate, baseUrl: candidate.baseUrl.slice(0, -1) }, mock.fetcher) });
  assert.equal(boundary, 0);
  assert.ok(mock.calls.every(call => !/api\/(chat|ps|generate)/.test(call.url)));
});
