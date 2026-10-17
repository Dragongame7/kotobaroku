import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { powershell, sha256, filesUnder, removeTemporary } from './client-package-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const zip = path.resolve(process.argv[2] || path.join(root, 'release', `kotobaroku-${version}-windows-x64.zip`));
const temporaryRoot = path.join(root, '.runtime'); fs.mkdirSync(temporaryRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(temporaryRoot, 'client-smoke-'));
let child, upstream;
try {
  assert.equal(sha256(zip), fs.readFileSync(zip + '.sha256', 'utf8').trim().split(/\s+/)[0]);
  powershell('Expand-Archive -LiteralPath $env:KOTOBA_CLIENT_ZIP -DestinationPath $env:KOTOBA_SMOKE_STAGE', { KOTOBA_CLIENT_ZIP: zip, KOTOBA_SMOKE_STAGE: stage });
  const folders = fs.readdirSync(stage); assert.equal(folders.length, 1);
  const app = path.join(stage, folders[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'client-manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  const actualFiles = filesUnder(app).map(file => path.relative(app, file).split(path.sep).join('/')).sort();
  assert.deepEqual(actualFiles, [...manifest.files.map(file => file.path), 'client-manifest.json'].sort());
  for (const file of manifest.files) {
    const target = path.resolve(app, file.path);
    assert.ok(target.startsWith(path.resolve(app) + path.sep));
    assert.equal(sha256(target), file.sha256, file.path);
    assert.ok(!/^(?:\.env(?:\.|$)|\.local\/|\.runtime\/|\.git\/|reports\/)/.test(file.path), 'Private data in ZIP: ' + file.path);
  }
  const binary = path.join(app, 'runtime', 'node.exe');
  const nodeVersion = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(nodeVersion.status, 0); assert.equal(nodeVersion.stdout.trim(), 'v' + manifest.nodeVersion);
  const runtimePackage = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(runtimePackage.dependencies).sort(), ['express', 'kuromoji', 'ws']);
  const dictionary = spawnSync(binary, ['--input-type=module', '-e', "import {japaneseTokenizer} from './server/correction.mjs'; const t=await japaneseTokenizer(); if(!t.tokenize('会議の予定です').length)process.exit(1); console.log('dictionary ready');"], { cwd: app, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(dictionary.status, 0, dictionary.stderr);
  upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/speech/ready') res.end(JSON.stringify({ ready: true, device: 'cuda', diarization: true }));
    else if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'package-test-model' }] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = 'http://127.0.0.1:' + upstream.address().port;
  // Only the bundled runtime is invoked; Node.js/npm on PATH are not needed.
  child = spawn(binary, ['scripts/start-client.mjs', '--no-browser'], { cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), PORT: '0', SPEECH_MODE: 'spark', SPEECH_URL: gateway + '/speech', SPARK_GATEWAY_URL: gateway, LLM_PROVIDER: 'openai', LLM_BASE_URL: gateway + '/v1', LLM_MODEL: 'package-test-model', SPEECH_API_KEY: '', LLM_API_KEY: '' } });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const closed = once(child, 'close');
  let base;
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/#settings/);
    if (found) { base = 'http://127.0.0.1:' + found[1]; break; }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(base, output);
  const get = async route => {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, route); return response;
  };
  const page = await (await get('/')).text();
  const script = page.match(/<script[^>]+src="([^"]+)"/); assert.ok(script); await get(script[1]);
  const speech = await (await get('/api/speech/settings')).json(); assert.equal(speech.mode, 'spark'); assert.equal(speech.diarization, true);
  const health = await (await get('/api/health')).json(); assert.equal(health.asr.ready, true); assert.equal(health.llm.ready, true); assert.equal(health.llm.model, 'package-test-model');
  child.kill(); await closed; child = null;
  console.log('配布ZIP検証成功：SHA-256、同梱ファイル、秘密情報の除外、日本語辞書、同梱Nodeでの起動、画面とDGX接続設定。');
} finally {
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  removeTemporary(stage, temporaryRoot);
}
