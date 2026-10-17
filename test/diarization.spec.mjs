import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const sessionId = '12345678-1234-4234-8234-123456789abc';
const speech = { mode: 'spark', baseUrl: 'http://spark.invalid:8001/speech', gatewayUrl: 'http://spark.invalid:8001', diarization: true, inputProfile: 'conference', revision: 'speech-1', hasApiKey: true };
const caption = (id, nativeSpeaker) => ({ id, revision: 1, sessionId, source: `会議の発言${id}です。`, rawSource: `会議の発言${id}です。`, translation: `Meeting turn ${id}.`, status: 'done', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'meeting-llm', audioStart: id - 1, speaker: { sessionId, speakerId: `spk-${nativeSpeaker}`, status: 'assigned', origin: 'nemotron3' } });
async function fixture(page) {
  let current = { ...speech }, names = {}, saved;
  const rows = [caption(1, 1), caption(2, 2), caption(3, 1)];
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, llm: { ready: true, provider: 'openai' }, ollama: { ready: true, models: ['meeting-llm'] }, defaultModel: 'meeting-llm' } }));
  await page.route('**/api/llm/settings', route => route.fulfill({ json: { provider: 'openai', baseUrl: 'http://spark.invalid:8001/v1', model: 'meeting-llm', revision: 'llm-1', hasApiKey: true, origin: 'saved' } }));
  await page.route('**/api/speech/settings', route => route.fulfill({ json: current }));
  await page.route('**/api/speech/settings/test', route => route.fulfill({ json: { token: 'speech-proof', checks: ['音声接続', '話者分離オプション'] } }));
  await page.route('**/api/speech/settings/save', route => {
    saved = route.request().postDataJSON(); current = { ...current, diarization: saved.diarization, inputProfile: saved.inputProfile, revision: 'speech-2' }; return route.fulfill({ json: current });
  });
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [{ id: sessionId, createdAt: '2026-10-17T08:00:00Z', status: 'completed', count: 3 }] } }));
  await page.route(`**/api/sessions/${sessionId}`, route => route.fulfill({ json: { id: sessionId, createdAt: '2026-10-17T08:00:00Z', status: 'completed', speakers: names, rows, utterances: [], gaps: [] } }));
  await page.route(`**/api/sessions/${sessionId}/speakers`, route => route.fulfill({ json: names }));
  await page.route(`**/api/sessions/${sessionId}/speakers/*`, route => { const id = route.request().url().split('/').at(-1); names[id] = route.request().postDataJSON().name; return route.fulfill({ json: names }); });
  return { rows, get saved() { return saved; } };
}

test('speech settings test exact drafts, preserve credentials, and render on GPU-free narrow screens', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto('/#settings');
  await expect(page.getByLabel('音声の処理場所')).toHaveValue('spark');
  await expect(page.getByRole('button', { name: '音声設定を適用' })).toBeDisabled();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await page.getByLabel('話者分離', { exact: true }).selectOption('false');
  await page.getByRole('button', { name: '音声の動作を確認' }).click();
  await expect(page.getByRole('button', { name: '音声設定を適用' })).toBeEnabled();
  await page.getByLabel('マイク入力').selectOption('browser');
  await expect(page.getByRole('button', { name: '音声設定を適用' })).toBeDisabled();
  await page.getByRole('button', { name: '音声の動作を確認' }).click();
  await page.getByRole('button', { name: '音声設定を適用' }).click();
  await expect.poll(() => f.saved?.token).toBe('speech-proof');
  expect(f.saved.apiKeyAction).toBe('keep'); expect(f.saved.apiKey).toBe(''); expect(f.saved.diarization).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/v1-speech-settings-375.png', fullPage: true });
});

test('live speaker labels rename consistently, restore, and remain in chronological export', async ({ page }) => {
  const f = await fixture(page); let send;
  await page.routeWebSocket('**/ws/translate', socket => {
    send = value => socket.send(JSON.stringify(value)); send({ type: 'session.created' });
    socket.onMessage(raw => {
      if (typeof raw !== 'string') return;
      const event = JSON.parse(raw);
      if (event.type === 'session.update') { send({ type: 'meeting.started', sessionId, diarization: true }); send({ type: 'session.updated' }); }
      if (event.type === 'input_audio_buffer.commit') { send({ type: 'input_audio_buffer.committed' }); send({ type: 'translation.finished' }); }
    });
  });
  await page.goto('/#live'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  for (const row of f.rows) send({ type: 'translation.segment', segment: row });
  await expect(page.locator('.live-pair')).toHaveCount(3);
  await page.getByRole('button', { name: '0:00 · 話者1', exact: true }).click();
  await page.getByLabel('会議内の話者名').fill('田中'); await page.getByRole('button', { name: '名前を保存' }).click();
  await expect(page.locator('.live-pair').filter({ hasText: '田中' })).toHaveCount(2);
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click();
  await expect(page.getByRole('button', { name: '会話を保存', exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '会話を保存', exact: true }).click();
  const exported = await readFile(await (await download).path(), 'utf8');
  expect(exported).toContain('田中'); expect(exported.indexOf('会議の発言1')).toBeLessThan(exported.indexOf('会議の発言3'));
  await page.reload(); await expect(page.locator('.live-pair').filter({ hasText: '田中' })).toHaveCount(2);
  await page.screenshot({ path: 'test-results/v1-live-speakers.png', fullPage: true });
});

test('durable history offers speaker names, raw text and structured export', async ({ page }) => {
  await fixture(page); await page.goto('/#settings');
  await page.getByRole('button', { name: /3区間/ }).click();
  await expect(page.locator('.meeting-preview article')).toHaveCount(3);
  await page.locator('.meeting-preview').getByRole('button', { name: '0:00 · 話者1', exact: true }).click();
  await page.getByLabel('会議内の話者名').fill('司会'); await page.getByRole('button', { name: '名前を保存' }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '会議JSONを保存' }).click();
  const data = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(data.speakers['spk-1']).toBe('司会'); expect(data.rows[0].source).toBe('会議の発言1です。'); expect(data.rows[0].audioStart).toBe(0);
});
