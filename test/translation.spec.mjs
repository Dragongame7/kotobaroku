import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

async function mockHealth(page) {
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: true, models: ['test:4b'] }, defaultModel: 'test:4b', whisper: { ready: true } } }));
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    globalThis.testStreams = [];
    navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); globalThis.testStreams.push(stream); return stream; };
  });
}

for (const direction of ['ja-JP', 'en-US']) {
  test(`translation UI streams, stops, retries and saves (${direction})`, async ({ page }) => {
    await mockHealth(page); let configured;
    await page.routeWebSocket('**/ws/translate', socket => {
      const send = event => socket.send(JSON.stringify(event));
      let emitted = false;
      send({ type: 'session.created' });
      socket.onMessage(message => {
        if (typeof message !== 'string') {
          if (emitted) return; emitted = true;
          send({ type: 'translation.segment', segment: { id: 1, source: direction === 'ja-JP' ? 'こんにちは。' : 'Hello.', translation: '', status: 'queued', sourceLanguage: direction, targetLanguage: direction === 'ja-JP' ? 'en-US' : 'ja-JP', model: 'test:4b', boundary: direction === 'ja-JP' ? 'length' : 'time' } });
          send({ type: 'translation.started', id: 1 }); send({ type: 'translation.delta', id: 1, delta: direction === 'ja-JP' ? 'Hello.' : 'こんにちは。' }); send({ type: 'translation.completed', id: 1, text: direction === 'ja-JP' ? 'Hello.' : 'こんにちは。' });
          send({ type: 'translation.segment', segment: { id: 2, source: '15:00', translation: '', status: 'error', error: 'テスト用の接続失敗', sourceLanguage: direction, targetLanguage: direction === 'ja-JP' ? 'en-US' : 'ja-JP', model: 'test:4b' } });
          return;
        }
        const event = JSON.parse(message);
        if (event.type === 'session.update') { configured = event; send({ type: 'translation.ready' }); send({ type: 'session.updated' }); }
        if (event.type === 'input_audio_buffer.commit') { send({ type: 'input_audio_buffer.committed' }); setTimeout(() => { send({ type: 'translation.finished' }); void socket.close({ code: 1000 }); }, 100); }
      });
    });
    let retried;
    await page.route('**/api/translate', route => { retried = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ delta: '3 PM' }) + '\n' + JSON.stringify({ done: true, text: '3 PM' }) + '\n' }); });
    await page.goto('/#translate');
    await page.getByLabel('翻訳方向', { exact: true }).selectOption(direction);
    const sentenceMode = direction === 'ja-JP' ? 'speed' : 'context';
    await expect(page.getByLabel('文章の区切り方', { exact: true })).toHaveValue('balanced');
    await expect(page.getByLabel('文章の区切り方', { exact: true }).locator('option')).toHaveCount(3);
    await page.getByLabel('文章の区切り方', { exact: true }).selectOption(sentenceMode);
    await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
    await expect(page.locator('.caption-row[data-status="done"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible();
    expect(configured.session.language).toBe(direction); expect(configured.translation.targetLanguage).toBe(direction === 'ja-JP' ? 'en-US' : 'ja-JP');
    expect(configured.translation.sentenceMode).toBe(sentenceMode);
    await expect(page.getByLabel('文章の区切り方', { exact: true })).toBeDisabled();
    const reason = direction === 'ja-JP' ? '文字数の上限で区切りました。' : '待ち時間の上限で区切りました。';
    await expect(page.locator('.caption-target').first()).toContainText(reason);
    await page.getByRole('button', { name: '録音を停止', exact: true }).click();
    await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => globalThis.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    await page.getByRole('button', { name: 'この文を再試行', exact: true }).click();
    await expect(page.locator('.caption-row[data-status="done"]')).toHaveCount(2);
    expect(retried.text).toBe('15:00'); expect(retried.sourceLanguage).toBe(direction);
    if (direction === 'ja-JP') {
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 960 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        const button = await page.getByRole('button', { name: '翻訳を開始', exact: true }).boundingBox();
        expect(button.x).toBeGreaterThanOrEqual(0); expect(button.x + button.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `test-results/translation-${width}.png`, fullPage: true });
      }
    }
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '原文・訳文を保存', exact: true }).click(); const saved = await download; expect(saved.suggestedFilename()).toMatch(/\.md$/);
    expect(await readFile(await saved.path(), 'utf8')).toContain(reason);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kotoba.translation') || '[]').filter(row => row.status === 'done').length)).toBe(2);
    await page.reload(); await expect(page.locator('.caption-row[data-status="done"]')).toHaveCount(2);
    await expect(page.getByLabel('文章の区切り方', { exact: true })).toHaveValue(sentenceMode);
  });
}

