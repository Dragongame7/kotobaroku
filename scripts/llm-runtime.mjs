import path from 'node:path';
import { LlmSettings } from '../server/llm-settings.mjs';
import { root } from './runtime.mjs';

export function scriptLlm({ ollamaOnly = false } = {}) {
  try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = new LlmSettings({ file: path.join(root, '.local', 'llm-settings.json') });
  if (settings.error) throw new Error(settings.error);
  if (ollamaOnly && settings.current.provider !== 'ollama') throw new Error('このスクリプトはOllama専用です。外部接続のモデル配備・管理は接続先で行ってください。');
  return { ollamaUrl: settings.current.baseUrl, model: settings.current.model, fetcher: settings.transport(), provider: settings.current.provider };
}
