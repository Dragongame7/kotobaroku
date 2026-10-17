import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  testDir: './test', testMatch: '*.spec.mjs', workers: 1,
  timeout: 120000,
  use: {
    baseURL: process.env.KOTOBA_TEST_URL || 'http://127.0.0.1:3210',
    browserName: 'chromium', channel: 'msedge',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(root, '.runtime', 'test-speech.wav')}`] },
    screenshot: 'only-on-failure',
  },
});
