import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApplication } from '../server/app.mjs';
import { dedicatedModels, hyMtSource, hyMtTemplate, translationCatalog, translationProfile, translationRequest } from '../server/translation-models.mjs';
import { LiveTranslation } from '../server/translation.mjs';
import { compareTranslations, validateTranslationComparison } from '../server/translation-comparison.mjs';
import { prepareTranslationMemory } from '../server/translation-memory.mjs';
const direction = { sourceLanguage: 'ja-JP', targetLanguage: 'en-US' };
const ndjson = text => new Response(JSON.stringify({ message: { content: text } }) + '\n' + JSON.stringify({ done: true }) + '\n');
async function until(predicate) { const start = Date.now(); while (!await predicate()) { if (Date.now() - start > 3000) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('dedicated profiles select native prompts and keep old context out of TranslateGemma', () => {
  const context = [{ source: '以前の文章', translation: 'Previous sentence.' }];
  const gemma = translationRequest({ ...direction, model: 'translategemma:4b', text: '現在の文章です。', context });
  assert.equal(gemma.profile, 'translategemma'); assert.equal(gemma.messages.length, 1); assert.equal(gemma.messages[0].role, 'user');
  assert.match(gemma.messages[0].content, /Japanese \(ja\) to English \(en\)/); assert.doesNotMatch(gemma.messages[0].content, /以前/); assert.equal(gemma.think, undefined);
  const hy = translationRequest({ ...direction, model: dedicatedModels[1].model, text: '現在の文章です。', context });
  assert.equal(hy.profile, 'hy-mt'); assert.equal(hy.messages.length, 1); assert.match(hy.messages[0].content, /\[Background Information\]/);
  assert.match(hy.messages[0].content, /\[Source Text\]\n現在の文章です。/); assert.equal(hy.options.temperature, 0.7);
  assert.match(hyMtTemplate, /<｜hy_User｜>{{ .Content }}/); assert.match(hyMtTemplate, /<｜hy_Assistant｜>/);
  assert.equal(translationProfile('qwen3.5:4b'), 'general');
});

test('model catalog recommends only installed models and recognizes HF names case-insensitively', () => {
  const catalog = translationCatalog(['qwen3.5:4b', dedicatedModels[1].model.toLowerCase()], 'qwen3.5:4b');
  assert.equal(catalog.defaultModel, 'qwen3.5:4b'); assert.equal(catalog.models[0].installed, false); assert.equal(catalog.models[1].installed, true);
  assert.equal(translationCatalog(['qwen3.5:4b', 'translategemma:4b']).defaultModel, 'gemma4:latest');
  assert.equal(translationCatalog([hyMtSource]).models.some(item => item.model === hyMtSource), false);
});

test('live translation shares one Gemma model for warmup, boundaries and translation', async t => {
  const requests = [], events = []; let finished = false, active = 0, maxActive = 0;
  const controller = new AbortController(); t.after(() => controller.abort());
  const live = new LiveTranslation({ ...direction, model: 'gemma4:latest', ollamaUrl: 'http://unused', signal: controller.signal, emit: event => events.push(event), drained: () => { finished = true; }, sentenceOptions: { settleMs: 10 }, fetcher: async (url, options) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: ['gemma4:latest'].map(name => ({ name, size: 100, size_vram: 100 })) });
    const body = JSON.parse(options.body); requests.push(body); maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (!body.messages.length) return Response.json({});
    if (body.format) return Response.json({ message: { content: '{"completeThrough":1}' } });
    return ndjson('All set.');
  } });
  await live.warm(); live.enqueue('確認完了'); await until(() => events.some(event => event.type === 'translation.completed'));
  live.finishInput(); await until(() => finished);
  assert.equal(maxActive, 1); assert.equal(requests.find(item => item.format).model, 'gemma4:latest');
  assert.equal(requests.find(item => item.stream).model, 'gemma4:latest');
  assert.equal(events.find(event => event.type === 'translation.segment').segment.boundaryModel, 'gemma4:latest');
});

test('CPU offload retains Gemma semantic detection and announces placement', async t => {
  const events = [], bodies = []; const controller = new AbortController(); t.after(() => controller.abort());
  const live = new LiveTranslation({ ...direction, model: 'gemma4:latest', ollamaUrl: 'http://unused', signal: controller.signal, emit: event => events.push(event), drained: () => {}, sentenceOptions: { settleMs: 5 }, fetcher: async (url, options) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'gemma4:latest', size: 100, size_vram: 40 }] });
    const body = JSON.parse(options.body); bodies.push(body); return body.messages.length ? ndjson('Done.') : Response.json({});
  } });
  await live.warm(); assert.equal(live.boundaryMode, 'llm'); assert.match(events.find(event => event.type === 'translation.ready').notice, /CPU/);
  live.enqueue('確認完了'); await new Promise(resolve => setTimeout(resolve, 20)); live.finishInput();
  await until(() => events.some(event => event.type === 'translation.finished'));
  assert.equal(bodies.some(item => item.format), true);
});

