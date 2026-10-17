import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, findNemo } from './runtime.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') { throw new Error('自動導入はWindows x64向けです。NEMO_SPEECH_BINで導入済みの実行ファイルを指定してください。'); }
const version = '0.2.0';
const name = `nemo-speech-${version}-windows-x86_64-cuda.zip`;
const directory = path.join(root, '.runtime');
await mkdir(directory, { recursive: true });
if (!findNemo()) {
  const archive = path.join(directory, name);
  const url = `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${version}/${name}`;
  console.log('公式CUDAランタイムをダウンロードしています…');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ダウンロード失敗: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const checksumResponse = await fetch(`${url}.sha256`);
  if (!checksumResponse.ok) throw new Error('チェックサムを取得できません。');
  const checksum = await checksumResponse.text();
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (!checksum.toLowerCase().includes(actual)) throw new Error('SHA256が一致しません。');
  const destination = path.join(directory, 'nemo');
  // Paths are data in environment variables, never interpolated shell source.
  const unpack = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:KOTOBA_ARCHIVE -DestinationPath $env:KOTOBA_DESTINATION -Force'], { env: { ...process.env, KOTOBA_ARCHIVE: archive, KOTOBA_DESTINATION: destination }, stdio: 'inherit', windowsHide: true });
  if (unpack.status !== 0) throw new Error('展開に失敗しました。');
}
console.log('Nemotron 3.5 ASR（約707MiB）を準備します。初回のみダウンロードします。');
const pull = spawnSync(findNemo(), ['pull', 'nemotron-3.5'], { stdio: 'inherit', windowsHide: true });
if (pull.status !== 0) throw new Error('モデルを準備できませんでした。');
console.log('準備完了。npm run build と npm start で起動できます。');
