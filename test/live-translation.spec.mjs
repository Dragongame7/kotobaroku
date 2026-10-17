import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const base = { sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' };
const caption = (id, changes = {}) => ({ ...base, id, revision: 1, source: `原文 ${id}`, translation: `Translation ${id}`, status: 'done', ...changes });
async function fixture(page, { finish = true, prepare = true } = {}) {
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: true, models: ['test:4b'] }, defaultModel: 'test:4b' } }));
  await page.addInitScript(() => {
    globalThis.testStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); globalThis.testStreams.push(stream); return stream; };
  });
  let emit, close, configured, connections = 0, canceled = false;
  await page.routeWebSocket('**/ws/translate', socket => {
    connections++;
    emit = event => socket.send(JSON.stringify(event)); close = () => socket.close({ code: 1006 });
    emit({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') return;
      const event = JSON.parse(message);
      if (event.type === 'session.update') { configured = event; if (prepare) emit({ type: 'session.updated' }); }
      if (event.type === 'translation.cancel') { canceled = true; emit({ type: 'translation.paused' }); emit({ type: 'translation.finished' }); }
      if (event.type === 'input_audio_buffer.commit') { emit({ type: 'input_audio_buffer.committed' }); if (finish) emit({ type: 'translation.finished' }); }
    });
  });
  return { emit: event => emit(event), close: () => close(), get configured() { return configured; }, get connections() { return connections; }, get canceled() { return canceled; } };
}
async function start(page) {
  await page.goto('/#live'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
}
const rows = page => page.locator('.live-pair');
const stopped = page => expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
const released = page => expect.poll(() => page.evaluate(() => testStreams.length > 0 && testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);

for (const direction of ['ja-JP', 'en-US']) test(`live pairs share revisions, settings, storage and chronological exports (${direction})`, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const f = await fixture(page, { finish: false });
  await page.addInitScript(() => { localStorage.setItem('kotoba.sentence-mode', 'context'); localStorage.setItem('kotoba.correction-mode', 'off'); });
  await page.goto('/#live');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.live-settings')).not.toHaveAttribute('open');
  await page.getByLabel('話す言語 → 訳す言語').selectOption(direction);
  await page.getByText('マイクと翻訳の設定', { exact: true }).click();
  await expect(page.getByLabel('訳すタイミング')).toHaveValue('context');
  await expect(page.getByLabel('日本語の誤変換補正', { exact: true }).filter({ visible: true })).toHaveValue('off');
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  expect(f.configured.session.language).toBe(direction); expect(f.configured.translation.sentenceMode).toBe('context');
  await expect(page.getByLabel('訳すタイミング')).toBeDisabled();
  await expect(page.getByRole('button', { name: '詳細画面を開く' })).toBeDisabled();
  await page.evaluate(() => { location.hash = '#translate'; });
  await expect(page).toHaveURL(/#live$/);
  f.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'A', translationSegmentId: null });
  await expect(rows(page)).toHaveCount(1);
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'A' });
  f.emit({ type: 'translation.segment', segment: caption(1, { source: 'A', translation: '', status: 'assembling', provisional: true }) });
  await expect(rows(page)).toHaveCount(1);
  f.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: ' continuation', translationSegmentId: 1 });
  await expect(rows(page)).toHaveCount(1); await expect(page.locator('.live-source')).toContainText('A continuation');
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' continuation' });
  f.emit({ type: 'translation.segment', segment: caption(1, { source: 'A continuation', revision: 2, translation: '', status: 'queued', provisional: true }) });
  f.emit({ type: 'translation.started', id: 1, revision: 2 });
  f.emit({ type: 'translation.delta', id: 1, revision: 2, delta: 'Draft A' });
  f.emit({ type: 'translation.completed', id: 1, revision: 2, provisional: true, text: 'Draft A' });
  await expect(rows(page)).toHaveCount(1); await expect(page.locator('.live-target')).toContainText('訳文を更新中');
  f.emit({ type: 'translation.segment', segment: caption(1, { source: 'A final', revision: 3, translation: 'Draft A', status: 'queued' }) });
  f.emit({ type: 'translation.segment', segment: caption(2, { source: 'B', status: 'queued' }) });
  f.emit({ type: 'translation.segment', segment: caption(3, { source: 'C', status: 'queued' }) });
  f.emit({ type: 'translation.completed', id: 3, revision: 1, text: 'Final C' });
  f.emit({ type: 'translation.completed', id: 2, revision: 1, text: 'Final B' });
  f.emit({ type: 'translation.completed', id: 1, revision: 3, text: 'Final A' });
  f.emit({ type: 'translation.completed', id: 1, revision: 2, text: 'STALE' });
  f.emit({ type: 'translation.delta', id: 1, revision: 2, delta: 'STALE' });
  await expect(rows(page)).toHaveCount(3); await expect(page.locator('.live-source p')).toHaveText(['C', 'B', 'A final']);
  await expect(page.locator('.live-target p')).toHaveText(['Final C', 'Final B', 'Final A']);
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click();
  await released(page);
  await expect(page.getByRole('button', { name: '残りを翻訳しています', exact: true })).toBeDisabled();
  f.emit({ type: 'translation.finished' }); await stopped(page);
  await page.getByRole('button', { name: '会話をコピー' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.indexOf('A final')).toBeLessThan(copied.indexOf('Final B')); expect(copied.indexOf('Final B')).toBeLessThan(copied.indexOf('Final C'));
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '会話を保存' }).click();
  const exported = await readFile(await (await downloading).path(), 'utf8'); expect(exported).toContain(copied.replace(/\r\n/g, '\n'));
  await page.getByRole('button', { name: '詳細画面を開く', exact: true }).click();
  await expect(page.locator('.caption-source > p')).toHaveText(['A final', 'B', 'C']);
  await page.getByRole('button', { name: 'ライブ翻訳', exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kotoba.translation') || '[]').map(row => row.source))).toEqual(['A final', 'B', 'C']);
  await page.reload(); await expect(page.locator('.live-source p')).toHaveText(['C', 'B', 'A final']);
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  f.emit({ type: 'translation.segment', segment: caption(1, { source: 'New session' }) });
  await expect(rows(page)).toHaveCount(4); await expect(page.locator('.live-source p').first()).toHaveText('New session');
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click(); f.emit({ type: 'translation.finished' }); await stopped(page);
});

