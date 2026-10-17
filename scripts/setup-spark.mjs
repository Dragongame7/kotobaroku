import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, findNemo } from './runtime.mjs';

if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('この導入処理はDGX SparkのLinux Arm64向けです。');
const major = process.env.SPARK_CUDA_MAJOR;
if (!['12', '13'].includes(major)) throw new Error('Sparkのドライバーを確認し、SPARK_CUDA_MAJOR=12 または13を指定してください。');
const version = '0.2.0', name = `nemo-speech-${version}-linux-aarch64-cuda${major}.tar.gz`;
const directory = path.join(root, '.runtime'), destination = path.join(directory, 'nemo');
await fs.mkdir(destination, { recursive: true });
if (!findNemo()) {
  const url = `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${version}/${name}`;
  const response = await fetch(url), checksumResponse = await fetch(url + '.sha256');
  if (!response.ok || !checksumResponse.ok) throw new Error('公式ランタイムと検証用ハッシュを取得できません。');
  const archive = path.join(directory, name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const actual = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  if (!(await checksumResponse.text()).toLowerCase().split(/\s+/).includes(actual)) throw new Error('ランタイムのSHA256が一致しません。');
  if (spawnSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' }).status !== 0) throw new Error('音声ランタイムを展開できません。');
}
const binary = findNemo();
if (!binary) throw new Error('音声実行ファイルが見つかりません。');
const env = { ...process.env, NEMO_SPEECH_MODEL_DIR: process.env.NEMO_SPEECH_MODEL_DIR || path.join(directory, 'models') };
for (const model of ['nemotron-3.5', 'nemotron-3-diarization']) {
  if (spawnSync(binary, ['pull', model], { env, stdio: 'inherit' }).status !== 0) throw new Error(`モデルの準備に失敗しました：${model}`);
}
const inventory = spawnSync(binary, ['--json', 'model', 'list'], { env, encoding: 'utf8' });
if (inventory.status !== 0) throw new Error('モデルの配備記録を取得できません。');
const manifest = { runtime: `NeMo-Speech.cpp ${version}`, platform: process.platform, arch: process.arch, cudaMajor: major, preparedAt: new Date().toISOString(), models: JSON.parse(inventory.stdout).models.filter(item => ['nvidia/Nemotron-3-Diarization', 'nvidia/nemotron-3.5-asr-streaming-0.6b'].includes(item.repo)) };
await fs.writeFile(path.join(directory, 'spark-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('ASRと話者分離を準備しました。配備手順に従ってGPU動作とLLM同居性能を確認してください。');
