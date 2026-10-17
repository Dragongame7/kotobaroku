import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { detectSentenceBoundary } from '../server/translation.mjs';
import { sentenceCandidates } from '../server/sentence-buffer.mjs';
import { scriptLlm } from './llm-runtime.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = 'http://127.0.0.1:3210';
const health = await (await fetch(base + '/api/health')).json();
assert.ok(!health.recording && !health.processing);
assert.equal(health.defaultModel, 'gemma4:latest'); assert.equal(health.translation.defaultModel, health.defaultModel);
const results = [];
for (const [sourceLanguage, targetLanguage, text, correctionMode] of [
  ['ja-JP', 'en-US', '天気がいいので選択しようと思います。', 'conservative'],
  ['ja-JP', 'en-US', '天気がいいので選択しようと思います', 'conservative'],
  ['ja-JP', 'en-US', '候補から会場を選択しようと思います。', 'conservative'],
  ['en-US', 'ja-JP', 'The meeting starts tomorrow at three. Please do not send the invoice yet.', 'conservative'],
  ['ja-JP', 'en-US', '天気がいいので選択しようと思います。', 'off'],
]) {
  const response = await fetch(base + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceLanguage, targetLanguage, text, correctionMode, model: health.defaultModel }) });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.ok(response.ok && !events.some(event => event.error)); const final = events.find(event => event.done); assert.ok(final?.text); assert.equal(final.model, health.defaultModel);
  if (sourceLanguage === 'ja-JP' && text.startsWith('天気') && correctionMode !== 'off') { assert.equal(final.correction.status, 'applied'); assert.match(final.translationInput.text, /洗濯/); assert.match(final.text, /laundry|wash/i); }
  else assert.equal(final.translationInput.text, text);
  if (targetLanguage === 'ja-JP') assert.match(final.text, /[ぁ-龠]/u);
  results.push({ text, sourceLanguage, targetLanguage, events }); console.log(text, '→', final.text);
}
const boundaries = [];
for (const [sourceLanguage, source, prefix] of [['ja-JP', '本日の集計が終わりました引き続き来月の計画を相談しているので', '本日の集計が終わりました'], ['en-US', 'The server is running we need to check the logs because', 'The server is running']]) {
  const end = await detectSentenceBoundary({ ...scriptLlm(), model: health.defaultModel, ollamaUrl: scriptLlm().ollamaUrl, sourceLanguage, snapshot: { source, candidates: sentenceCandidates(source, [], sourceLanguage) }, signal: AbortSignal.timeout(10000) });
  boundaries.push({ sourceLanguage, source, end, prefix: source.slice(0, end) }); assert.equal(source.slice(0, end), prefix);
}
await mkdir('reports', { recursive: true }); await writeFile('reports/gemma-smoke.json', JSON.stringify({ createdAt: new Date().toISOString(), model: health.defaultModel, results, boundaries }, null, 2));
console.log('Gemma corrections, raw fallback, both translation directions and sentence boundaries passed.');
