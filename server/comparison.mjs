import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { root } from '../scripts/runtime.mjs';

function findExecutable(directory) {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'whisper-cli.exe') return file;
    if (entry.isDirectory()) { const found = findExecutable(file); if (found) return found; }
  }
  return null;
}
export function whisperInstallation() {
  const binary = process.env.WHISPER_BIN || findExecutable(path.join(root, '.runtime', 'whisper', 'bin'));
  const model = process.env.WHISPER_MODEL || path.join(root, '.runtime', 'whisper', 'ggml-large-v3.bin');
  return { binary, model, ready: Boolean(binary && existsSync(binary) && existsSync(model)) };
}

export function validateWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('有効なWAV音声を選んでください。');
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('WAVのファイルサイズが一致しません。');
  let cursor = 12, format, audio;
  while (cursor + 8 <= buffer.length) {
    const type = buffer.toString('ascii', cursor, cursor + 4), size = buffer.readUInt32LE(cursor + 4);
    if (cursor + 8 + size > buffer.length) throw new Error('音声ファイルが途中で切れています。');
    if (type === 'fmt ' && size >= 16) format = { encoding: buffer.readUInt16LE(cursor + 8), channels: buffer.readUInt16LE(cursor + 10), rate: buffer.readUInt32LE(cursor + 12), block: buffer.readUInt16LE(cursor + 20), bits: buffer.readUInt16LE(cursor + 22) };
    if (type === 'data') audio = buffer.subarray(cursor + 8, cursor + 8 + size);
    cursor += 8 + size + (size % 2);
  }
  if (!format || !audio || format.encoding !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16 || format.block !== 2 || audio.length % 2) throw new Error('比較音声は16kHz・モノラル・16bit PCMに変換して送信してください。');
  const seconds = audio.length / 32000;
  if (seconds < 0.2 || seconds > 120.001) throw new Error('比較には0.2秒〜2分の音声を使用してください。');
  return { seconds, samples: audio.length / 2 };
}

function runProcess(binary, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const cancel = () => child.kill();
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-32000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-32000); });
    child.on('error', error => { settled = true; signal.removeEventListener('abort', cancel); reject(error); });
    child.on('close', code => {
      signal.removeEventListener('abort', cancel);
      if (settled) return;
      if (signal.aborted) reject(new Error('比較を中断しました。'));
      else if (code !== 0) reject(new Error(output || `Whisper終了コード: ${code}`));
      else resolve(output);
    });
  });
}

export async function runWhisper(wav, language, signal) {
  const installation = whisperInstallation();
  if (!installation.ready) throw new Error('Whisperが未導入です。npm run setup:whisper を実行してください。');
  const parent = path.join(root, '.runtime', 'compare-jobs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'job-'));
  const audio = path.join(directory, 'input.wav'), prefix = path.join(directory, 'result');
  try {
    await writeFile(audio, wav);
    const args = ['-m', installation.model, '-f', audio, '-l', language === 'ja-JP' ? 'ja' : language === 'en-US' ? 'en' : 'auto', '-otxt', '-of', prefix, '-nt', '-t', '8', '-bs', '5'];
    let device = process.env.WHISPER_DEVICE === 'cpu' ? 'cpu' : 'cuda';
    let fallback = false;
    if (device === 'cpu') args.push('-ng');
    const started = performance.now();
    try {
      const logs = await runProcess(installation.binary, args, signal);
      if (device === 'cuda' && (!/ggml_cuda_init|CUDA\d+|using CUDA|CUDA.*total size/i.test(logs) || /no GPU found/.test(logs))) { device = 'cpu'; fallback = true; }
    }
    catch (error) {
      if (signal.aborted || device === 'cpu' || !/out of memory|alloc.*fail|CUDA error|failed to initialize|failed to create.*context/i.test(error.message)) throw error;
      // CPU keeps the same FP16 model and decoding settings if GPU memory is busy.
      device = 'cpu'; fallback = true;
      await runProcess(installation.binary, [...args, '-ng'], signal);
    }
    return { text: (await readFile(prefix + '.txt', 'utf8')).trim(), elapsedMs: Math.round(performance.now() - started), device, fallback, model: process.env.WHISPER_MODEL_LABEL || 'Whisper large-v3 · FP16', runtime: 'whisper.cpp v1.9.2', settings: 'beam size 5 · transcription' };
  } finally {
    // The only removable paths are freshly created job-* directories under our workspace.
    const relative = path.relative(parent, directory);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('job-')) await rm(directory, { recursive: true, force: true });
  }
}

export async function compareAudio({ wav, language, asrUrl, signal, whisperRunner = runWhisper, onResult }) {
  const started = performance.now();
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'comparison.wav');
  form.append('language', language); form.append('response_format', 'json'); form.append('automatic_punctuation', 'true');
  const response = await fetch(`${asrUrl}/v1/audio/transcriptions`, { method: 'POST', body: form, signal });
  if (!response.ok) throw new Error(`Nemotronで比較音声を認識できませんでした (${response.status})。`);
  const data = await response.json();
  if (typeof data.text !== 'string') throw new Error('Nemotronの認識結果が正しくありません。');
  await onResult('nemotron', { text: data.text.trim(), elapsedMs: Math.round(performance.now() - started), model: 'Nemotron 3.5 ASR · Q8', runtime: 'NeMo-Speech.cpp', settings: '320ms context · file recognition' });
  if (signal.aborted) throw new Error('比較を中断しました。');
  const result = await whisperRunner(wav, language, signal);
  await onResult('whisper', result);
}
