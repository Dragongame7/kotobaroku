import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { root } from './runtime.mjs';
import path from 'node:path';
const base = process.env.APP_URL || 'http://127.0.0.1:3210';
const health = await (await fetch(`${base}/api/health`)).json();
console.log('Services:', JSON.stringify(health));
if (!health.asr.ready || !(health.llm?.ready ?? health.ollama.ready)) throw new Error('Start the ASR and Ollama first.');
const wav = await readFile(path.join(root, '.runtime', 'test-speech.wav'));
let cursor = 12, pcm, rate = 16000;
while (cursor + 8 <= wav.length) {
  const tag = wav.toString('ascii', cursor, cursor + 4), length = wav.readUInt32LE(cursor + 4);
  if (tag === 'fmt ') rate = wav.readUInt32LE(cursor + 12);
  if (tag === 'data') { pcm = wav.subarray(cursor + 8, cursor + 8 + length); break; }
  cursor += 8 + length + (length % 2);
}
if (!pcm) throw new Error('WAV data missing');
let transcript = '', partialCount = 0;
const started = performance.now();
await new Promise((resolve, reject) => {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws/transcribe');
  const timeout = setTimeout(() => { socket.terminate(); reject(new Error('ASR timed out')); }, 90000);
  socket.on('error', reject);
  socket.on('message', async data => {
    const event = JSON.parse(data.toString());
    if (event.type === 'session.created') socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: rate, language: 'ja-JP', endpointing_ms: 700, automatic_punctuation: true } }));
    if (event.type === 'session.updated') {
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(pcm.subarray(offset, offset + 3200));
        await new Promise(r => setTimeout(r, 20));
      }
      // Trailing silence exercises endpointing before the explicit final flush.
      socket.send(Buffer.alloc(rate * 2));
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
    if (event.type.endsWith('.delta')) partialCount++;
    if (event.type.endsWith('.completed')) transcript += event.transcript || '';
    if (event.type === 'error') { clearTimeout(timeout); socket.close(); reject(new Error(JSON.stringify(event.error))); }
    if (event.type === 'input_audio_buffer.committed') { clearTimeout(timeout); socket.close(); socket.once('close', resolve); }
  });
});
if (!transcript.trim()) throw new Error('ASR returned an empty transcript');
console.log(`ASR (${Math.round(performance.now() - started)}ms, ${partialCount} partial events): ${transcript}`);
// Wait until the closed recording connection has released the processing lock.
await new Promise(resolve => setTimeout(resolve, 300));
const response = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: transcript, mode: 'cleanup', model: health.defaultModel }) });
const content = await response.text();
if (!response.ok) throw new Error(content);
const events = content.trim().split('\n').map(JSON.parse);
if (events.some(event => event.error) || !events.some(event => event.done)) throw new Error(content);
const result = events.map(event => event.delta || '').join('');
if (!result.trim()) throw new Error('Empty LLM output');
console.log('LLM:', result);