test('15 minutes of deterministic events keep the reading anchor through prepends and growth', async ({ page }) => {
  const f = await fixture(page); await start(page);
  // 180 speech intervals at five seconds per interval; accelerated, without model inference.
  for (let id = 1; id <= 180; id++) {
    f.emit({ type: 'translation.segment', segment: caption(id, { source: `原文 ${id}。長い会話の確認です。`, status: 'queued', translation: '' }) });
    f.emit({ type: 'translation.started', id, revision: 1 });
    f.emit({ type: 'translation.delta', id, revision: 1, delta: `Translation ${id}.` });
    f.emit({ type: 'translation.completed', id, revision: 1, text: `Translation ${id}.` });
  }
  await expect(rows(page)).toHaveCount(180);
  const history = page.locator('.live-history');
  expect(await history.evaluate(element => element.scrollTop)).toBe(0);
  await history.evaluate(element => { element.scrollTop = 2300; });
  await expect.poll(() => history.evaluate(element => element.scrollTop)).toBeGreaterThan(24);
  // Allow the scroll handler to capture the row now being read.
  await page.waitForTimeout(100);
  const anchor = await history.evaluate(element => { const top = element.getBoundingClientRect().top; const row = [...element.querySelectorAll('[data-row-id]')].find(row => row.getBoundingClientRect().bottom > top + 1); return { id: row.dataset.rowId, top: row.getBoundingClientRect().top }; });
  const position = () => page.locator(`[data-row-id="${anchor.id}"]`).evaluate(element => element.getBoundingClientRect().top);
  f.emit({ type: 'translation.segment', segment: caption(181) });
  await expect(page.getByRole('button', { name: '新しい会話 1件 · 最新へ戻る' })).toBeVisible();
  await expect.poll(async () => Math.abs((await position()) - anchor.top)).toBeLessThanOrEqual(2);
  f.emit({ type: 'translation.started', id: 180, revision: 1 });
  for (let i = 0; i < 20; i++) f.emit({ type: 'translation.delta', id: 180, revision: 1, delta: 'Growing text above the reading position. '.repeat(5) });
  await expect(page.locator('.live-pair').nth(1)).toContainText('Growing text');
  await expect.poll(async () => Math.abs((await position()) - anchor.top)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: '新しい会話 1件 · 最新へ戻る' })).toBeVisible();
  await page.getByLabel('文字サイズ').selectOption('large');
  await expect.poll(async () => Math.abs((await position()) - anchor.top)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: '新しい会話 1件 · 最新へ戻る' }).click();
  await expect.poll(() => history.evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.getByRole('button', { name: /新しい会話 .*件/ })).toBeHidden();
  f.emit({ type: 'translation.segment', segment: caption(182) });
  await expect(page.locator('.live-source p').first()).toHaveText('原文 182');
  await expect.poll(() => history.evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click(); await stopped(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kotoba.translation') || '[]').length)).toBe(182);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kotoba.translation')));
  expect(stored.slice(0, 180).map(row => row.source)).toEqual(Array.from({ length: 180 }, (_, i) => `原文 ${i + 1}。長い会話の確認です。`));
  expect(new Set(stored.map(row => row.id)).size).toBe(182);
});

