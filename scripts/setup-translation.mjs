import { scriptLlm } from './llm-runtime.mjs';
import { dedicatedModels, hyMtTemplate } from '../server/translation-models.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
scriptLlm({ ollamaOnly: true });
const base = scriptLlm().ollamaUrl;
for (const { model, source = model, label } of dedicatedModels) {
  console.log(`Downloading ${label}: ${model}`);
  const response = await scriptLlm().fetcher(`${base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: source, stream: true }), signal: AbortSignal.timeout(3600000) });
  if (!response.ok) throw new Error(`Ollama pull failed (${response.status}): ${await response.text()}`);
  let pending = '', last = '', succeeded = false;
  const decoder = new TextDecoder();
  const consume = line => {
    if (!line.trim()) return;
    const item = JSON.parse(line); if (item.error) throw new Error(item.error);
    const status = item.total ? `${item.status}: ${Math.floor((item.completed || 0) / item.total * 10) * 10}%` : item.status;
    if (status !== last) { console.log(status); last = status; }
    if (item.status === 'success') succeeded = true;
  };
  for await (const chunk of response.body) { pending += decoder.decode(chunk, { stream: true }); const lines = pending.split('\n'); pending = lines.pop() || ''; lines.forEach(consume); }
  pending += decoder.decode(); if (pending.trim()) consume(pending);
  if (!succeeded) throw new Error(`${label}: download did not complete`);
  if (source !== model) {
    const created = await scriptLlm().fetcher(`${base}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, from: source, template: hyMtTemplate, parameters: { stop: ['<｜hy_place▁holder▁no▁2｜>', '<｜hy_place▁holder▁no▁8｜>'] }, stream: false }), signal: AbortSignal.timeout(120000) });
    const result = await created.json();
    if (!created.ok || result.error || result.status !== 'success') throw new Error(`Hy-MT2 template setup failed: ${JSON.stringify(result)}`);
    console.log('Created hy-mt2:1.8b with the official conversation template.');
  }
}
console.log('Both dedicated translation models are installed.');
