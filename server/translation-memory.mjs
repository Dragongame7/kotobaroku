import { dedicatedModels, hyMtSource } from './translation-models.mjs';

export async function prepareTranslationMemory({ ollamaUrl, model, boundaryModel = model, reloadPartial = false, signal, fetcher = fetch }) {
  try {
    const response = await fetcher(`${ollamaUrl}/api/ps`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
    const data = await response.json();
    const managed = [...dedicatedModels.map(item => item.model), hyMtSource].map(name => name.toLowerCase());
    for (const resident of data.models || []) {
      const name = resident.name || resident.model;
      if (typeof name !== 'string') continue;
      const inactiveManaged = managed.includes(name.toLowerCase()) && ![model.toLowerCase(), boundaryModel.toLowerCase()].includes(name.toLowerCase());
      // A model left partly on CPU by a previous comparison must be reloaded
      // after freeing the other candidates, or benchmark order biases its time.
      const partialSelected = reloadPartial && name.toLowerCase() === model.toLowerCase() && resident.size && resident.size_vram < resident.size * .95;
      if (inactiveManaged || partialSelected) {
        const unloaded = await fetcher(`${ollamaUrl}/api/generate`, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }) });
        await unloaded.arrayBuffer();
      }
    }
  } catch (error) { if (signal.aborted) throw error; }
}
