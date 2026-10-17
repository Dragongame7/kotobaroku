import { test, expect } from '@playwright/test';

const saved = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:latest', hasApiKey: true, origin: 'default', revision: 'settings:1' };
async function setup(page, { prepare = true, finish = true } = {}) {
  let current = { ...saved }, emit, connections = 0, requests = [];
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: current.provider === 'ollama', models: [current.model] }, defaultModel: current.model, llm: { ...current, ready: true }, translation: { models: [], defaultModel: current.model, boundaryModel: current.model, comparisonSupported: current.provider === 'ollama' } } }));
  await page.route('**/api/llm/settings', route => route.fulfill({ json: current }));
  await page.route('**/api/llm/settings/*', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const operation = route.request().url().split('/').at(-1);
    if (operation === 'models') return route.fulfill({ json: { models: ['served-model'] } });
    if (operation === 'test') return route.fulfill({ json: { token: 'test-token', checks: ['文章生成', '差分受信', 'JSON出力'], checkedAt: '2026-10-17T09:00:00Z' } });
    current = { provider: body.provider, baseUrl: body.baseUrl, model: body.model, hasApiKey: body.apiKeyAction === 'replace', origin: 'saved', revision: 'settings:2', checkedAt: '2026-10-17T09:00:00Z' };
    return route.fulfill({ json: current });
  });
  await page.addInitScript(() => {
    globalThis.testStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); testStreams.push(stream); return stream; };
  });
  await page.routeWebSocket('**/ws/translate', socket => {
    connections++; emit = event => socket.send(JSON.stringify(event)); emit({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') return;
      const event = JSON.parse(message);
      if (event.type === 'session.update' && prepare) emit({ type: 'session.updated' });
      if (event.type === 'input_audio_buffer.commit') { emit({ type: 'input_audio_buffer.committed' }); if (finish) emit({ type: 'translation.finished' }); }
    });
  });
  return { emit: event => emit(event), get connections() { return connections; }, requests };
}
const segment = id => ({ type: 'translation.segment', segment: { id, revision: 1, source: `原文 ${id}。AIモデル API v0.4.0 を15:00に確認します。`, translation: `Translation ${id}. Review the API at 15:00.`, status: 'done', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'gemma4:latest' } });

