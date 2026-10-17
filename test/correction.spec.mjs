import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const raw = '天気がいいので選択しようと思います。';
const corrected = raw.replace('選択', '洗濯');
const correction = { status: 'applied', correctedSource: corrected, edits: [{ from: '選択', to: '洗濯', start: 7, end: 9, reason: '同音語' }] };
async function health(page) {
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: true, models: ['gemma4:latest'] }, defaultModel: 'gemma4:latest', correction: { supported: true }, translation: { models: [{ model: 'gemma4:latest', label: 'Gemma 4', profile: 'general', installed: true }], defaultModel: 'gemma4:latest', boundaryModel: 'gemma4:latest' } } }));
}

test('normal microphone correction preserves raw, waits for drain, saves differences and restores them', async ({ page }) => {
  await health(page); let configured;
  await page.routeWebSocket('**/ws/transcribe', socket => {
    const send = event => socket.send(JSON.stringify(event)); let sent = false;
    send({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') {
        if (!sent) { sent = true; send({ type: 'conversation.item.input_audio_transcription.completed', transcript: raw }); send({ type: 'caption.segment', segment: { id: 1, revision: 1, source: raw, rawSource: raw, status: 'queued' } }); send({ type: 'caption.correction', id: 1, revision: 1, correction }); }
        return;
      }
      const event = JSON.parse(message);
      if (event.type === 'session.update') { configured = event; send({ type: 'caption.ready', notice: 'GemmaはGPUで動作しています。' }); send({ type: 'session.updated' }); }
      if (event.type === 'input_audio_buffer.commit') { send({ type: 'input_audio_buffer.committed' }); setTimeout(() => { send({ type: 'caption.finished' }); void socket.close({ code: 1000 }); }, 150); }
    });
  });
  await page.goto('/'); await page.getByRole('button', { name: '録音を開始', exact: true }).click();
  await expect(page.getByLabel('文字起こしの原文')).toHaveValue(raw);
  await expect(page.locator('.corrected-document')).toHaveText(corrected);
  expect(configured.captions.correctionMode).toBe('conservative');
  await expect(page.getByLabel('日本語の誤変換補正', { exact: true }).first()).toBeDisabled();
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を開始', exact: true })).toBeEnabled();
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click();
  expect(await readFile(await (await downloading).path(), 'utf8')).toContain('選択 → 洗濯');
  await page.reload(); await expect(page.getByLabel('文字起こしの原文')).toHaveValue(raw); await expect(page.locator('.corrected-document')).toHaveText(corrected);
  const edited='手で確認：'+raw;
  await page.getByLabel('文字起こしの原文').fill(edited);
  await page.getByRole('button', { name: '録音を開始', exact: true }).click();
  await expect(page.getByLabel('文字起こしの原文')).toHaveValue(edited+'\n'+raw);
  await expect(page.locator('.corrected-document')).toHaveText(edited+'\n'+corrected);
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を開始', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.corrected-document')).toHaveText(edited+'\n'+corrected);
  for (const width of [320,375,768,1440]) { await page.setViewportSize({ width, height: 960 }); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false); }
  await page.screenshot({ path: 'test-results/correction-normal.png', fullPage: true });
});

test('translation uses corrected input, ignores old model selection and can retranslate the raw source', async ({ page }) => {
  await health(page);
  await page.addInitScript(() => localStorage.setItem('kotoba.translation-model', 'qwen3.5:4b'));
  let configured, retried;
  await page.routeWebSocket('**/ws/translate', socket => {
    const send = event => socket.send(JSON.stringify(event)); let sent = false;
    send({ type: 'session.created' }); socket.onMessage(message => {
      if (typeof message !== 'string') {
        if (!sent) { sent = true; send({ type: 'translation.segment', segment: { id: 1, revision: 1, source: raw, rawSource: raw, status: 'queued', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'gemma4:latest' } }); send({ type: 'translation.correction', id: 1, revision: 1, correction, translationInput: { text: corrected, origin: 'corrected' } }); send({ type: 'translation.completed', id: 1, revision: 1, text: 'I will do the laundry.' }); } return;
      }
      const event = JSON.parse(message); if (event.type === 'session.update') { configured = event; send({ type: 'session.updated' }); }
      if (event.type === 'input_audio_buffer.commit') { send({ type: 'input_audio_buffer.committed' }); send({ type: 'translation.finished' }); void socket.close({ code: 1000 }); }
    });
  });
  await page.route('**/api/translate', route => { retried = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ done: true, text: 'I will make a choice.', correction: { status: 'off', correctedSource: raw, edits: [] }, translationInput: { text: raw, origin: 'raw' } }) + '\n' }); });
  await page.goto('/#translate'); await expect(page.getByLabel('翻訳モデル', { exact: true })).toHaveValue('gemma4:latest'); await expect(page.getByLabel('翻訳モデル', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.locator('.caption-source')).toContainText(raw); await expect(page.locator('.correction-detail')).toContainText(corrected); expect(configured.translation.model).toBe('gemma4:latest');
  await page.getByRole('button', { name: '録音を停止', exact: true }).click(); await page.getByRole('button', { name: '原文で再翻訳', exact: true }).click();
  await expect(page.locator('.caption-target')).toContainText('I will make a choice.');
  expect(retried.correctionMode).toBe('off'); expect(retried.text).toBe(raw); expect(retried.model).toBe('gemma4:latest');
  await expect(page.locator('.correction-detail')).toContainText('翻訳入力: 原文');
  await page.locator('#translation-correction').selectOption('off');
  await page.getByRole('button', { name: '補正して再翻訳', exact: true }).click();
  await expect.poll(() => retried.correctionMode).toBe('conservative');
  await page.screenshot({ path: 'test-results/correction-translation.png', fullPage: true });
});
