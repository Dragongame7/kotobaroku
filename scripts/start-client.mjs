import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApplication } from '../server/app.mjs';
import { clientConfig, applyClientDefaults } from './client-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);

function openBrowser(url) {
  if (process.platform !== 'win32' || process.argv.includes('--no-browser')) return;
  const child = spawn('explorer.exe', [url], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => console.log('ブラウザで次のURLを開いてください：' + url));
  child.unref();
}

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const configFile = path.join(root, 'connection.json');
  const config = clientConfig(fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {});
  applyClientDefaults(config);
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORTの設定が正しくありません。');
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('画面ファイルがありません。配布ZIPをフォルダー全体に展開してください。');
  fs.mkdirSync(path.join(root, '.local'), { recursive: true });
  fs.accessSync(path.join(root, '.local'), fs.constants.W_OK);
  const configured = ['speech-settings.json', 'llm-settings.json'].every(name => fs.existsSync(path.join(root, '.local', name)));
  const { server, sockets, cancelProcessing } = createApplication();
  let stopping = false;
  function stop() {
    if (stopping) return; stopping = true;
    cancelProcessing();
    for (const client of sockets.clients) client.terminate();
    server.closeAllConnections(); server.close();
    setTimeout(() => process.exit(), 500).unref();
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'このポートは使用中です。すでに開いていることば録を利用するか、その起動ウィンドウを終了してください。' : error.message);
    stop(); process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/#${configured ? 'live' : 'settings'}`;
    console.log(`\nことば録（DGX接続用）\n${url}\n初回は音声設定、次にLLM設定を確認して保存してください。\n終了するにはこのウィンドウで Ctrl+C を押してください。\n`);
    openBrowser(url);
  });
} catch (error) {
  console.error('起動できませんでした：' + error.message);
  process.exitCode = 1;
}
