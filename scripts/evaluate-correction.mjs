import { writeFile, mkdir } from 'node:fs/promises';
import { correctJapanese, correctionCandidates } from '../server/correction.mjs';
import { warmTranslation } from '../server/translation.mjs';
import { scriptLlm } from './llm-runtime.mjs';
import { modelPlacement } from '../server/llm-client.mjs';
import { correctionCases } from '../test/fixtures/correction-cases.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = { ...scriptLlm(), model: scriptLlm().model, ollamaUrl: scriptLlm().ollamaUrl, signal: AbortSignal.timeout(600000) };
const health = await (await fetch('http://127.0.0.1:3210/api/health')).json();
if (health.recording || health.processing) throw new Error('録音・処理の終了を待ってください。');
await warmTranslation(config); await correctionCandidates('準備');
const results = [];
for (const item of correctionCases) {
  const correction = await correctJapanese({ ...config, text: item.text, context: item.context || [] });
  results.push({ ...item, correction, passed: correction.correctedSource === item.expected });
  if (results.length % 20 === 0) console.log(`Evaluated ${results.length}/${correctionCases.length}`);
}
const positive = results.filter(item => item.group === 'positive');
const negative = results.filter(item => item.group === 'negative');
const timings = results.map(item => item.correction.elapsedMs).sort((a,b) => a-b);
const summary = { total: results.length, positive: { correct: positive.filter(item => item.passed).length, count: positive.length }, negative: { changed: negative.filter(item => !item.passed).length, count: negative.length }, contextPassed: results.filter(item => item.group === 'context' && item.passed).length, edgePassed: results.filter(item => item.group === 'edge' && item.passed).length, p95Ms: timings[Math.ceil(timings.length * .95) - 1] };
const gatesPassed = summary.positive.correct >= 45 && summary.negative.changed === 0 && summary.edgePassed === 20 && summary.p95Ms <= 2000;
await mkdir('reports', { recursive: true }); await writeFile('reports/correction-evaluation.json', JSON.stringify({ createdAt: new Date().toISOString(), model: config.model, residency: await modelPlacement(config), dataset: 'Synthetic authored regression cases used during implementation tuning. Prefix variants are correlated. The historical split field is not an untouched holdout; no independent human-microphone quality claim.', summary, gatesPassed, results }, null, 2));
console.log(JSON.stringify({ summary, gatesPassed, failures: results.filter(item => !item.passed).map(item => ({ id:item.id, text:item.text, expected:item.expected, actual:item.correction.correctedSource, status:item.correction.status })) }, null, 2));
if (!gatesPassed) process.exitCode = 1;
