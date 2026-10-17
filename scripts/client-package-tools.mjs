import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const NODE_VERSION = '24.22.0';
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;

export function powershell(script, env) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script], { env: { ...process.env, ...env }, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('配布ファイルの展開・圧縮に失敗しました。');
}
export function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('配布ファイルにシンボリックリンクを含められません：' + full);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}
export function removeTemporary(directory, parent) {
  const resolved = path.resolve(directory), base = path.resolve(parent);
  if (!resolved.startsWith(base + path.sep)) throw new Error('一時ファイルの削除対象が作業領域外です。');
  fs.rmSync(resolved, { recursive: true, force: true });
}
