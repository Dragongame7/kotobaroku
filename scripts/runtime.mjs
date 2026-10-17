import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function findNemo() {
  if (process.env.NEMO_SPEECH_BIN) return process.env.NEMO_SPEECH_BIN;
  const directory = path.join(root, '.runtime', 'nemo');
  if (!existsSync(directory)) return null;
  const search = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isFile() && entry.name === 'nemo-speech.exe') return target;
      if (entry.isDirectory()) { const result = search(target); if (result) return result; }
    }
    return null;
  };
  return search(directory);
}
export async function reachable(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