test('a failed translation keeps received text and retries only after stopping', async ({ page }) => {
  const f = await fixture(page); await start(page);
  f.emit({ type: 'translation.segment', segment: caption(1, { translation: '', status: 'queued' }) });
  f.emit({ type: 'translation.started', id: 1, revision: 1 });
  f.emit({ type: 'translation.delta', id: 1, revision: 1, delta: 'Received before failure' });
  f.emit({ type: 'translation.error', id: 1, revision: 1, error: 'Connection lost' });
  await expect(rows(page)).toHaveAttribute('data-status', 'error');
  await expect(page.locator('.live-target')).toContainText('この文を翻訳できませんでした');
  await expect(page.locator('.live-target p')).toHaveText('Received before failure');
  await expect(page.getByRole('button', { name: 'この文を再試行', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click(); await stopped(page);
  let reply;
  await page.route('**/api/translate', route => { reply = () => route.fulfill({ status: 503, json: { error: 'Service unavailable' } }); });
  await page.getByRole('button', { name: 'この文を再試行', exact: true }).click();
  await expect(page.getByRole('button', { name: '再翻訳を中断' })).toBeVisible();
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '詳細画面を開く' })).toBeDisabled();
  await expect.poll(() => Boolean(reply)).toBe(true); await reply();
  await stopped(page); await expect(rows(page)).toHaveAttribute('data-status', 'error');
  await expect(page.locator('.live-target p')).toHaveText('Received before failure');
  await expect(page.locator('.live-source p')).toHaveText('原文 1');
});

test('preparation cancel, draining cancel, retry and disconnect preserve speech and release microphone', async ({ page }) => {
  const f = await fixture(page, { prepare: false, finish: false });
  await page.goto('/#live'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect.poll(() => f.connections).toBe(1);
  await page.getByRole('button', { name: '準備を中止' }).click(); await stopped(page); await released(page);
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect.poll(() => f.connections).toBe(2); f.emit({ type: 'session.updated' });
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  f.emit({ type: 'translation.segment', segment: caption(1, { status: 'translating', translation: 'Unfinished' }) });
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click(); await released(page);
  await page.getByRole('button', { name: '残りの翻訳を中断' }).click(); await stopped(page); expect(f.canceled).toBe(true);
  await expect(rows(page)).toHaveAttribute('data-status', 'canceled'); await expect(rows(page)).toContainText('Unfinished');
  await page.route('**/api/translate', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ done: true, text: 'Retried' }) + '\n' }));
  await page.getByRole('button', { name: 'この文を再試行', exact: true }).click();
  await expect(rows(page)).toHaveAttribute('data-status', 'done');
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect.poll(() => f.connections).toBe(3); f.emit({ type: 'session.updated' });
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  f.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: '切断前の途中文字', translationSegmentId: null });
  await expect(rows(page)).toHaveCount(2); f.close(); await stopped(page); await released(page);
  await expect(page.locator('.live-source p').first()).toHaveText('切断前の途中文字');
  await expect(page.locator('.live-pair').first()).toHaveAttribute('data-status', 'canceled');
  await expect(page.getByRole('alert')).toContainText('接続');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kotoba.translation') || '[]').length)).toBe(2);
  await page.reload(); await expect(rows(page)).toHaveCount(2);
  await page.getByLabel('話す言語 → 訳す言語').selectOption('en-US');
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect.poll(() => f.connections).toBe(4); f.emit({ type: 'session.updated' });
  await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible();
  f.emit({ type: 'translation.segment', segment: caption(1, { source: 'The meeting', translation: '', sourceLanguage: 'en-US', targetLanguage: 'ja-JP', status: 'assembling', provisional: true }) });
  f.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'starts', translationSegmentId: 1 });
  await expect(rows(page)).toHaveCount(3); f.close(); await stopped(page); await released(page);
  await expect(page.locator('.live-source p').first()).toHaveText('The meeting starts');
});

