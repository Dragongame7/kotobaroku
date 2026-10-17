export function ollamaBaseUrl(env = process.env) {
  if (env.OLLAMA_URL) return env.OLLAMA_URL.replace(/\/$/, '');
  const host = env.OLLAMA_HOST;
  if (!host) return 'http://127.0.0.1:11434';
  const url = new URL(host.includes('://') ? host : `http://${host}`);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
  return url.origin;
}
export const DEFAULT_MODEL = 'gemma4:latest';
export const LLM_OPTIONS = Object.freeze({ num_ctx: 4096 });
export function configuredModel(env = process.env) { return env.OLLAMA_MODEL || DEFAULT_MODEL; }
export function requireSessionModel(model, configured) {
  if (model !== undefined && model !== configured) throw new Error(`使用モデルは ${configured} に統一されています。画面を再読み込みしてください。`);
  return configured;
}

