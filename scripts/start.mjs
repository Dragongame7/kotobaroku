import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApplication } from '../server/app.mjs';
import { findNemo, reachable, root } from './runtime.mjs';
import { LlmSettings } from '../server/llm-settings.mjs';

process.chdir(root);
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const owned = new Set();
const asrUrl = process.env.ASR_URL || 'http://127.0.0.1:8081';
const llm = new LlmSettings({ file: path.join(root, '.local', 'llm-settings.json') });
const ollamaUrl = llm.current.baseUrl;
if (!existsSync(path.join(root, 'dist', 'index.html'))) { console.error('先に npm run build を実行してください。'); process.exit(1); }
function launch(command, args, label, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child);
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`));
  child.on('error', error => console.error(`[${label}] ${error.message}`));
  child.on('exit', code => { owned.delete(child); if (code) console.error(`[${label}] 終了コード ${code}`); });
  return child;
}

if (!(await reachable(`${asrUrl}/ready`))) {
  const nemo = findNemo();
  const url = new URL(asrUrl);
  if (nemo && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
    launch(nemo, ['serve', '--asr-model', process.env.ASR_MODEL || 'nemotron-3.5', '--device', process.env.ASR_DEVICE || 'cuda', '--host', '127.0.0.1', '--port', url.port || '8081', '--no-ui', '--read-timeout', '3600', '--asr.streaming.rnnt_right_context', '3', '--asr.endpointing.enable=true', '--asr.batching.state_arena_slots', '2'], '音声認識');
  } else console.warn('音声認識が未接続です。npm run setup:asr で導入してください。');
}
if (!llm.error && llm.current.provider === 'ollama' && !(await reachable(`${ollamaUrl}/api/tags`))) {
  const url = new URL(ollamaUrl);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) {
    const ollama = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : 'ollama';
    launch(ollama, ['serve'], 'Ollama', { ...process.env, OLLAMA_HOST: url.host });
  }
}
const { server, sockets, cancelProcessing } = createApplication();
const port = Number(process.env.PORT || 3210);
server.listen(port, '127.0.0.1', () => {
  console.log(`\nことば録: http://127.0.0.1:${port}\n音声認識の初期化中も画面は開けます。接続状態が「準備完了」になるまでお待ちください。\n終了: Ctrl+C\n`);
});
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  cancelProcessing();
  for (const client of sockets.clients) client.terminate();
  server.close();
  for (const child of owned) child.kill();
  setTimeout(() => process.exit(), 300).unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });
