import { translateText, validateTranslation, warmTranslation } from './translation.mjs';
import { prepareTranslationMemory } from './translation-memory.mjs';

export function validateTranslationComparison(input) {
  if (!Array.isArray(input?.models) || !input.models.length || input.models.length > 3 || new Set(input.models.map(model => String(model).toLowerCase())).size !== input.models.length) throw new Error('比較する翻訳モデルは重複のない1〜3件を指定してください。');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5) throw new Error('比較する原文は1〜5文を指定してください。');
  for (const model of input.models) validateTranslation({ model, sourceLanguage: 'ja-JP', targetLanguage: 'en-US' });
  const items = input.items.map(item => {
    const checked = validateTranslation({ ...item, model: input.models[0], context: [] });
    if (!checked.text) throw new Error('比較する原文がありません。');
    return { text: checked.text, sourceLanguage: checked.sourceLanguage, targetLanguage: checked.targetLanguage };
  });
  return { models: input.models, items };
}

export async function compareTranslations({ models, items, ollamaUrl, signal, emit, fetcher = fetch }) {
  // Freeze the same ASR text and disable conversational context for every model.
  for (const model of models) {
    if (signal.aborted) throw new Error('比較を中断しました。');
    emit({ type: 'model.started', model });
    let warmMs;
    try {
      await prepareTranslationMemory({ ollamaUrl, model, reloadPartial: true, signal, fetcher });
      const start = performance.now(); await warmTranslation({ ollamaUrl, model, signal, fetcher }); warmMs = Math.round(performance.now() - start);
    } catch (error) {
      if (signal.aborted) throw error;
      emit({ type: 'model.error', model, error: error.message }); continue;
    }
    for (const [index, item] of items.entries()) {
      if (signal.aborted) throw new Error('比較を中断しました。');
      try {
        const result = await translateText({ ...item, model, context: [], ollamaUrl, signal, fetcher });
        let residency = null;
        try {
          const response = await fetcher(`${ollamaUrl}/api/ps`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
          const data = await response.json();
          const resident = data.models?.find(entry => (entry.name || entry.model || '').toLowerCase() === model.toLowerCase());
          if (resident) residency = { digest: resident.digest, modelBytes: resident.size, gpuBytes: resident.size_vram, fullyOnGpu: Number.isFinite(resident.size) && Number.isFinite(resident.size_vram) ? resident.size_vram >= resident.size * .95 : null };
        } catch { /* Timing and text remain useful when residency is unavailable. */ }
        emit({ type: 'result', model, index, source: item.text, sourceLanguage: item.sourceLanguage, targetLanguage: item.targetLanguage, result, warmMs, residency });
      } catch (error) {
        if (signal.aborted) throw error;
        emit({ type: 'result.error', model, index, source: item.text, error: error.message });
      }
    }
  }
}
