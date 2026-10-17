import { LLM_OPTIONS } from './config.mjs';

export async function modelPlacement({ ollamaUrl, model, signal, fetcher = fetch }) {
  try {
    const response = await fetcher(`${ollamaUrl}/api/ps`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
    const { models = [] } = await response.json();
    const resident = models.find(item => (item.name || item.model) === model);
    return { checkedAt: new Date().toISOString(), placement: resident?.size ? resident.size_vram >= resident.size * .95 ? 'gpu' : 'mixed' : 'unknown', digest: resident?.digest, size: resident?.size, gpuBytes: resident?.size_vram };
  } catch { return { checkedAt: new Date().toISOString(), placement: 'unknown' }; }
}

export async function structuredChat({ ollamaUrl, model, messages, format, signal, fetcher = fetch, timeoutMs = 3000, numPredict = 256 }) {
  const response = await fetcher(`${ollamaUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), body: JSON.stringify({ model, messages, format, stream: false, think: false, keep_alive: '10m', options: { ...LLM_OPTIONS, temperature: 0, num_predict: numPredict } }) });
  if (!response.ok) throw new Error(`LLM要求が失敗しました (${response.status})。`);
  const result = await response.json();
  if (result.error || result.done_reason === 'length') throw new Error(result.error || 'LLM出力が上限に達しました。');
  return JSON.parse(result.message?.content || '');
}
