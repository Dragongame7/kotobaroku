import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { scriptLlm } from './llm-runtime.mjs';
import { dedicatedModels } from '../server/translation-models.mjs';
import { compareTranslations } from '../server/translation-comparison.mjs';
import { LiveTranslation } from '../server/translation.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
scriptLlm({ ollamaOnly: true });
const ollamaUrl = scriptLlm().ollamaUrl, signal = AbortSignal.timeout(600000);
const health = await (await fetch('http://127.0.0.1:3210/api/health')).json();
assert.ok(!health.recording && !health.translating && !health.processing, 'Finish other work before comparing models.');
const general = scriptLlm().model;
const models = [...dedicatedModels.map(item => item.model), general];
const items = [
  { text: '会議は明日15時に始まります。参加は必須ではありません。', sourceLanguage: 'ja-JP', targetLanguage: 'en-US' },
  { text: '田中さんは10月17日までに見積書を3部送ってください。', sourceLanguage: 'ja-JP', targetLanguage: 'en-US' },
  { text: 'この案は良いと思いますが、費用の面で再検討が必要です。', sourceLanguage: 'ja-JP', targetLanguage: 'en-US' },
  { text: 'I did not approve the payment. Please do not send it yet.', sourceLanguage: 'en-US', targetLanguage: 'ja-JP' },
  { text: 'The meeting starts tomorrow at three, unless Tanaka asks to postpone it.', sourceLanguage: 'en-US', targetLanguage: 'ja-JP' },
];
const report = { createdAt: new Date().toISOString(), context: 'none', items, results: [], sessions: [] };
const gpu = () => { try { return execFileSync('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, encoding: 'utf8' }).trim(); } catch { return null; } };
await compareTranslations({ models, items, ...scriptLlm(), ollamaUrl, signal, emit: event => {
  report.results.push({ ...event, gpuTotalAndUsedMiB: event.type === 'result' ? gpu() : undefined });
  if (event.type === 'result') console.log(event.model, event.index, `${event.result.elapsedMs}ms`, event.result.text);
  if (event.error) console.error(event.model, event.error);
} });
assert.equal(report.results.filter(event => event.type === 'result').length, models.length * items.length);
assert.equal(report.results.filter(event => event.type.includes('error')).length, 0);
for (const entry of report.results.filter(event => event.type === 'result')) {
  assert.doesNotMatch(entry.result.text, /^\s*[\[{]/, 'Plain speech samples must not turn into JSON');
  if (entry.targetLanguage === 'ja-JP') assert.match(entry.result.text, /[\u3040-\u9fff]/, 'English speech must produce Japanese');
  else assert.match(entry.result.text, /[A-Za-z]{2,}/);
}
for (const model of dedicatedModels.map(item => item.model)) {
  const events = []; let finished = false;
  // Dedicated adapters are explicit comparison tools; semantic judgment in
  // ordinary sessions belongs to the shared Gemma model.
  const live = new LiveTranslation({ ...scriptLlm(), model, boundaryMode: 'rules', ollamaUrl, signal, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', emit: event => events.push(event), drained: () => { finished = true; } });
  await live.warm();
  const ready = events.find(event => event.type === 'translation.ready');
  const residency = await (await fetch(`${ollamaUrl}/api/ps`)).json();
  const usage = gpu();
  live.enqueue('こんにちは。');
  const firstDeadline = Date.now() + 65000;
  while (!events.some(event => event.type === 'translation.completed') && Date.now() < firstDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(events.some(event => event.type === 'translation.completed'));
  live.enqueue('明日の会議は午後3時からです。'); live.finishInput();
  const deadline = Date.now() + 65000;
  while (!finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(finished); assert.ok(events.some(event => event.type === 'translation.completed'));
  assert.equal(events.some(event => event.type === 'translation.error'), false);
  assert.doesNotMatch(events.filter(event => event.type === 'translation.completed').at(-1).text, /\bhello\b/i, 'Previous source must not be translated again');
  report.sessions.push({ model, ready, residency: residency.models?.map(item => ({ name: item.name, size: item.size, size_vram: item.size_vram })), gpuTotalAndUsedMiB: usage, completed: events.filter(event => event.type === 'translation.completed') });
  console.log('Live session:', model, ready.boundaryMode, usage);
}
await mkdir('reports', { recursive: true });
await writeFile('reports/translation-models.json', JSON.stringify(report, null, 2) + '\n');
console.log('Dedicated model translation, warm-up and GPU residency smoke checks passed.');