test('translation cancellation keeps the microphone and later source captions active', async ({ page }) => {
  await mockHealth(page);
  await page.routeWebSocket('**/ws/translate', socket => {
    const send = event => socket.send(JSON.stringify(event)); let emitted = false;
    send({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') {
        if (!emitted) { emitted = true; send({ type: 'translation.segment', segment: { id: 1, source: '最初の原文', translation: '', status: 'queued', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' } }); send({ type: 'translation.started', id: 1 }); }
        return;
      }
      const event = JSON.parse(message);
      if (event.type === 'session.update') send({ type: 'session.updated' });
      if (event.type === 'translation.cancel') { send({ type: 'translation.paused' }); send({ type: 'translation.error', id: 1, canceled: true, error: '中断しました' }); send({ type: 'translation.segment', segment: { id: 2, source: '中断しても文字起こしは続きます', translation: '', status: 'canceled', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' } }); }
      if (event.type === 'input_audio_buffer.commit') { send({ type: 'input_audio_buffer.committed' }); send({ type: 'translation.finished' }); void socket.close({ code: 1000 }); }
    });
  });
  await page.goto('/#translate'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.locator('.caption-row')).toHaveCount(1);
  await page.getByRole('button', { name: '翻訳だけ中断', exact: true }).click();
  await expect(page.getByText('中断しても文字起こしは続きます', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'この文を再試行', exact: true })).toHaveCount(2);
});

test('canceling model preparation stops the microphone and permits another start', async ({ page }) => {
  await mockHealth(page);
  await page.routeWebSocket('**/ws/translate', socket => { socket.send(JSON.stringify({ type: 'session.created' })); socket.onMessage(() => {}); });
  await page.goto('/#translate'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await page.getByRole('button', { name: '準備を中止', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => globalThis.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('sentence captions update in place, label drafts and discard old translation revisions', async ({ page }) => {
  await mockHealth(page); let emit;
  await page.routeWebSocket('**/ws/translate', socket => {
    emit = event => socket.send(JSON.stringify(event));
    emit({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') return;
      const event = JSON.parse(message);
      if (event.type === 'session.update') emit({ type: 'session.updated' });
      if (event.type === 'input_audio_buffer.commit') { emit({ type: 'input_audio_buffer.committed' }); emit({ type: 'translation.finished' }); void socket.close({ code: 1000 }); }
    });
  });
  await page.goto('/#translate'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible();
  const base = { id: 1, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' };
  emit({ type: 'translation.segment', segment: { ...base, revision: 1, source: '明日の会議は', translation: '', status: 'assembling', provisional: true } });
  await expect(page.locator('.caption-row[data-status="assembling"]')).toHaveCount(1);
  await expect(page.getByText('文の続きを確認しています。', { exact: true })).toBeVisible();
  emit({ type: 'translation.started', id: 1, revision: 1 });
  emit({ type: 'translation.completed', id: 1, revision: 1, provisional: true, text: 'Tomorrow’s meeting…' });
  await expect(page.locator('.caption-row[data-status="draft"]')).toHaveCount(1);
  emit({ type: 'translation.segment', segment: { ...base, revision: 2, source: '明日の会議は午後3時からです。', translation: 'Tomorrow’s meeting…', status: 'assembling', provisional: true } });
  emit({ type: 'translation.completed', id: 1, revision: 1, text: 'STALE TEXT' });
  emit({ type: 'translation.delta', id: 1, revision: 1, delta: 'STALE DELTA' });
  await expect(page.locator('.caption-row')).toHaveCount(1);
  await expect(page.locator('.caption-target')).not.toContainText('STALE');
  await expect(page.locator('.caption-target')).toContainText('仮訳');
  emit({ type: 'translation.segment', segment: { ...base, revision: 3, source: '明日の会議は午後3時からです。', translation: '', status: 'queued', provisional: false } });
  emit({ type: 'translation.started', id: 1, revision: 3 });
  emit({ type: 'translation.completed', id: 1, revision: 3, provisional: false, text: 'Tomorrow’s meeting starts at 3 PM.' });
  await expect(page.locator('.caption-row[data-status="done"]')).toHaveCount(1);
  await expect(page.locator('.caption-target')).toContainText('確定');
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kotoba.translation') || '[]').length)).toBe(1);
  await page.setViewportSize({ width: 375, height: 960 });
  await page.screenshot({ path: 'test-results/sentence-translation.png', fullPage: true });
});

test('unfinished sentence and draft restore with their original text and a retry action', async ({ page }) => {
  await mockHealth(page);
  await page.addInitScript(() => localStorage.setItem('kotoba.translation', JSON.stringify([
    { id: 'saved:1', revision: 1, source: '明日の会議は', translation: 'Tomorrow’s meeting…', status: 'draft', provisional: true, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' },
    { id: 'saved:2', revision: 2, source: '次の予定は', translation: '', status: 'assembling', provisional: true, sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' },
  ])));
  await page.goto('/#translate');
  await expect(page.locator('.caption-row[data-status="canceled"]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'この文を再試行', exact: true })).toHaveCount(2);
  await expect(page.locator('.caption-target').first()).toContainText('仮訳');
  await expect(page.getByText('明日の会議は', { exact: true })).toBeVisible();
});

test('new caption rows, partial speech and growing translations scroll to the latest content', async ({ page }) => {
  await mockHealth(page); let emit;
  await page.routeWebSocket('**/ws/translate', socket => {
    emit = event => socket.send(JSON.stringify(event)); emit({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') return;
      const event = JSON.parse(message);
      if (event.type === 'session.update') emit({ type: 'session.updated' });
      if (event.type === 'input_audio_buffer.commit') { emit({ type: 'input_audio_buffer.committed' }); emit({ type: 'translation.finished' }); void socket.close({ code: 1000 }); }
    });
  });
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto('/#translate'); await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible();
  for (let id = 1; id <= 15; id++) emit({ type: 'translation.segment', segment: { id, revision: 1, source: `新しい文章 ${id}。`, translation: '', status: 'queued', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'test:4b' } });
  const atBottom = () => page.locator('.caption-list').evaluate(element => element.scrollHeight > element.clientHeight && element.scrollHeight - element.clientHeight - element.scrollTop < 3);
  await expect.poll(atBottom).toBe(true);
  // Move away from the bottom and ensure a streaming update follows it again.
  await page.locator('.caption-list').evaluate(element => { element.scrollTop = 0; });
  emit({ type: 'translation.started', id: 15, revision: 1 });
  emit({ type: 'translation.delta', id: 15, revision: 1, delta: 'A growing translation. '.repeat(70) });
  await expect.poll(atBottom).toBe(true);
  emit({ type: 'conversation.item.input_audio_transcription.delta', delta: '次に話している文章'.repeat(35) });
  await expect(page.locator('.caption-partial')).toHaveCount(1);
  await expect.poll(atBottom).toBe(true);
  await expect.poll(async () => (await page.locator('.caption-end').boundingBox()).y < 760).toBe(true);
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
});

test('shared Gemma model is fixed and explicit offline comparison remains available', async ({ page }) => {
  await mockHealth(page);
  const models = [
    { model: 'translategemma:4b', label: 'TranslateGemma 4B', profile: 'translategemma', installed: true },
    { model: 'hy-mt2:1.8b', label: 'Hy-MT2 1.8B · Q4', profile: 'hy-mt', installed: true },
    { model: 'test:4b', label: 'Qwen baseline', profile: 'general', installed: true },
  ];
  await page.unroute('**/api/health');
  await page.route('**/api/health', route => route.fulfill({ json: { asr: { ready: true }, ollama: { ready: true, models: models.map(item => item.model) }, defaultModel: 'test:4b', translation: { models, defaultModel: 'test:4b', boundaryModel: 'test:4b' } } }));
  let configured, compareInput;
  await page.routeWebSocket('**/ws/translate', socket => {
    const send = event => socket.send(JSON.stringify(event)); let emitted = false;
    send({ type: 'session.created' });
    socket.onMessage(message => {
      if (typeof message !== 'string') {
        if (!emitted) {
          emitted = true;
          send({ type: 'translation.segment', segment: { id: 1, revision: 1, source: '会議は15時です。', translation: '', status: 'queued', sourceLanguage: 'ja-JP', targetLanguage: 'en-US', model: 'hy-mt2:1.8b', profile: 'hy-mt' } });
          send({ type: 'translation.completed', id: 1, revision: 1, text: 'The meeting is at 3 PM.' });
        }
        return;
      }
      const event = JSON.parse(message);
      if (event.type === 'session.update') { configured = event; send({ type: 'translation.ready', boundaryMode: 'rules', notice: 'GPU常駐を確認できないためルール判定に切り替えました。' }); send({ type: 'session.updated' }); }
      if (event.type === 'input_audio_buffer.commit') { send({ type: 'input_audio_buffer.committed' }); send({ type: 'translation.finished' }); void socket.close({ code: 1000 }); }
    });
  });
  await page.route('**/api/translate/compare', route => {
    compareInput = route.request().postDataJSON();
    return route.fulfill({ contentType: 'application/x-ndjson', body: models.flatMap(item => [{ type: 'model.started', model: item.model }, { type: 'result', model: item.model, index: 0, source: compareInput.items[0].text, warmMs: 10, result: { text: `${item.label}: Meeting at 3 PM.`, firstTokenMs: 50, elapsedMs: 80 }, residency: { gpuBytes: 2 * 1024 ** 3, fullyOnGpu: true } }]).concat({ type: 'done' }).map(JSON.stringify).join('\n') + '\n' });
  });
  await page.goto('/#translate');
  await expect(page.getByLabel('翻訳モデル', { exact: true })).toHaveValue('test:4b');
  await expect(page.getByLabel('翻訳モデル', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('整形・要約に使うAI')).toHaveValue('test:4b');
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.locator('.caption-row[data-status="done"]')).toHaveCount(1);
  expect(configured.translation.model).toBe('test:4b'); expect(configured.translation.boundaryMode).toBe('llm');
  await expect(page.getByLabel('文末判定', { exact: true })).toHaveValue('rules');
  await expect(page.getByText('GPU常駐を確認できないためルール判定に切り替えました。')).toBeVisible();
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await page.getByText('翻訳モデルを比較', { exact: true }).click();
  await page.getByRole('button', { name: '直近の原文で比較', exact: true }).click();
  await expect(page.locator('.translation-bench-result')).toHaveCount(3);
  expect(compareInput.models).toEqual(models.map(item => item.model)); expect(compareInput.items[0].text).toBe('会議は15時です。');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: `test-results/dedicated-models-${width}.png`, fullPage: true });
  }
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '比較結果を保存', exact: true }).click(); expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await page.reload(); await expect(page.getByLabel('翻訳モデル', { exact: true })).toHaveValue('test:4b');
});

for (const liveModel of ['gemma4:latest']) test(`real microphone pipeline produces translations before recording stops (${liveModel})`, async ({ page }) => {
  test.skip(!process.env.KOTOBA_TRANSLATION_LIVE || !existsSync('.runtime/test-speech.wav'), 'Requires Nemotron, Ollama and synthetic test speech.');
  await page.goto('/#translate');
  await expect(page.getByLabel('翻訳モデル', { exact: true })).toHaveValue(liveModel, { timeout: 15000 });
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled({ timeout: 15000 });
  await page.getByRole('button', { name: '翻訳を開始', exact: true }).click();
  await expect(page.locator('.caption-row[data-status="done"]').first()).toBeVisible({ timeout: 100000 });
  await expect(page.getByRole('button', { name: '録音を停止', exact: true })).toBeVisible();
  await expect(page.locator('.caption-target').first()).toContainText(/[a-z]/i);
  await page.getByRole('button', { name: '録音を停止', exact: true }).click();
  await expect(page.getByRole('button', { name: '翻訳を開始', exact: true })).toBeEnabled({ timeout: 70000 });
  await expect(page.locator('.caption-row[data-status="error"]')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await (await page.request.get('/api/health')).json()).translating).toBe(false);
  await page.screenshot({ path: 'test-results/translation-live.png', fullPage: true });
});
