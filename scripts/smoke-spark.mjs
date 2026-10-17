import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { root } from './runtime.mjs';

const audioPath = process.argv[2];
if (!audioPath || audioPath === '--help') {
  console.log('Usage: node scripts/smoke-spark.mjs <mono-PCM16.wav>\nKOTOBA_TEST_URL defaults to http://127.0.0.1:3210. Audio is replayed at real-time speed.');
  process.exit(audioPath === '--help' ? 0 : 1);
}
const base = process.env.KOTOBA_TEST_URL || 'http://127.0.0.1:3210';
const health = await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) })).json();
if (!health.asr?.ready || !health.llm?.ready || health.speech?.mode !== 'spark' || !health.speech?.diarization) throw new Error('Sparkの音声・LLM接続と話者分離ONを設定し、準備完了を確認してください。');
if (health.recording || health.processing) throw new Error('録音・AI処理の終了を待ってください。');
const file = await fs.open(audioPath, 'r'), size = (await file.stat()).size;
async function read(position, length) { const value = Buffer.alloc(length); const result = await file.read(value, 0, length, position); if (result.bytesRead !== length) throw new Error('WAVファイルが途中で終了しています。'); return value; }
const header = await read(0, 12);
if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('RIFF/WAVE形式を指定してください。');
let format, offset, length;
for (let position = 12; position + 8 <= size;) {
  const chunk = await read(position, 8), bytes = chunk.readUInt32LE(4), name = chunk.toString('ascii', 0, 4);
  if (position + 8 + bytes > size) throw new Error('WAVのチャンク長が不正です。');
  if (name === 'fmt ' && bytes >= 16) { const fmt = await read(position + 8, 16); format = { code: fmt.readUInt16LE(0), channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4), bits: fmt.readUInt16LE(14) }; }
  if (name === 'data') { offset = position + 8; length = bytes; break; }
  position += 8 + bytes + (bytes % 2);
}
if (!format || format.code !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate < 8000 || format.sampleRate > 96000 || !length || length % 2) throw new Error('8〜96kHz・モノラルPCM16のWAVを指定してください。');
const events = { completed: 0, unknown: 0, pendingMax: 0, errors: [], asrLagMs: [], translationMs: [] };
let started, finished = false, sessionId, resolveReady, rejectReady, resolveDone, rejectDone;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
void ready.catch(() => {}); void done.catch(() => {});
const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws/translate');
function fail(message) { const error = new Error(message); rejectReady(error); rejectDone(error); socket.close(); }
socket.on('error', () => fail('アプリの音声接続に失敗しました。'));
socket.on('close', () => { if (!finished) fail('確定が完了する前に接続が終了しました。'); });
socket.on('message', raw => {
  const event = JSON.parse(raw);
  if (event.type === 'meeting.started') sessionId = event.sessionId;
  if (event.type === 'session.created') socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: format.sampleRate, language: process.env.KOTOBA_LANGUAGE || 'ja-JP' }, translation: { targetLanguage: process.env.KOTOBA_LANGUAGE === 'en-US' ? 'ja-JP' : 'en-US', correctionMode: process.env.KOTOBA_CORRECTION || 'off', boundaryMode: 'rules' } }));
  if (event.type === 'session.updated') resolveReady();
  if (event.type === 'error') fail(event.error?.message || '音声接続でエラーが発生しました。');
  if (event.type === 'conversation.item.input_audio_transcription.completed' && started && event.words?.length) events.asrLagMs.push(Math.round(performance.now() - started - event.words.at(-1).end * 1000));
  if (event.type === 'translation.segment' && !event.segment.provisional && event.segment.speaker?.status === 'unknown') events.unknown++;
  if (event.type === 'translation.queue') events.pendingMax = Math.max(events.pendingMax, event.pending || 0);
  if (event.type === 'translation.error') events.errors.push(event.error);
  if (event.type === 'translation.completed') { events.completed++; if (event.timing) events.translationMs.push(event.timing.completedAt - event.timing.finalizedAt); }
  if (event.type === 'translation.finished') { finished = true; resolveDone(); }
});
const preparation = setTimeout(() => fail('準備がタイムアウトしました。'), 200000);
try {
  await ready; clearTimeout(preparation); started = performance.now();
  const frameBytes = Math.round(format.sampleRate * 0.08) * 2, buffer = Buffer.alloc(frameBytes);
  for (let sent = 0; sent < length;) {
    const bytes = Math.min(frameBytes, length - sent), result = await file.read(buffer, 0, bytes, offset + sent);
    if (result.bytesRead !== bytes || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) throw new Error('音声転送が継続できません。');
    await new Promise((resolve, reject) => socket.send(buffer.subarray(0, bytes), { binary: true }, error => error ? reject(error) : resolve()));
    sent += bytes;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, started + sent / 2 / format.sampleRate * 1000 - performance.now())));
  }
  socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  const deadline = setTimeout(() => fail('残処理が10分以内に完了しませんでした。'), 600000);
  try { await done; } finally { clearTimeout(deadline); }
  const percentile = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null; };
  const report = { checkedAt: new Date().toISOString(), sessionId, audioSeconds: length / 2 / format.sampleRate, elapsedSeconds: (performance.now() - started) / 1000, model: health.defaultModel, ...events, asrLagP95Ms: percentile(events.asrLagMs), translationP95Ms: percentile(events.translationMs) };
  const target = path.join(root, '.runtime', `spark-smoke-${Date.now()}.json`); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(report, null, 2));
  console.log(`検証結果：${target}\n翻訳完了 ${events.completed}件、話者不明 ${events.unknown}件、最大翻訳待ち ${events.pendingMax}件`);
  if (events.errors.length) process.exitCode = 1;
} finally { clearTimeout(preparation); socket.close(); await file.close(); }
