import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

test('responsive workbench, keyboard help, draft persistence and download', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '話すことから、はじめよう。' })).toBeVisible();
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow, `horizontal overflow at ${width}`).toBe(false);
    for (const label of ['録音を開始', '文章を整える']) {
      const bounds = await page.getByRole('button', { name: label, exact: true }).boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `test-results/viewport-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '使い方', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByLabel('文字起こしの原文').fill('明日の会議は午後3時です。');
  await page.reload(); await expect(page.getByLabel('文字起こしの原文')).toHaveValue('明日の会議は午後3時です。');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
  expect(errors).toEqual([]);
});

test('LLM streaming updates the output while preserving the original', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: true, models: ['test:4b'] }, defaultModel: 'test:4b' } }));
  let requested;
  await page.route('**/api/process', route => { requested = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ delta: '明日の会議は午後3時です。' }) + '\n' + JSON.stringify({ done: true }) + '\n' }); });
  await page.goto('/');
  const original = 'えっと、明日の会議は、あの、午後3時です。';
  await page.getByLabel('文字起こしの原文').fill(original);
  await page.getByRole('button', { name: '文章を整える', exact: true }).click();
  await expect(page.locator('.output-text')).toHaveText('明日の会議は午後3時です。');
  await expect(page.getByLabel('文字起こしの原文')).toHaveValue(original);
  expect(requested.mode).toBe('cleanup');
  await page.getByRole('button', { name: '要約', exact: true }).click();
  await page.getByRole('button', { name: '要約する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '要約', exact: true })).toBeVisible();
  expect(requested.mode).toBe('summary');
});

test('recording follows new finalized text and long partial speech automatically', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: true, models: ['test:4b'] }, defaultModel: 'test:4b' } }));
  let emit;
  await page.routeWebSocket('**/ws/transcribe', socket => {
    emit = event => socket.send(JSON.stringify(event)); emit({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') return;
      const event = JSON.parse(message);
      if (event.type === 'session.update') emit({ type: 'session.updated' });
      if (event.type === 'input_audio_buffer.commit') { emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: '停止時に確定した文章。\n'.repeat(80) }); emit({ type: 'input_audio_buffer.committed' }); void socket.close({ code: 1000 }); }
    });
  });
  await page.setViewportSize({ width: 375, height: 760 }); await page.goto('/');
  await page.getByRole('button', { name: '録音を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible();
  emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: Array.from({ length: 80 }, (_, i) => `確定した文章 ${i}。`).join('\n') });
  await expect.poll(() => page.getByLabel('文字起こしの原文').evaluate(element => element.scrollHeight > element.clientHeight && element.scrollHeight - element.clientHeight - element.scrollTop < 3)).toBe(true);
  await expect.poll(() => page.locator('.corrected-document').evaluate(element => element.scrollHeight > element.clientHeight && element.scrollHeight - element.clientHeight - element.scrollTop < 3)).toBe(true);
  emit({ type: 'conversation.item.input_audio_transcription.delta', delta: '現在認識している長い文章です。'.repeat(80) });
  await expect(page.locator('.partial')).toContainText('現在認識している');
  await expect.poll(() => page.locator('.partial').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を開始', exact: true })).toBeEnabled();
  await expect(page.getByLabel('文字起こしの原文')).toHaveValue(/停止時に確定した文章。/);
  await expect.poll(() => page.locator('.corrected-document').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 3)).toBe(true);
});

test('actual Nemotron recognizes a synthetic microphone and finalizes on stop', async ({ page }) => {
  test.skip(!process.env.KOTOBA_LIVE || !existsSync('.runtime/test-speech.wav'), 'Requires running ASR and generated test speech.');
  await page.goto('/');
  await expect(page.getByRole('button', { name: '録音を開始', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: '録音を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await page.getByLabel('文字起こしの原文').inputValue()) + (await page.locator('.partial').innerText()), { timeout: 45000 }).toMatch(/こんにちは|音声|会議/);
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を開始', exact: true })).toBeEnabled({ timeout: 20000 });
  await expect(page.getByLabel('文字起こしの原文')).not.toHaveValue('');
  await expect(page.locator('.partial')).toBeEmpty();
  await expect.poll(async () => (await (await page.request.get('/api/health')).json()).recording, { timeout: 2000 }).toBe(false);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/live-transcription.png', fullPage: true });
  await page.getByRole('button', { name: 'Whisperと比較', exact: true }).click();
  await expect(page.locator('audio')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '同じ音声で比較', exact: true })).toBeEnabled();
});

test('Whisper comparison interface supports file upload, CER and responsive layouts', async ({ page }) => {
  test.skip(!existsSync('.runtime/test-speech.wav'), 'Requires generated test speech.');
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, whisper: { ready: true }, ollama: { ready: true, models: [] }, defaultModel: 'test' } }));
  await page.route('**/api/compare*', route => route.fulfill({ contentType: 'application/x-ndjson', body: [
    { type: 'result', engine: 'nemotron', result: { text: '明日は会議です。', elapsedMs: 123 } },
    { type: 'result', engine: 'whisper', result: { text: '明日は会議です。', elapsedMs: 1000, device: 'cpu' } },
    { type: 'done' },
  ].map(JSON.stringify).join('\n') + '\n' }));
  await page.goto('/#compare');
  await page.getByLabel('比較する音声ファイル').setInputFiles('.runtime/test-speech.wav');
  await expect(page.getByRole('button', { name: '同じ音声で比較', exact: true })).toBeEnabled();
  await page.getByLabel('正解の文章', { exact: false }).fill('明日は会議です。');
  await page.getByRole('button', { name: '同じ音声で比較', exact: true }).click();
  await expect(page.getByTestId('nemotron-cer')).toHaveText('0.0%'); await expect(page.getByTestId('whisper-cer')).toHaveText('0.0%');
  await page.getByRole('button', { name: '文字起こし・整形', exact: true }).click();
  await page.getByRole('button', { name: 'Whisperと比較', exact: true }).click();
  await expect(page.getByTestId('whisper-cer')).toHaveText('0.0%');
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const visible = await page.getByRole('button', { name: '同じ音声で比較', exact: true }).boundingBox();
    expect(visible.x).toBeGreaterThanOrEqual(0); expect(visible.x + visible.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/comparison-${width}.png`, fullPage: true });
  }
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '結果を保存', exact: true }).click(); expect((await download).suggestedFilename()).toMatch(/\.json$/);
});

test('actual Whisper and Nemotron compare the same synthetic Japanese speech', async ({ page }) => {
  test.skip(!process.env.KOTOBA_WHISPER_LIVE || !existsSync('.runtime/test-speech.wav'), 'Requires local Whisper large-v3 and Nemotron.');
  await page.goto('/#compare');
  await page.getByLabel('比較する音声ファイル').setInputFiles('.runtime/test-speech.wav');
  await expect(page.getByRole('button', { name: '同じ音声で比較', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.getByLabel('正解の文章', { exact: false }).fill('こんにちは。今日は音声認識アプリの動作を確認しています。明日の会議は午後三時からです。');
  await page.getByRole('button', { name: '同じ音声で比較', exact: true }).click();
  await expect(page.getByTestId('nemotron-transcript')).toContainText('音声', { timeout: 30000 });
  await expect(page.getByTestId('whisper-transcript')).toContainText('こんにちは', { timeout: 180000 });
  await expect(page.getByRole('button', { name: '同じ音声で比較', exact: true })).toBeEnabled({ timeout: 5000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await (await page.request.get('/api/health')).json()).processing).toBe(false);
  await page.screenshot({ path: 'test-results/comparison-live.png', fullPage: true });
});