test('independent connection settings test before apply, clear keys for new URLs, preserve conversation and draft', async ({ page }) => {
  const f = await setup(page);
  await page.goto('/'); await page.getByLabel('文字起こしの原文').fill('保存しておく原稿');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page).toHaveURL(/#settings$/);
  await page.getByRole('button', { name: '作業へ戻る' }).click();
  await expect(page.getByLabel('文字起こしの原文')).toHaveValue('保存しておく原稿');
  await page.getByRole('button', { name: 'ライブ翻訳', exact: true }).click();
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  f.emit(segment(1)); await expect(page.locator('.live-pair')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('接続方式', { exact: true }).selectOption('openai');
  await page.getByLabel('接続先URL', { exact: true }).fill('http://192.0.2.1:8001/v1');
  await expect(page.getByLabel('APIキー', { exact: true })).toHaveValue('clear');
  await page.getByRole('button', { name: 'モデル一覧を取得' }).click();
  await expect(page.getByRole('status')).toContainText('モデル候補を取得');
  await page.getByLabel('モデル', { exact: true }).fill('served-model');
  await page.getByLabel('APIキー', { exact: true }).selectOption('replace');
  await page.getByLabel('新しいAPIキー').fill('browser-test-secret');
  await expect(page.getByRole('button', { name: '保存して適用' })).toBeDisabled();
  await page.getByRole('button', { name: '接続をテスト', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存して適用' })).toBeEnabled();
  await page.getByLabel('モデル', { exact: true }).fill('edited-model');
  await expect(page.getByRole('button', { name: '保存して適用' })).toBeDisabled();
  await page.getByLabel('モデル', { exact: true }).fill('served-model');
  await page.getByRole('button', { name: '接続をテスト', exact: true }).click();
  await page.getByRole('button', { name: '保存して適用' }).click();
  await expect(page.locator('.llm-current')).toContainText('served-model');
  await expect(page.locator('.llm-current')).not.toContainText('browser-test-secret');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('browser-test-secret');
  expect(f.requests.at(-1).apiKey).toBe('browser-test-secret');
  await page.getByRole('button', { name: '作業へ戻る' }).click();
  await expect(page).toHaveURL(/#live$/); await expect(page.locator('.live-pair')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
  await expect(page.locator('.local-label')).toHaveText('外部サーバーへ接続');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 }); await page.getByRole('button', { name: '設定', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: `test-results/settings-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '作業へ戻る' }).click();
  }
});

test('connection errors, cancellation and a direct settings link retain applied settings', async ({ page }) => {
  await setup(page); await page.goto('/#settings');
  await page.route('**/api/llm/settings/test', route => route.fulfill({ status: 400, json: { error: '接続先の認証に失敗しました。' } }));
  await page.getByRole('button', { name: '接続をテスト', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('認証');
  await expect(page.getByRole('button', { name: '保存して適用' })).toBeDisabled();
  await page.route('**/api/llm/settings/test', () => {});
  await page.getByRole('button', { name: '接続をテスト', exact: true }).click();
  await page.getByRole('button', { name: '接続確認を中止' }).click();
  await expect(page.getByRole('alert')).toContainText('中断');
  await expect(page.locator('.llm-current')).toContainText('gemma4:latest');
  await page.getByRole('button', { name: '作業へ戻る' }).click(); await expect(page).toHaveURL(/#live$/);
});

test('native fullscreen preserves preparation, recording, draining, one socket and the reading anchor', async ({ page }) => {
  const f = await setup(page, { prepare: false, finish: false });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.goto('/#live');
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '準備を中止' })).toBeVisible();
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('aria-label'))).toBe('ライブ翻訳');
  await expect(page.getByRole('button', { name: '準備を中止' })).toBeVisible();
  await expect.poll(() => f.connections).toBe(1); f.emit({ type: 'session.updated' });
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  for (let id = 1; id <= 180; id++) f.emit(segment(id));
  await expect(page.locator('.live-pair')).toHaveCount(180);
  const history = page.locator('.live-history');
  expect(await history.evaluate(element => element.clientHeight)).toBeGreaterThan(620);
  await history.evaluate(element => { element.scrollTop = 2300; }); await page.waitForTimeout(100);
  const anchor = await history.evaluate(element => { const top = element.getBoundingClientRect().top; const row = [...element.querySelectorAll('[data-row-id]')].find(row => row.getBoundingClientRect().bottom > top + 1); return { id: row.dataset.rowId, offset: row.getBoundingClientRect().top - top }; });
  const difference = () => page.locator(`[data-row-id="${anchor.id}"]`).evaluate((row, anchor) => Math.abs(row.getBoundingClientRect().top - document.querySelector('.live-history').getBoundingClientRect().top - anchor.offset), anchor);
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(difference).toBeLessThanOrEqual(2);
  f.emit(segment(181)); await expect(page.getByRole('button', { name: '新しい会話 1件 · 最新へ戻る' })).toBeVisible();
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect.poll(difference).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(difference).toBeLessThanOrEqual(2); expect(f.connections).toBe(1);
  expect(await page.evaluate(() => testStreams.length === 1 && testStreams[0].getTracks().every(track => track.readyState === 'live'))).toBe(true);
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click();
  await expect(page.getByRole('button', { name: '残りを翻訳しています', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '全画面を終了', exact: true })).toBeVisible();
  expect(await page.evaluate(() => testStreams[0].getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  f.emit({ type: 'translation.finished' });
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/live-fullscreen-1920.png', fullPage: true });
  await page.getByRole('button', { name: '全画面を終了', exact: true }).click();
  await expect(page.getByRole('button', { name: '全画面表示', exact: true })).toBeFocused();
});

for (const method of ['unsupported', 'rejected']) test(`fullscreen ${method} uses accessible window expansion and compact natural typography`, async ({ page }) => {
  const f = await setup(page);
  await page.addInitScript(method => {
    if (method === 'unsupported') Object.defineProperty(document, 'fullscreenEnabled', { get: () => false });
    else Element.prototype.requestFullscreen = async () => { throw new DOMException('Rejected', 'NotAllowedError'); };
  }, method);
  await page.goto('/#live'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible(); f.emit(segment(1));
  await expect(page.locator('.live-pair')).toHaveCount(1);
  const styles = await page.locator('.live-source p').evaluate(element => { const style = getComputedStyle(element); return { letterSpacing: style.letterSpacing, ratio: parseFloat(style.lineHeight) / parseFloat(style.fontSize), font: style.fontFamily }; });
  expect(styles.letterSpacing).toBe('normal'); expect(styles.ratio).toBeCloseTo(1.65); expect(styles.font).toContain('Arial');
  await page.getByRole('button', { name: method === 'unsupported' ? '画面を広げる' : '全画面表示', exact: true }).click();
  await expect(page.locator('.live-window-expanded')).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement)).toBe(null);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 480 : 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const bounds = await page.getByRole('button', { name: '元の表示に戻る', exact: true }).boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/live-expanded-${method}-${width}.png`, fullPage: true });
  }
  await page.getByLabel('文字サイズ').selectOption('large');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.setViewportSize({ width: 320, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.keyboard.press('Escape'); await expect(page.locator('.live-window-expanded')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click();
});
