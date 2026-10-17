import test from 'node:test';
import assert from 'node:assert/strict';
import { SentenceBuffer, SENTENCE_MODES, sentenceCandidates, sentenceState } from '../server/sentence-buffer.mjs';
import { detectSentenceBoundary, LiveTranslation } from '../server/translation.mjs';

const direction = { sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 3000) throw new Error('Timed out'); await pause(5); } }
const ndjson = text => new Response(JSON.stringify({ message: { content: text } }) + '\n' + JSON.stringify({ done: true }) + '\n');
function buffer(t, options = {}) {
  const updates = [], commits = [], checks = [];
  const assembler = new SentenceBuffer({ language: 'ja-JP', settleMs: 10, previewMs: 80, update: item => updates.push(item), commit: item => commits.push(item), check: item => checks.push(item), ...options });
  t.after(() => assembler.close());
  return { assembler, updates, commits, checks };
}

test('sentence rules keep conjunctions open and avoid English abbreviation / decimal boundaries', () => {
  assert.equal(sentenceState('この案は良いと思いますが。', 'ja-JP'), 'continuation');
  assert.equal(sentenceState('費用の面で再検討が必要です', 'ja-JP'), 'complete');
  assert.equal(sentenceState('こんにちは', 'ja-JP'), 'complete');
  assert.equal(sentenceState('I like it but.', 'en-US'), 'continuation');
  assert.equal(sentenceState('If it rains.', 'en-US'), 'unknown');
  const text = 'Dr. Smith paid 3.14 dollars. Next';
  assert.deepEqual(sentenceCandidates(text).map(item => item.text), ['Dr. Smith paid 3.14 dollars.', text]);
});

test('a pause inside a Japanese clause does not translate or lose the source', async t => {
  const { assembler, commits, updates } = buffer(t);
  assembler.push('この案は良いと思いますが');
  await pause(25); assert.equal(commits.length, 0);
  assembler.push('費用の面で再検討が必要です。');
  await until(() => commits.length === 1);
  assert.equal(commits[0].source, 'この案は良いと思いますが費用の面で再検討が必要です。');
  assert.equal(commits[0].provisional, false);
  assert.equal(updates[0].id, commits[0].id);
  assert.deepEqual(commits[0].sourceParts.map(part => part.utteranceId), [1, 2]);
});

test('a full stop commits immediately without waiting for silence or semantic classification', t => {
  const { assembler, commits, checks } = buffer(t, { settleMs: 60000 });
  assembler.push('一つ目です。二つ目です。次の予定は');
  assert.deepEqual(commits.map(item => item.source), ['一つ目です。', '二つ目です。']);
  assert.equal(assembler.source(), '次の予定は');
  assert.equal(checks.length, 0);
});

test('an explicit full stop takes priority over a dangling conjunction and later activity', t => {
  const { assembler, commits } = buffer(t);
  assembler.push('この案は良いと思いますが。'); assembler.activity();
  assert.equal(commits.length, 1); assert.equal(assembler.pending, false);
  assembler.push('ただし費用の再検討が必要です。');
  assert.equal(commits.length, 2); assert.notEqual(commits[0].id, commits[1].id);
});

test('complete sentence prefixes are committed and the trailing clause stays buffered', async t => {
  const { assembler, commits } = buffer(t);
  assembler.push('明日は晴れです。次の予定は');
  await until(() => commits.length === 1);
  assert.equal(commits[0].source, '明日は晴れです。');
  assert.equal(assembler.source(), '次の予定は');
  assembler.push('午後3時からです。'); assembler.flush();
  assert.deepEqual(commits.map(item => item.source), ['明日は晴れです。', '次の予定は午後3時からです。']);
  assert.notEqual(commits[0].id, commits[1].id);
});

test('English ASR fragments keep word spacing and short answers remain separate', async t => {
  const { assembler, commits } = buffer(t, { language: 'en-US' });
  assembler.push('The meeting starts at'); await pause(25);
  assert.equal(commits.length, 0);
  assembler.push('three tomorrow. Yes.'); assembler.flush();
  assert.deepEqual(commits.map(item => item.source.trim()), ['The meeting starts at three tomorrow.', 'Yes.']);
});

test('a new finalized fragment releases earlier sentences without waiting for the next pause', t => {
  const { assembler, commits } = buffer(t);
  assembler.push('こんにちは'); assembler.push('次の予定は');
  assert.equal(commits.length, 1); assert.equal(commits[0].source, 'こんにちは');
  assert.equal(assembler.source(), '次の予定は');
});

