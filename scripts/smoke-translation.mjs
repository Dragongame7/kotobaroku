import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import path from 'node:path';
import { root } from './runtime.mjs';

const base = 'http://127.0.0.1:3210';
const health = await (await fetch(`${base}/api/health`)).json();
const translationModel = health.translation?.defaultModel || health.defaultModel;
if (!health.asr.ready || !(health.llm?.ready ?? health.ollama.ready)) throw new Error('ASR and Ollama must be running');
const wav = await readFile(path.join(root, '.runtime', 'test-speech.wav'));
let cursor = 12, pcm;
while (cursor + 8 <= wav.length) { const length = wav.readUInt32LE(cursor + 4); if (wav.toString('ascii', cursor, cursor + 4) === 'data') { pcm = wav.subarray(cursor + 8, cursor + 8 + length); break; } cursor += 8 + length + length % 2; }
if (!pcm) throw new Error('WAV data missing');
const events = []; let commitSent = false, translatedWhileRecording = false;
const started = performance.now();
await new Promise((resolve, reject) => {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws/translate');
  const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Live translation timeout')); }, 180000);
  const fail = error => { clearTimeout(timeout); socket.close(); reject(error); };
  socket.on('error', fail);
  socket.on('close', () => { if (!events.some(event => event.type === 'translation.finished')) fail(new Error('Connection closed before translation finished')); });
  socket.on('message', data => {
    const event = JSON.parse(data.toString()); events.push(event);
    if (event.type === 'session.created') socket.send(JSON.stringify({ type: 'session.update', session: { language: 'ja-JP', sample_rate: 16000 }, translation: { targetLanguage: 'en-US', model: translationModel } }));
    if (event.type === 'translation.preparing') console.log('Preparing translation model…');
    if (event.type === 'session.updated') {
      console.log('Model ready; sending synthetic speech at microphone speed.');
      void (async () => {
        const withSilence = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 2)]);
        for (let offset = 0; offset < withSilence.length; offset += 3200) { if (socket.readyState !== WebSocket.OPEN) return; socket.send(withSilence.subarray(offset, offset + 3200)); await new Promise(r => setTimeout(r, 100)); }
        const deadline = Date.now() + 65000;
        while (!translatedWhileRecording && Date.now() < deadline && socket.readyState === WebSocket.OPEN) await new Promise(r => setTimeout(r, 100));
        if (!translatedWhileRecording) throw new Error('No translation completed before stopping the microphone stream');
        commitSent = true; socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      })().catch(fail);
    }
    if (event.type === 'translation.segment') console.log('Source:', event.segment.source);
    if (event.type === 'translation.completed') { if (!commitSent) translatedWhileRecording = true; console.log('Translation:', event.text, `(${event.firstTokenMs}ms to first token)`); }
    if (event.type === 'error' || event.type === 'translation.error') fail(new Error(JSON.stringify(event.error)));
    if (event.type === 'translation.finished') { clearTimeout(timeout); socket.close(); resolve(); }
  });
});
const reverse = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'The meeting starts tomorrow at three in the afternoon.', sourceLanguage: 'en-US', targetLanguage: 'ja-JP', model: translationModel }) });
const reverseEvents = (await reverse.text()).trim().split('\n').map(JSON.parse);
if (!reverse.ok || reverseEvents.some(event => event.error) || !reverseEvents.some(event => event.done)) throw new Error(JSON.stringify(reverseEvents));
const japanese = reverseEvents.filter(event => event.delta).map(event => event.delta).join('');
if (!/[\u3040-\u9fff]/.test(japanese)) throw new Error('English-to-Japanese result was not Japanese');
console.log('English → Japanese:', japanese);
await mkdir(path.join(root, 'reports'), { recursive: true });
await writeFile(path.join(root, 'reports', 'translation-smoke.json'), JSON.stringify({ createdAt: new Date().toISOString(), model: translationModel, translatedWhileRecording, totalMs: Math.round(performance.now() - started), segments: events.filter(event => ['translation.segment', 'translation.completed'].includes(event.type)), reverse: reverseEvents.at(-1) }, null, 2) + '\n');
console.log('Live translation and both language directions passed.');
