import { spawnSync } from 'node:child_process';
import { findNemo } from './runtime.mjs';
const binary = findNemo();
if (!binary) throw new Error('先に音声ランタイムを導入してください。Windowsはnpm run setup:asr、DGX Sparkは配備手順を参照してください。');
const result = spawnSync(binary, ['pull', 'nemotron-3-diarization'], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('話者分離モデルを準備できませんでした。');
