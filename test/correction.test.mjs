import test from 'node:test';
import assert from 'node:assert/strict';
import { correctionCandidates, applyCorrectionEdits, editsFromText, correctJapanese, correctionContext } from '../server/correction.mjs';
import { LiveTranslation } from '../server/translation.mjs';
const config = { ollamaUrl: 'http://unused', model: 'gemma4:latest', signal: new AbortController().signal };

test('dictionary finds repeated homophones at Unicode-safe source offsets and protects quoted names', async () => {
  const source = '😀選択さんは「選択」を引用し、天気がいいので選択します。';
  const candidates = await correctionCandidates(source);
  const words = candidates.filter(item => item.surface === '選択');
  assert.equal(words.length, 1); assert.equal(source.slice(words[0].start, words[0].end), '選択');
  assert.ok(words[0].alternatives.includes('洗濯'));
});

test('correction only accepts validated equal-reading noun patches and preserves every other byte', async () => {
  const source = '😀天気がいいので選択しようと思います。'; const candidates = await correctionCandidates(source);
  const corrected = source.replace('選択', '洗濯');
  const applied = await applyCorrectionEdits(source, candidates, editsFromText(source, corrected, candidates));
  assert.equal(applied.correctedSource, corrected); assert.equal(applied.edits[0].from, '選択');
  assert.throws(() => editsFromText(source, corrected.replace('思います', '思いません'), candidates), /許可/);
  const choice = candidates.find(item => item.surface === '選択');
  await assert.rejects(applyCorrectionEdits(source, candidates, { edits: [{ candidateId: choice.id, replacement: '掃除', reason: '' }] }), /読み/);
  await assert.rejects(applyCorrectionEdits(source, candidates, { edits: [{ candidateId: 999, replacement: '洗濯', reason: '' }] }), /候補/);
});

test('malformed response, changed punctuation, names, numbers and negation never replace the raw source', async () => {
  const source = '田中さんは15時に天気を確認して選択しません。';
  for (const result of [{ text: source.replace('15', '16') }, { text: source.replace('しません', 'します') }, { text: source + '追記' }, { edits: [] }]) {
    const correction = await correctJapanese({ ...config, text: source, fetcher: async () => Response.json({ message: { content: JSON.stringify(result) } }) });
    assert.equal(correction.correctedSource, source); assert.equal(correction.status, 'failed');
  }
});

test('OFF and English require no inference; failures fall back; context is bounded without feedback', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json({ message: { content: 'bad' } }); };
  for (const options of [{ mode: 'off' }, { sourceLanguage: 'en-US' }]) assert.equal((await correctJapanese({ ...config, text: '天気がいいので選択します。', fetcher, ...options })).status, 'off');
  assert.equal(requests, 0);
  assert.equal((await correctJapanese({ ...config, text: '天気がいいので選択します。', fetcher })).status, 'failed');
  assert.ok(Buffer.byteLength(correctionContext(['あ'.repeat(1000), '前の文']).join('')) <= 1200);
});

test('live session corrects before translating with one model, raw provenance and serialized requests', async t => {
  const events = [], bodies = []; let active = 0, max = 0, finished = false; const controller = new AbortController(); t.after(() => controller.abort());
  const live = new LiveTranslation({ ...config, signal: controller.signal, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', correctionMode: 'conservative', emit: event => events.push(event), drained: () => { finished = true; }, fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body); max = Math.max(max, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (body.format) return Response.json({ message: { content: JSON.stringify(body.format.properties.nearSynonym ? { nearSynonym: false } : { text: '天気がいいので洗濯しようと思います。' }) } });
    assert.match(body.messages.at(-1).content, /洗濯/);
    return new Response(JSON.stringify({ message: { content: 'I will do the laundry.' } }) + '\n' + JSON.stringify({ done: true }) + '\n');
  } });
  live.enqueue('天気がいいので選択しようと思います。'); live.finishInput();
  while (!finished) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(max, 1); assert.ok(bodies.every(body => body.model === 'gemma4:latest'));
  assert.equal(live.rows.get(1).rawSource, '天気がいいので選択しようと思います。');
  assert.equal(live.rows.get(1).translationInput.origin, 'corrected');
  assert.equal(events.find(event => event.type === 'translation.correction').correction.status, 'applied');
  const timing = events.find(event => event.type === 'translation.completed').timing;
  const stages = ['sourceReceivedAt', 'finalizedAt', 'correctionStartedAt', 'correctionFinishedAt', 'translationStartedAt', 'firstTokenAt', 'completedAt'].map(key => timing[key]);
  assert.ok(stages.every(Number.isFinite));
  assert.ok(stages.every((value, index) => !index || value >= stages[index - 1]));
});

test('a canceled or superseded correction can never start translation or overwrite raw text', async t => {
  let release, finished = false; const controller = new AbortController(); t.after(() => controller.abort());
  const events = []; const live = new LiveTranslation({ ...config, signal: controller.signal, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', correctionMode: 'conservative', emit: event => events.push(event), drained: () => { finished = true; }, fetcher: async () => new Promise(resolve => { release = () => resolve(Response.json({ message: { content: '{"text":"天気がいいので洗濯します。"}' } })); }) });
  live.enqueue('天気がいいので選択します。'); while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  live.cancel(); live.finishInput(); release(); while (!finished) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.some(event => event.type === 'translation.delta'), false);
  assert.equal(live.rows.get(1).rawSource, '天気がいいので選択します。');
});


test('a correction backlog skips extra proofreading and translates the untouched queued source', async t => {
  const controller = new AbortController(); t.after(() => controller.abort());
  let finished = false; const requests = [];
  const first = '最初の文章を確認します。', second = '天気がいいので選択します。';
  const live = new LiveTranslation({ ...config, signal: controller.signal, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', correctionMode: 'conservative', emit: () => {}, drained: () => { finished = true; }, fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.format) return Response.json({ message: { content: JSON.stringify(body.format.properties.id ? { id: 0 } : { text: first }) } });
    if (requests.filter(item => !item.format).length === 1) await new Promise(resolve => setTimeout(resolve, 1100));
    return new Response(JSON.stringify({ message: { content: 'Translation.' } }) + '\n' + JSON.stringify({ done: true }) + '\n');
  } });
  live.enqueue(first); live.enqueue(second); live.finishInput();
  while (!finished) await new Promise(resolve => setTimeout(resolve, 10));
  const queued = live.rows.get(2);
  assert.equal(queued.correction.status, 'skipped');
  assert.equal(queued.translationInput.text, second);
  assert.equal(queued.translationInput.origin, 'raw');
  assert.ok(!requests.filter(item => item.format).some(item => JSON.stringify(item.messages).includes(second)));
});