test('a continuation at the start of the next ASR fragment attaches to the prior sentence', t => {
  const { assembler, commits } = buffer(t);
  assembler.push('良い案だと思います'); assembler.push('が、費用の再検討が必要です。'); assembler.flush();
  assert.deepEqual(commits.map(item => item.source), ['良い案だと思いますが、費用の再検討が必要です。']);
});

test('new ASR activity extends the short lookahead without suppressing the preview deadline', async t => {
  const { assembler, commits } = buffer(t, { settleMs: 100, previewMs: 40 });
  assembler.push('明日の会議は');
  for (let i = 0; i < 5; i++) { await pause(10); assembler.activity(); }
  assert.equal(commits.length, 1); assert.equal(commits[0].provisional, true);
});

test('preview, continuation and final result use one ID with increasing revisions', async t => {
  const { assembler, commits } = buffer(t, { previewMs: 30 });
  assembler.push('明日の会議は'); await until(() => commits.length === 1);
  assert.equal(commits[0].provisional, true);
  assembler.push('午後3時からで'); await until(() => commits.length === 2);
  assembler.push('場所は第二会議室です。'); await until(() => commits.length === 3);
  assert.deepEqual(commits.map(item => item.id), [1, 1, 1]);
  assert.deepEqual(commits.map(item => item.provisional), [true, true, false]);
  assert.ok(commits[0].revision < commits[1].revision && commits[1].revision < commits[2].revision);
});

test('oversized Unicode input splits at safe boundaries and preserves all source parts', t => {
  const { assembler, commits } = buffer(t);
  const source = ('😀長い文章、').repeat(180) + '終了です。';
  assembler.push(source); assembler.flush();
  assert.equal(commits.map(item => item.source).join(''), source);
  assert.ok(commits.every(item => Buffer.byteLength(item.source) <= 1200));
  assert.ok(commits.every(item => item.sourceParts.map(part => part.text).join('') === item.source));
  assert.ok(commits.some(item => item.boundary === 'length'));
  assert.ok(commits.every(item => [...item.source].length <= 150));
});

test('boundary decisions use a schema, reject invalid IDs and ignore stale snapshots', async t => {
  const { assembler, commits, checks } = buffer(t);
  assembler.push('すべて準備完了'); await until(() => checks.length === 1);
  const snapshot = checks[0]; let request;
  const end = await detectSentenceBoundary({ ...direction, snapshot, ollamaUrl: 'http://unused', signal: new AbortController().signal, fetcher: async (_url, options) => {
    request = JSON.parse(options.body); return Response.json({ message: { content: '{"completeThrough":1}' } });
  } });
  assert.equal(end, snapshot.source.length); assert.equal(request.stream, false); assert.equal(request.format.type, 'object');
  assembler.push('とのことです'); assembler.resolve(snapshot, end);
  assert.equal(commits.length, 0); assembler.flush();
  assert.equal(commits[0].source, 'すべて準備完了とのことです');
  await assert.rejects(detectSentenceBoundary({ ...direction, snapshot, ollamaUrl: 'http://unused', signal: new AbortController().signal, fetcher: async () => Response.json({ message: { content: '{"completeThrough":999}' } }) }), /形式/);
});

function session(t, fetcher, sentenceOptions = {}) {
  const events = []; let finished = false; const controller = new AbortController();
  const live = new LiveTranslation({ ...direction, ollamaUrl: 'http://unused', signal: controller.signal, emit: event => events.push(event), drained: () => { finished = true; }, fetcher, sentenceOptions: { settleMs: 10, previewMs: 45, ...sentenceOptions } });
  t.after(() => controller.abort());
  return { live, events, done: () => finished };
}

test('LLM chooses ambiguous boundaries and its failure falls back to a preview and stop flush', async t => {
  let calls = 0; const { live, events, done } = session(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.format) { calls++; return Response.json({ message: { content: 'invalid output' } }); }
    return ndjson('Translation.');
  });
  live.enqueue('確認完了');
  await until(() => events.some(event => event.type === 'translation.completed' && event.provisional));
  assert.equal(calls, 1); assert.equal(live.history.length, 0);
  live.finishInput(); await until(done);
  assert.equal(events.filter(event => event.type === 'translation.completed').at(-1).provisional, false);
  assert.equal(live.history.length, 1);
});

