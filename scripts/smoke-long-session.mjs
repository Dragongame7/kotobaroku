import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
const base = 'http://127.0.0.1:3210'; const durationMs = Number(process.env.SMOKE_DURATION_SECONDS || 900) * 1000;
const health = await (await fetch(base + '/api/health')).json(); assert.ok(health.asr.ready && (health.llm?.ready ?? health.ollama.ready) && !health.recording && !health.processing);
const wav = await readFile('.runtime/test-speech.wav'); let pcm, rate;
for (let offset = 12; offset + 8 <= wav.length;) { const length = wav.readUInt32LE(offset + 4), tag = wav.toString('ascii', offset, offset + 4); if (tag === 'fmt ') rate = wav.readUInt32LE(offset + 12); if (tag === 'data') pcm = wav.subarray(offset + 8, offset + 8 + length); offset += 8 + length + length % 2; }
assert.ok(pcm && rate === 16000);
const audio = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 3)]); const rows = new Map(), sources = [], samples = [], errors = [];
let audioOffset = 0, queuePeak = 0;
let started, finished = false, chunks = 0, committed = false, lastSample = 0; let timer;
await mkdir('reports', { recursive: true });
await new Promise((resolve, reject) => {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws/transcribe');
  const deadline = setTimeout(() => { clearInterval(timer); socket.terminate(); reject(Error('Long-session timeout')); }, durationMs + 180000);
  socket.on('error', reject);
  socket.on('close', () => { clearInterval(timer); clearTimeout(deadline); finished ? resolve() : reject(Error('Closed before caption drain')); });
  socket.on('message', data => {
    const event = JSON.parse(data.toString());
    if (event.type === 'session.created') socket.send(JSON.stringify({ type: 'session.update', session: { language: 'ja-JP', sample_rate: 16000, automatic_punctuation: true }, captions: { correctionMode: 'conservative' } }));
    if (event.type === 'session.updated') {
      started = Date.now();
      timer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - started >= durationMs) { clearInterval(timer); committed = true; socket.send('{"type":"input_audio_buffer.commit"}'); return; }
        chunks++; const tail = audio.subarray(audioOffset, Math.min(audioOffset + 3200, audio.length)); const frame = tail.length === 3200 ? tail : Buffer.concat([tail, audio.subarray(0, 3200 - tail.length)]); socket.send(frame); audioOffset = (audioOffset + 3200) % audio.length;
        if (Date.now() - lastSample >= 60000) {
          lastSample = Date.now(); void (async () => { const current = await (await fetch(base + '/api/health')).json(); let gpu = null; try { gpu = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, encoding: 'utf8' }).trim(); } catch { /* Optional telemetry. */ } samples.push({ elapsedMs: Date.now() - started, runtime: current.runtime, residency: current.llm?.residency, gpu }); console.log(`Long session ${Math.floor((Date.now() - started)/1000)}s, ${sources.length} ASR fragments, ${rows.size} rows`); await writeFile('reports/long-session-progress.json', JSON.stringify({ durationMs, sources: sources.length, rows: rows.size, samples }, null, 2)); })().catch(error => errors.push(error.message));
        }
      }, 100);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') sources.push(event.transcript);
    if (event.type === 'caption.segment') rows.set(event.segment.id, event.segment);
    if (event.type === 'caption.correction') rows.set(event.id, { ...rows.get(event.id), correction: event.correction });
    if (event.type === 'caption.completed') rows.set(event.id, { ...rows.get(event.id), status: 'done', timing: event.timing });
    if (event.type === 'caption.queue') queuePeak = Math.max(queuePeak, event.pending || 0);
    if (event.type === 'error' || event.type === 'caption.error') errors.push(event.error);
    if (event.type === 'caption.finished') { finished = true; socket.close(); }
  });
});
const correctionCounts = {};
for (const row of rows.values()) { const status = row.correction?.status || 'missing'; correctionCounts[status] = (correctionCounts[status] || 0) + 1; }
const result = { createdAt: new Date().toISOString(), model: health.defaultModel, elapsedMs: Date.now() - started, requestedDurationMs: durationMs, committed, finished, queuePeak, correctionCounts, audio: 'Repeated synthetic Japanese PCM at microphone speed, not a human microphone quality evaluation.', errors, samples, sources, rows: [...rows.values()] };
await writeFile('reports/long-session.json', JSON.stringify(result, null, 2));
assert.equal(errors.length, 0); assert.ok(committed && finished && sources.length > 2);
assert.equal([...rows.values()].map(row => row.rawSource || row.source).join('').replace(/\s/gu, ''), sources.join('').replace(/\s/gu, ''));
assert.ok([...rows.values()].every(row => row.status === 'done'));
if (samples.length > 2) assert.ok(samples.at(-1).runtime.rss - samples[0].runtime.rss < 150 * 1024 ** 2, 'Server RSS grew more than 150 MiB');
console.log(`Long recording passed: ${Math.round(result.elapsedMs/1000)} seconds, ${sources.length} source fragments, ${rows.size} rows, no raw text lost.`);
