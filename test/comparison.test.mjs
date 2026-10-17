import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { validateWav } from '../server/comparison.mjs';
import { characterErrorRate } from '../src/quality.ts';
import { createApplication } from '../server/app.mjs';

function wav(seconds = 1) {
  const buffer = Buffer.alloc(44 + 32000 * seconds);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, whisperRunner) {
  let received;
  const mock = http.createServer(async (req, res) => {
    if (req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); received = Buffer.concat(chunks); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: '音声認識の比較です。', ready: true }));
  });
  const asrUrl = await listen(mock);
  const application = createApplication({ asrUrl, ollamaUrl: asrUrl, whisperRunner });
  const base = await listen(application.server);
  t.after(async () => { application.server.closeAllConnections(); mock.closeAllConnections(); await Promise.all([new Promise(resolve => application.server.close(resolve)), new Promise(resolve => mock.close(resolve))]); });
  return { base, received: () => received };
}

test('CER uses Unicode characters, normalized punctuation, case and width', () => {
  assert.equal(characterErrorRate('ＡＰＩ、 テスト。', 'apiテスト').percent, 0);
  assert.equal(characterErrorRate('あいう', 'あえう').errors, 1);
  assert.ok(Math.abs(characterErrorRate('あいう', 'あえう').percent - 100 / 3) < 0.000001);
});

test('CER counts insertions and deletions, leaves numeral conventions explicit', () => {
  assert.equal(characterErrorRate('あい', 'あ').errors, 1);
  assert.equal(characterErrorRate('あ', 'あいう').percent, 200);
  assert.equal(characterErrorRate('午後三時', '午後3時').errors, 1);
  assert.equal(characterErrorRate('。 ', 'test'), null);
});

test('WAV validation rejects wrong formats, truncation and overlong audio', () => {
  assert.equal(validateWav(wav()).seconds, 1);
  assert.throws(() => validateWav(Buffer.from('not audio')), /WAV/);
  const wrongRate = wav(); wrongRate.writeUInt32LE(48000, 24); assert.throws(() => validateWav(wrongRate), /16kHz/);
  assert.throws(() => validateWav(wav().subarray(0, 100)), /サイズ/);
  assert.throws(() => validateWav(wav(121)), /2分/);
});

test('comparison sends identical audio to both engines and returns unedited raw results', async t => {
  const audio = wav(); let whispered;
  const app = await fixture(t, async data => { whispered = data; return { text: '音声認識を比較します。', elapsedMs: 12, device: 'cpu', model: 'Whisper test' }; });
  const response = await fetch(`${app.base}/api/compare?language=ja-JP`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(response.status, 200); assert.equal(events[0].durationSeconds, 1);
  assert.equal(events[1].engine, 'nemotron'); assert.equal(events[1].result.text, '音声認識の比較です。');
  assert.equal(events[2].engine, 'whisper'); assert.equal(events[2].result.text, '音声認識を比較します。');
  assert.equal(events[3].type, 'done'); assert.ok(whispered.equals(audio)); assert.ok(app.received().includes(audio));
  const status = await (await fetch(`${app.base}/api/health`)).json(); assert.equal(status.processing, false);
});

test('comparison retains completed Nemotron output if Whisper fails', async t => {
  const app = await fixture(t, async () => { throw new Error('Whisper failed'); });
  const response = await fetch(`${app.base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav() });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[1].engine, 'nemotron'); assert.equal(events[2].type, 'error');
  assert.match(events[2].error, /Whisper failed/);
  assert.equal((await (await fetch(`${app.base}/api/health`)).json()).processing, false);
});

test('canceling comparison aborts the worker and releases the processing lock', async t => {
  let started, aborted;
  const running = new Promise(resolve => { started = resolve; });
  const canceled = new Promise(resolve => { aborted = resolve; });
  const app = await fixture(t, async (_wav, _language, signal) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => { aborted(); reject(new Error('canceled')); }, { once: true });
  }));
  const controller = new AbortController();
  const response = await fetch(`${app.base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(), signal: controller.signal });
  await running;
  controller.abort();
  await canceled;
  await response.body.cancel().catch(() => {});
  for (let retry = 0; retry < 20; retry++) {
    if (!(await (await fetch(`${app.base}/api/health`)).json()).processing) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('comparison lock was not released');
});