test('valid semantic boundary can commit an unpunctuated sentence before stop', async t => {
  const { live, events, done } = session(t, async (_url, options) => JSON.parse(options.body).format
    ? Response.json({ message: { content: '{"completeThrough":1}' } }) : ndjson('All set.'));
  live.enqueue('準備完了');
  await until(() => events.some(event => event.type === 'translation.completed' && !event.provisional));
  assert.equal(done(), false); live.finishInput(); await until(done);
});

test('late translations from older revisions never replace the updated source or enter context', async t => {
  let release, calls = 0;
  const { live, events, done } = session(t, async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = () => resolve(ndjson('Outdated draft.')); });
    return ndjson('The meeting starts at three.');
  });
  live.enqueue('明日の会議は'); await until(() => release);
  live.enqueue('午後3時からです。'); live.finishInput(); release(); await until(done);
  assert.equal(events.some(event => event.type === 'translation.delta' && event.delta.includes('Outdated')), false);
  const completed = events.filter(event => event.type === 'translation.completed');
  assert.equal(completed.length, 1); assert.equal(completed[0].id, 1);
  assert.equal(live.history[0].source, '明日の会議は午後3時からです。');
});

test('cancel preserves a draft and pending originals, cancels timers, and keeps later originals', async t => {
  const { live, events, done } = session(t, async () => ndjson('Draft.'));
  live.enqueue('明日の予定は'); await until(() => events.some(event => event.type === 'translation.completed'));
  live.cancel(); live.enqueue('中断後も残す'); live.enqueue('さらに残す'); live.finishInput(); await until(done);
  const latest = new Map(events.filter(event => event.type === 'translation.segment').map(event => [event.segment.id, event.segment]));
  assert.equal(latest.size, 3);
  assert.ok([...latest.values()].every(row => row.status === 'canceled'));
  assert.equal(latest.get(1).translation, 'Draft.');
});

test('queue overflow keeps every sentence available for retry', async t => {
  let release;
  const { live, events, done } = session(t, async () => new Promise(resolve => { release = () => resolve(ndjson('Done.')); }));
  live.enqueue('最初です。'); await until(() => release);
  live.enqueue('次です。'.repeat(40)); live.sentences.settle();
  assert.ok(events.some(event => event.type === 'translation.error' && /増えています/.test(event.error)));
  live.cancel(); release(); live.finishInput(); await until(done);
  const rows = new Map(events.filter(event => event.type === 'translation.segment').map(event => [event.segment.id, event.segment]));
  assert.equal([...rows.values()].map(row => row.source).join(''), '最初です。' + '次です。'.repeat(40));
});

test('all sentence modes enforce Unicode character ceilings and preserve the exact source', t => {
  for (const [sentenceMode, limits] of Object.entries(SENTENCE_MODES)) {
    const { assembler, commits } = buffer(t, { sentenceMode });
    const source = '😀句点なしの長い原文'.repeat(44);
    assembler.push(source); assembler.flush();
    assert.equal(commits.map(item => item.source).join(''), source);
    assert.ok(commits.every(item => [...item.source].length <= limits.maxChars));
    assert.ok(commits.some(item => item.boundary === 'length'));
    assert.ok(commits.every(item => !/[\uD800-\uDBFF]$/u.test(item.source)));
    assert.ok(commits.every(item => item.sourceParts.map(part => part.text).join('') === item.source));
  }
});

test('periodic semantic checks continue during ASR activity and skip unchanged source', async t => {
  const { assembler, checks } = buffer(t, { settleMs: 1000, previewMs: 1000, checkMs: 20 });
  assembler.push('昨日の売上が増加した');
  for (let i = 0; i < 6; i++) { assembler.activity(); await pause(10); }
  assert.equal(checks.length, 1);
  assembler.push('次の数値を確認中');
  for (let i = 0; i < 6; i++) { assembler.activity(); await pause(10); }
  assert.equal(checks.length, 2);
});

test('soft character threshold requests judgment without waiting for a pause', t => {
  const { assembler, checks } = buffer(t, { settleMs: 1000, softChars: 12 });
  assembler.push('この長い原文には句点がなく判定が必要');
  assert.equal(checks.length, 1);
});

