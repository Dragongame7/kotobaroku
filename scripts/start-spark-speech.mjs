import { spawn } from 'node:child_process';
import path from 'node:path';
import { findNemo, root } from './runtime.mjs';
const binary = findNemo();
if (!binary) throw new Error('node scripts/setup-spark.mjs で音声ランタイムを導入してください。');
const child = spawn(binary, ['serve', '--asr-model', 'nemotron-3.5', '--diar-model', 'nemotron-3-diarization', '--asr.diar.preset', 'v3-streaming', '--device', 'cuda', '--host', '127.0.0.1', '--port', '8081', '--no-ui', '--read-timeout', '3600', '--max-upload-mb', '1024', '--asr.streaming.rnnt_right_context', '3', '--asr.endpointing.enable=true', '--asr.batching.state_arena_slots', '2'], { cwd: root, env: { ...process.env, NEMO_SPEECH_MODEL_DIR: process.env.NEMO_SPEECH_MODEL_DIR || path.join(root, '.runtime', 'models') }, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
