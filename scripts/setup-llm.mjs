import { scriptLlm } from './llm-runtime.mjs';
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
scriptLlm({ ollamaOnly: true });
const model = scriptLlm().model;
console.log(`通常利用のモデル ${model} を明示的に導入します。`);
const response = await scriptLlm().fetcher(`${scriptLlm().ollamaUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(3600000) });
if (!response.ok) throw new Error(`モデル導入に失敗しました (${response.status})`);
let buffer = '', succeeded = false; const decoder = new TextDecoder();
const consume = line => { if (!line.trim()) return; const event = JSON.parse(line); if (event.error) throw new Error(event.error); if (event.status === 'success') succeeded = true; if (!event.total) console.log(event.status); };
for await (const chunk of response.body) { buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(consume); }
buffer += decoder.decode(); if (buffer.trim()) consume(buffer); if (!succeeded) throw new Error('モデル導入が途中で終了しました。');