test('comparison validates bounded equal source input', () => {
  const input = { models: ['qwen3.5:4b', 'translategemma:4b'], items: [{ ...direction, text: '確認です。' }] };
  assert.equal(validateTranslationComparison(input).items.length, 1);
  assert.throws(() => validateTranslationComparison({ ...input, models: ['A', 'a'] }), /重複/);
  assert.throws(() => validateTranslationComparison({ ...input, items: Array(6).fill(input.items[0]) }), /1〜5/);
  assert.throws(() => validateTranslationComparison({ ...input, items: [{ ...direction, text: 'あ'.repeat(500) }] }), /長すぎ/);
});

test('memory preparation releases inactive candidates and a partial selected model, preserving unrelated models', async () => {
  const unloaded = [];
  await prepareTranslationMemory({ ollamaUrl: 'http://unused', model: 'qwen3.5:4b', reloadPartial: true, signal: new AbortController().signal, fetcher: async (url, options) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [
      { name: 'qwen3.5:4b', size: 100, size_vram: 40 },
      { name: 'translategemma:4b', size: 100, size_vram: 100 },
      { name: 'unrelated:7b', size: 100, size_vram: 100 },
    ] });
    unloaded.push(JSON.parse(options.body)); return Response.json({ done: true });
  } });
  assert.deepEqual(unloaded.map(item => item.model), ['qwen3.5:4b', 'translategemma:4b']);
  assert.ok(unloaded.every(item => item.keep_alive === 0));
});

test('comparison sends identical source serially, preserves model failures and continues', async () => {
  const events = [], requests = []; let active = 0, maximum = 0;
  await compareTranslations({ models: ['translategemma:4b', dedicatedModels[1].model, 'missing'], items: [{ ...direction, text: '会議は15時です。' }], ollamaUrl: 'http://unused', signal: new AbortController().signal, emit: event => events.push(event), fetcher: async (url, options) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [] });
    const body = JSON.parse(options.body); maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (body.model === 'missing') return new Response('', { status: 404 });
    if (!body.messages.length) return Response.json({});
    requests.push(body); return ndjson('The meeting is at 3 PM.');
  } });
  assert.equal(maximum, 1); assert.equal(events.filter(event => event.type === 'result').length, 2);
  assert.ok(requests.every(item => item.messages.at(-1).content.includes('会議は15時です。')));
  assert.ok(events.some(event => event.type === 'model.error' && event.model === 'missing'));
});

test('comparison cancellation stops before the next model without discarding completed results', async () => {
  const controller = new AbortController(), events = [];
  await assert.rejects(compareTranslations({ models: ['one', 'two'], items: [{ ...direction, text: '原文' }], ollamaUrl: 'http://unused', signal: controller.signal, emit: event => { events.push(event); if (event.type === 'result') controller.abort(); }, fetcher: async (url, options) => url.endsWith('/api/ps') ? Response.json({ models: [] }) : JSON.parse(options.body).messages.length ? ndjson('Text') : Response.json({}) }), /中断/);
  assert.equal(events.filter(event => event.type === 'result').length, 1); assert.equal(events.some(event => event.model === 'two'), false);
});

test('HTTP comparison locks other work, releases the lock on disconnect, and reports installed profiles', async t => {
  let started = 0;
  const mock = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/chat') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (!body.messages.length) { res.end('{}'); return; }
      started++;
      setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ message: { content: 'Translation.' } }) + '\n' + JSON.stringify({ done: true }) + '\n'); }, 60);
      return;
    }
    res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'translategemma:4b' }, { name: 'qwen3.5:4b' }] } : { ready: true, models: [] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const app = createApplication({ asrUrl: upstream, ollamaUrl: upstream });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.cancelProcessing(); app.sockets.close(); app.server.closeAllConnections(); mock.closeAllConnections(); await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => mock.close(resolve))]); });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.translation.defaultModel, 'gemma4:latest');
  const input = { models: ['translategemma:4b', 'qwen3.5:4b'], items: [{ ...direction, text: '会議は15時です。' }] };
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) };
  const controller = new AbortController();
  const response = await fetch(`${base}/api/translate/compare`, { ...options, signal: controller.signal });
  await until(() => started > 0);
  const blocked = await fetch(`${base}/api/translate/compare`, options); assert.equal(blocked.status, 409);
  controller.abort(); await assert.rejects(response.text());
  await until(async () => !(await (await fetch(`${base}/api/health`)).json()).processing);
  const retry = await fetch(`${base}/api/translate/compare`, options); assert.equal(retry.status, 200);
  const events = (await retry.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.type === 'result').length, 2); assert.equal(events.at(-1).type, 'done');
});
