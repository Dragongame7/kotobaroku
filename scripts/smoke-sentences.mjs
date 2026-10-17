import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { LiveTranslation, detectSentenceBoundary, warmTranslation } from '../server/translation.mjs';
import { sentenceCandidates } from '../server/sentence-buffer.mjs';
import { scriptLlm } from './llm-runtime.mjs';

try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const health = await (await fetch('http://127.0.0.1:3210/api/health')).json();
assert.ok((health.llm?.ready ?? health.ollama.ready) && !health.recording && !health.translating && !health.processing, 'Stop other work before running the live sentence smoke test.');
const config = { ...scriptLlm(), ollamaUrl: scriptLlm().ollamaUrl, model: health.defaultModel, signal: AbortSignal.timeout(120000) };
await warmTranslation(config);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > 30000) throw new Error('Sentence smoke test timeout'); await pause(25); } }
const reports = [];
async function scenario(name, sourceLanguage, fragments, preview = false) {
  const events = []; let finished = false;
  const session = new LiveTranslation({ ...config, sourceLanguage, targetLanguage: sourceLanguage === 'ja-JP' ? 'en-US' : 'ja-JP', emit: event => events.push(event), drained: () => { finished = true; } });
  try {
    session.enqueue(fragments[0]);
    await pause(1150);
    assert.equal(events.some(event => event.type === 'translation.started'), false, 'Incomplete first clause must wait');
    if (preview) await until(() => events.some(event => event.type === 'translation.completed' && event.provisional));
    session.enqueue(fragments[1]);
    await until(() => events.some(event => event.type === 'translation.completed' && !event.provisional));
    session.finishInput(); await until(() => finished);
    assert.equal(events.some(event => event.type === 'translation.error'), false);
    const completed = events.filter(event => event.type === 'translation.completed');
    assert.equal(new Set(completed.map(event => event.id)).size, 1);
    const source = events.filter(event => event.type === 'translation.segment').at(-1).segment.source;
    assert.equal(source, fragments.join(sourceLanguage === 'en-US' ? ' ' : ''));
    const report = { name, source, completed, events: events.filter(event => ['translation.segment', 'translation.completed'].includes(event.type)) };
    reports.push(report); console.log(name, source, '→', completed.at(-1).text);
  } finally { session.sentences.close(); }
}
await scenario('Japanese clause spanning a pause', 'ja-JP', ['この案は良いと思いますが', '費用の面で再検討が必要です。']);
await scenario('English clause spanning a pause', 'en-US', ['The meeting starts at', 'three tomorrow.']);
await scenario('Draft replaced in place', 'ja-JP', ['明日の会議は', '午後3時からです。'], true);
const decisions = [];
for (const [sourceLanguage, source] of [['ja-JP', '昨日の売上は前月比で10パーセント増加した'], ['en-US', 'The meeting starts tomorrow at three']]) {
  const end = await detectSentenceBoundary({ ...config, sourceLanguage, snapshot: { source, candidates: sentenceCandidates(source) } });
  assert.equal(end, source.length, 'An unpunctuated complete sentence should be recognized by the local model');
  decisions.push({ sourceLanguage, source, end }); console.log('Semantic boundary:', sourceLanguage, end);
}
await mkdir('reports', { recursive: true });
await writeFile('reports/sentence-smoke.json', JSON.stringify({ createdAt: new Date().toISOString(), model: config.model, reports, decisions }, null, 2) + '\n');
console.log('Sentence grouping, draft revision and real structured boundary detection passed.');