test('hard deadline cuts even a dangling clause during continuous activity or stalled judgment', async t => {
  const { assembler, commits } = buffer(t, { settleMs: 1000, previewMs: 1000, checkMs: 10, maxWaitMs: 70 });
  assembler.push('これから検討する予定ですが');
  for (let i = 0; i < 4; i++) { await pause(10); assembler.activity(); }
  assembler.push('予算が未確定なので');
  await until(() => commits.some(item => !item.provisional));
  assembler.flush();
  assert.ok(commits.some(item => item.boundary === 'time'));
  assert.equal(commits.filter(item => !item.provisional).map(item => item.source).join(''), 'これから検討する予定ですが予算が未確定なので');
  assert.equal(assembler.checkTimer, null); assert.equal(assembler.limitTimer, null);
});

test('one ASR fragment offers internal Japanese and English boundaries without rewriting', async t => {
  for (const [language, source, prefix] of [
    ['ja-JP', '最初の確認は完了しました次に費用を検討する予定ですが', '最初の確認は完了しました'],
    ['en-US', 'The report is ready we will review the budget tomorrow', 'The report is ready'],
  ]) {
    const { assembler, checks, commits } = buffer(t, { language });
    assembler.push(source); await until(() => checks.length > 0);
    const snapshot = checks[0];
    assert.ok(snapshot.candidates.some(item => item.end === prefix.length));
    assembler.resolve(snapshot, prefix.length);
    assert.equal(commits[0].source, prefix);
    assembler.flush();
    assert.equal(commits.filter(item => !item.provisional).map(item => item.source).join(''), source);
  }
});

test('boundary inference survives appended source but rejects a new group or dependent continuation', async t => {
  let release, boundarySignal;
  const { live, events, done } = session(t, async (_url, options) => {
    if (JSON.parse(options.body).format) { boundarySignal = options.signal; return new Promise(resolve => { release = () => resolve(Response.json({ message: { content: '{"completeThrough":1}' } })); }); }
    return ndjson('Ready.');
  }, { previewMs: 1000 });
  live.enqueue('準備完了'); await until(() => release);
  const snapshot = live.sentences.snapshot();
  live.enqueue('次の確認項目は');
  assert.equal(boundarySignal.aborted, false);
  release(); await until(() => events.some(event => event.type === 'translation.completed'));
  assert.equal(live.rows.get(1).source, '準備完了');
  assert.equal(live.sentences.accepts(snapshot), false);
  live.finishInput(); await until(done);
});

test('long English candidate lists retain the final position and schema stays bounded', async () => {
  const source = 'people '.repeat(60) + 'ready'; let request;
  const end = await detectSentenceBoundary({ ...direction, sourceLanguage: 'en-US', snapshot: { source, candidates: sentenceCandidates(source, [], 'en-US') }, ollamaUrl: 'http://unused', signal: new AbortController().signal, fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ message: { content: JSON.stringify({ completeThrough: request.format.properties.completeThrough.enum.at(-1) }) } });
  } });
  assert.ok(request.format.properties.completeThrough.enum.length <= 25);
  const payload = JSON.parse(request.messages[1].content);
  assert.ok(payload.candidates.reduce((total, item) => total + Buffer.byteLength(item.prefix + item.following), 0) <= 6000);
  assert.equal(end, source.length);
});

test('closing or canceling clears periodic and hard limit timers', async t => {
  const { assembler, checks, commits } = buffer(t, { checkMs: 20, maxWaitMs: 30 });
  assembler.push('続く原文は'); assembler.close(); await pause(60);
  assert.equal(commits.length, 0); assert.equal(checks.length, 0);
  for (const name of ['settleTimer', 'previewTimer', 'checkTimer', 'limitTimer']) assert.equal(assembler[name], null);
});

test('English semantic requests prioritize clause transitions and retain numbers and abbreviations', async () => {
  const source = 'Dr. Smith paid 3.14 dollars we will discuss the receipt because'; let request;
  const end = await detectSentenceBoundary({ ...direction, sourceLanguage: 'en-US', snapshot: { source, candidates: sentenceCandidates(source, [], 'en-US') }, ollamaUrl: 'http://unused', signal: new AbortController().signal, fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ message: { content: '{"completeThrough":1}' } });
  } });
  const candidates = JSON.parse(request.messages[1].content).candidates;
  assert.deepEqual(candidates, [{ id: 1, prefix: 'Dr. Smith paid 3.14 dollars', following: ' we will discuss the receipt because' }]);
  assert.equal(source.slice(0, end), candidates[0].prefix);
});