test('old drafts restore as interrupted; retry keeps order and raw correction data survives export', async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem('kotoba.translation', JSON.stringify([
    { id: 'old:1', revision: 1, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'old-model', source: '選択します', rawSource: '選択します', translation: 'Draft', status: 'draft', provisional: true, correction: { status: 'applied', correctedSource: '洗濯します', edits: [{ from: '選択', to: '洗濯' }] }, translationInput: { text: '洗濯します', origin: 'corrected' } },
    { id: 'old:2', source: '新しい原文', translation: 'Newer', status: 'done', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' },
  ])));
  await page.goto('/#live'); await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.live-source p').last()).toHaveText('選択します');
  await expect(page.locator('.live-pair').last()).toHaveAttribute('data-status', 'canceled');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '会話を保存' }).click();
  const saved = await readFile(await (await download).path(), 'utf8'); expect(saved).toContain('補正後: 洗濯します'); expect(saved).toContain('仮訳');
  await page.route('**/api/translate', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ done: true, text: 'Clean' }) + '\n' }));
  await page.getByRole('button', { name: 'この文を再試行', exact: true }).click();
  await expect(page.locator('.live-target p')).toHaveText(['Newer', 'Clean']);
  await page.getByRole('button', { name: '会話を空にする' }).click(); await expect(rows(page)).toHaveCount(0);
});

for (const failure of ['NotAllowedError', 'NotFoundError']) test(`microphone ${failure} gives an actionable message`, async ({ page }) => {
  await fixture(page);
  await page.addInitScript(name => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('failure', name); }; }, failure);
  await page.goto('/#live'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click(); await stopped(page);
  await expect(page.getByRole('alert')).toContainText(failure === 'NotAllowedError' ? '許可' : '接続を確認');
});

test('long speech, text zoom, keyboard, storage failure and narrow screens remain usable', async ({ page }) => {
  const f = await fixture(page); await start(page);
  f.emit({ type: 'translation.segment', segment: caption(1, { source: '長い原文。'.repeat(80), translation: 'Averylongunbrokentranslation'.repeat(80) }) });
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel('文字サイズ').selectOption('large');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const bounds = await page.getByRole('button', { name: '翻訳を終了', exact: true }).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/live-${width}.png`, fullPage: true });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.setViewportSize({ width: 320, height: 960 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('.live-settings summary').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.live-settings')).toHaveAttribute('open');
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'kotoba.translation') throw new DOMException('Quota exceeded', 'QuotaExceededError'); return original.call(this, key, value); }; });
  f.emit({ type: 'translation.segment', segment: caption(2) });
  await expect(page.getByRole('alert')).toContainText('ブラウザに保存できません');
  await page.getByRole('button', { name: '翻訳を終了', exact: true }).click(); await stopped(page);
  await expect(page.getByRole('button', { name: '会話を保存' })).toBeVisible();
});

for (const [direction, file] of [['ja-JP', 'test-speech.wav'], ['en-US', 'test-speech-en.wav']]) test.describe(`real live view ${direction}`, () => {
  test('virtual microphone reaches final translation and releases the service', async ({ playwright, baseURL }) => {
    test.setTimeout(360000);
    test.skip(!process.env.KOTOBA_TRANSLATION_LIVE || !existsSync(`.runtime/${file}`), 'Requires running Nemotron/Gemma and synthetic speech.');
    const browser = await playwright.chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.cwd()}/.runtime/${file}`] });
    try {
    const context = await browser.newContext({ baseURL }); const page = await context.newPage();
    await page.goto('/#live'); await page.getByLabel('話す言語 → 訳す言語').selectOption(direction);
    await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
    await expect(page.getByRole('button', { name: '翻訳を終了', exact: true })).toBeVisible({ timeout: 210000 });
    const wav = await readFile(`.runtime/${file}`);
    let cursor = 12, audioBytes = 0;
    while (cursor + 8 <= wav.length) { const size = wav.readUInt32LE(cursor + 4); if (wav.toString('ascii', cursor, cursor + 4) === 'data') { audioBytes = size; break; } cursor += 8 + size + size % 2; }
    expect(audioBytes).toBeGreaterThan(0);
    await page.waitForTimeout(Math.ceil(audioBytes / 32) + 1200); // 16 kHz mono PCM16, one complete spoken fixture.
    await expect(page.locator('.live-pair[data-status="done"]').first()).toBeVisible({ timeout: 120000 });
    await expect(page.locator('.live-pair[data-status="done"] .live-target p').first()).toContainText(direction === 'ja-JP' ? /[a-z]/i : /[\u3040-\u9fff]/);
    await page.getByRole('button', { name: '翻訳を終了', exact: true }).click();
    await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled({ timeout: 120000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    const health = await (await page.request.get('/api/health')).json();
    expect(health.translating).toBe(false); expect(health.recording).toBe(false);
    await page.screenshot({ path: `test-results/live-real-${direction}.png`, fullPage: true });
    } finally { await browser.close(); }
  });
});
