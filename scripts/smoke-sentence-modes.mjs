import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { LiveTranslation, detectSentenceBoundary } from '../server/translation.mjs';
import { sentenceCandidates } from '../server/sentence-buffer.mjs';
import { scriptLlm } from './llm-runtime.mjs';

try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const health = await (await fetch('http://127.0.0.1:3210/api/health')).json();
assert.ok((health.llm?.ready ?? health.ollama.ready) && !health.recording && !health.processing && !health.translating, 'Stop other work before running this smoke test.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 30000) throw new Error('Sentence mode smoke timeout'); await pause(25); } }
const reports = [];
for (const [name, sourceLanguage, source, prefix, sentenceMode, boundaryMode] of [
  ['Japanese internal boundary while speaking', 'ja-JP', '本日の集計が終わりました引き続き来月の計画を相談しているので', '本日の集計が終わりました', 'balanced', 'llm'],
  ['English internal boundary while speaking', 'en-US', 'The server is running we need to check the logs because', 'The server is running', 'balanced', 'llm'],
  ['Speed mode hard deadline without a full sentence', 'ja-JP', '来月の計画については', '来月の計画については', 'speed', 'rules'],
]) {
  const controller = new AbortController(); const events = []; let done = false; let activity;
  const live = new LiveTranslation({ ...scriptLlm(), ollamaUrl: scriptLlm().ollamaUrl, model: health.translation.defaultModel, boundaryModel: health.translation.boundaryModel, sourceLanguage, targetLanguage: sourceLanguage === 'ja-JP' ? 'en-US' : 'ja-JP', sentenceMode, boundaryMode, signal: controller.signal, emit: event => events.push({ ...event, at: Date.now() }), drained: () => { done = true; } });
  try {
    await live.warm();
    if (boundaryMode === 'llm') assert.equal(live.boundaryMode, 'llm', 'Gemma semantic boundary detection must remain enabled');
    const started = Date.now(); live.enqueue(source);
    activity = setInterval(() => live.activity(), 50);
    await until(() => events.some(event => event.type === 'translation.completed' && !event.provisional));
    const first = [...live.rows.values()][0];
    assert.equal(first.source, prefix);
    assert.equal(first.boundary, boundaryMode === 'llm' ? 'sentence' : 'time');
    if (sentenceMode === 'speed') {
      const committed = events.find(event => event.type === 'translation.segment' && event.segment.boundary === 'time');
      assert.ok(committed.at - started >= 5900 && committed.at - started < 8500);
    }
    clearInterval(activity); live.finishInput(); await until(() => done);
    assert.equal(events.some(event => event.type === 'translation.error'), false);
    assert.equal([...live.rows.values()].map(row => row.source).join(''), source);
    reports.push({ name, sentenceMode, boundaryMode, source, elapsedMs: Date.now() - started, rows: [...live.rows.values()] });
    console.log(name, JSON.stringify(first.source), '→', first.translation);
  } finally { clearInterval(activity); controller.abort(); }
}
const decisions = [];
for (const [sourceLanguage, source, expected] of [
  ['ja-JP', 'この案は良いと思いますが費用の面で', ''],
  ['en-US', 'The meeting starts at', ''],
  ['en-US', 'Dr. Smith paid 3.14 dollars we will discuss the receipt because', 'Dr. Smith paid 3.14 dollars'],
]) {
  const end = await detectSentenceBoundary({ ...scriptLlm(), ollamaUrl: scriptLlm().ollamaUrl, model: health.translation.boundaryModel, sourceLanguage, snapshot: { source, candidates: sentenceCandidates(source, [], sourceLanguage) }, signal: AbortSignal.timeout(10000) });
  assert.equal(source.slice(0, end), expected);
  decisions.push({ sourceLanguage, source, end, prefix: source.slice(0, end) });
}
await mkdir('reports', { recursive: true });
await writeFile('reports/sentence-modes-smoke.json', JSON.stringify({ createdAt: new Date().toISOString(), model: health.translation.defaultModel, boundaryModel: health.translation.boundaryModel, reports, decisions }, null, 2) + '\n');
console.log('Real Ollama internal boundaries and hard deadline passed.');
