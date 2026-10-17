import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from './runtime.mjs';

const directory = path.join(root, '.runtime', 'whisper');
await mkdir(directory, { recursive: true });
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function download(url, target, sha256) {
  if (existsSync(target) && await digest(target) === sha256) return;
  console.log(`Downloading ${path.basename(target)}…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target + '.part'));
  if (await digest(target + '.part') !== sha256) throw new Error('SHA-256 mismatch');
  await rename(target + '.part', target);
  console.log(`SHA-256 verified: ${path.basename(target)}`);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Automatic installation supports Windows x64. Set WHISPER_BIN and WHISPER_MODEL for another installation.');
const archive = path.join(directory, 'whisper-cuda-v1.9.2.zip');
await download('https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-cublas-11.8.0-bin-x64.zip', archive, '1776668730f5594a0b15f930225779e863dd8280397f9ee7c6e47ccf82bbb203');
const unpack = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:KOTOBA_ARCHIVE -DestinationPath $env:KOTOBA_DESTINATION -Force'], { env: { ...process.env, KOTOBA_ARCHIVE: archive, KOTOBA_DESTINATION: path.join(directory, 'bin') }, windowsHide: true, stdio: 'inherit' });
if (unpack.status !== 0) throw new Error('Failed to extract whisper.cpp');
await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3.bin', path.join(directory, 'ggml-large-v3.bin'), '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2');
console.log('Whisper large-v3 (FP16) is ready. Restart the app.');
