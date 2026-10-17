import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { clientConfig } from './client-config.mjs';
import { NODE_VERSION, NODE_ARCHIVE, powershell, sha256, filesUnder, removeTemporary } from './client-package-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64環境で配布ZIPを作成してください。');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--gateway-url', '--model', '--node-archive', '--node-checksums'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('引数は --gateway-url URL / --model NAME / --node-archive ZIP / --node-checksums FILE です。');
  options[args[i].slice(2)] = args[i + 1];
}
if (Boolean(options['node-archive']) !== Boolean(options['node-checksums'])) throw new Error('Node.jsのローカルZIPとチェックサムファイルは一組で指定してください。');
const config = clientConfig({ ...(options['gateway-url'] ? { gatewayUrl: options['gateway-url'] } : {}), ...(options.model ? { model: options.model } : {}) });
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('配布バージョンの形式が正しくありません。');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('npm処理に失敗しました。');
}
async function download(url, target) {
  console.log('取得中：' + url);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('ダウンロード失敗：' + response.status);
  const temporary = target + '.partial';
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
  fs.renameSync(temporary, target);
}

const temporaryRoot = path.join(root, '.runtime');
fs.mkdirSync(temporaryRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(temporaryRoot, 'client-build-'));
try {
  npm(['run', 'build'], root);
  const downloads = path.join(temporaryRoot, 'client-downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const archive = options['node-archive'] ? path.resolve(options['node-archive']) : path.join(downloads, NODE_ARCHIVE);
  const sums = options['node-checksums'] ? path.resolve(options['node-checksums']) : path.join(downloads, 'SHASUMS256.txt');
  if (!options['node-archive']) {
    if (!fs.existsSync(archive)) await download(`https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`, archive);
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sums);
  }
  const checksum = fs.readFileSync(sums, 'utf8').split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === NODE_ARCHIVE)?.[0];
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum) || sha256(archive) !== checksum) throw new Error('Node.js ZIPのSHA-256が一致しません。');
  const nodeStage = path.join(stage, 'node');
  powershell('Expand-Archive -LiteralPath $env:KOTOBA_NODE_ZIP -DestinationPath $env:KOTOBA_NODE_STAGE', { KOTOBA_NODE_ZIP: archive, KOTOBA_NODE_STAGE: nodeStage });
  const nodeRoot = path.join(nodeStage, `node-v${NODE_VERSION}-win-x64`);
  const label = `kotobaroku-${pkg.version}-windows-x64`, app = path.join(stage, label);
  fs.mkdirSync(app);
  for (const name of ['server', 'dist', 'licenses']) fs.cpSync(path.join(root, name), path.join(app, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'THIRD-PARTY-NOTICES.md', 'start-client.cmd']) fs.copyFileSync(path.join(root, name), path.join(app, name));
  fs.mkdirSync(path.join(app, 'scripts'));
  for (const name of ['start-client.mjs', 'client-config.mjs', 'runtime.mjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(app, 'scripts', name));
  fs.mkdirSync(path.join(app, 'runtime'));
  fs.copyFileSync(path.join(nodeRoot, 'node.exe'), path.join(app, 'runtime', 'node.exe'));
  fs.copyFileSync(path.join(nodeRoot, 'LICENSE'), path.join(app, 'runtime', 'LICENSE'));
  fs.copyFileSync(path.join(root, 'deploy', 'client', 'START-HERE.txt'), path.join(app, 'START-HERE.txt'));
  fs.writeFileSync(path.join(app, 'connection.json'), JSON.stringify(config, null, 2) + '\n');
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], app);
  // React and the icon library are already compiled into dist. Keep only the
  // server's dependencies, and let npm update the staged lockfile accordingly.
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: pkg.name + '-client', version: pkg.version, private: true, type: 'module',
    engines: pkg.engines, scripts: { start: 'node scripts/start-client.mjs' },
    dependencies: Object.fromEntries(['express', 'kuromoji', 'ws'].map(name => [name, pkg.dependencies[name]])),
  }, null, 2) + '\n');
  npm(['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], app);
  const imports = spawnSync(path.join(app, 'runtime', 'node.exe'), ['--input-type=module', '-e', "await import('./server/app.mjs'); await import('./scripts/client-config.mjs');"], { cwd: app, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  if (imports.error) throw imports.error;
  if (imports.status !== 0) throw new Error('配布用サーバーの依存モジュールを読み込めません。');
  const inventory = filesUnder(app).map(file => ({ path: path.relative(app, file).split(path.sep).join('/'), sha256: sha256(file) }));
  fs.writeFileSync(path.join(app, 'client-manifest.json'), JSON.stringify({ version: pkg.version, platform: 'win32', arch: 'x64', nodeVersion: NODE_VERSION, nodeArchiveSha256: checksum, files: inventory }, null, 2) + '\n');
  const output = path.join(root, 'release'); fs.mkdirSync(output, { recursive: true });
  const zip = path.join(output, label + '.zip'), temporaryZip = path.join(stage, label + '.zip');
  powershell('Compress-Archive -LiteralPath $env:KOTOBA_CLIENT_STAGE -DestinationPath $env:KOTOBA_CLIENT_ZIP -CompressionLevel Optimal', { KOTOBA_CLIENT_STAGE: app, KOTOBA_CLIENT_ZIP: temporaryZip });
  fs.copyFileSync(temporaryZip, zip);
  fs.writeFileSync(zip + '.sha256', `${sha256(zip)}  ${path.basename(zip)}\n`);
  console.log('\n配布ZIP：' + zip);
} finally { removeTemporary(stage, temporaryRoot); }
