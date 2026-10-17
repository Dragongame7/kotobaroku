import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ollamaBaseUrl, configuredModel } from './config.mjs';
import { createLlmTransport } from './llm-transport.mjs';

export function validateConnection(input) {
  if (!['ollama', 'openai'].includes(input?.provider)) throw new Error('接続方式を選んでください。');
  let url; try { url = new URL(input.baseUrl); } catch { throw new Error('接続先URLを入力してください。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/(chat\/completions|api\/chat|models)$/.test(url.pathname)) throw new Error('HTTP/HTTPSのベースURLを入力してください。認証情報や個別APIのパスは含めないでください。');
  if (typeof input.model !== 'string' || !/^[\w./:-]{1,120}$/.test(input.model)) throw new Error('接続先が公開するモデル名を入力してください。');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw new Error('APIキーの形式が正しくありません。');
  return { provider: input.provider, baseUrl: url.href.replace(/\/+$/, ''), model: input.model, apiKey: input.apiKey || '', ...(input.disableThinking === true ? { disableThinking: true } : {}) };
}

export function environmentConnection(env = process.env) {
  if (env.LLM_PROVIDER || env.LLM_BASE_URL || env.LLM_MODEL || env.LLM_API_KEY) {
    if (!env.LLM_PROVIDER || !env.LLM_BASE_URL || !env.LLM_MODEL) throw new Error('LLM_PROVIDER・LLM_BASE_URL・LLM_MODELを一組で指定してください。');
    return { ...validateConnection({ provider: env.LLM_PROVIDER, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY, disableThinking: env.LLM_DISABLE_THINKING === 'true' }), origin: 'environment' };
  }
  return { ...validateConnection({ provider: 'ollama', baseUrl: ollamaBaseUrl(env), model: configuredModel(env) }), origin: env.OLLAMA_URL || env.OLLAMA_HOST || env.OLLAMA_MODEL ? 'legacy' : 'default' };
}

export function restrict(file, directory = false) {
  if (process.platform === 'win32') {
    const account = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${account}:${directory ? '(OI)(CI)' : ''}F`], { stdio: 'ignore', windowsHide: true });
  } else fs.chmodSync(file, directory ? 0o700 : 0o600);
}

export class LlmSettings {
  constructor({ file, initial, fetcher = fetch } = {}) {
    this.file = file; this.fetcher = fetcher; this.revision = randomUUID(); this.error = ''; this.proofs = new Map();
    try {
      if (file && fs.existsSync(file)) { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); this.current = { ...validateConnection(saved), origin: 'saved', checkedAt: saved.checkedAt }; }
      else this.current = initial ? { ...validateConnection(initial), origin: 'initial' } : environmentConnection();
    } catch { this.current = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:latest', apiKey: '', origin: 'error' }; this.error = 'LLM設定を読み込めません。設定画面で修正し、テストして保存してください。'; }
  }
  public() {
    const { apiKey, ...value } = this.current;
    return { ...value, hasApiKey: Boolean(apiKey), revision: this.revision, error: this.error };
  }
  draft(input) {
    if (input?.revision !== this.revision) throw new Error('別の画面で設定が更新されました。設定を再読み込みしてください。');
    const value = validateConnection(input);
    const same = value.provider === this.current.provider && value.baseUrl === this.current.baseUrl;
    if (!['keep', 'replace', 'clear'].includes(input.apiKeyAction)) throw new Error('APIキーの操作が正しくありません。');
    if (input.apiKeyAction === 'keep') {
      if (!same && this.current.apiKey) throw new Error('接続先が変わりました。APIキーを入力し直すか、キーなしを選んでください。');
      value.apiKey = same ? this.current.apiKey : '';
    } else if (input.apiKeyAction === 'clear') value.apiKey = '';
    else if (!value.apiKey) throw new Error('新しいAPIキーを入力してください。');
    return value;
  }
  transport() {
    if (this.error) return async () => { throw new Error(this.error); };
    return createLlmTransport(this.current, this.fetcher);
  }
  fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  async models(input, signal) {
    const value = this.draft({ ...input, model: input.model || '_model_list' }), request = createLlmTransport(value, this.fetcher);
    const response = await request(`${value.baseUrl}/api/tags`, { signal });
    if (!response.ok) throw new Error((await response.json()).error);
    const result = await response.json();
    if (!Array.isArray(result.models)) throw new Error('モデル一覧を取得できません。公開モデル名を手入力してください。');
    return result.models.filter(item => typeof item.name === 'string').map(item => item.name);
  }
  async test(input, signal) {
    const value = this.draft(input), request = createLlmTransport(value, this.fetcher);
    const chat = async (stream, format) => {
      const response = await request(`${value.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model: value.model, messages: [{ role: 'user', content: format ? 'Return JSON: {"ok":true}' : 'Reply only OK.' }], stream, format, think: false, keep_alive: '10m', options: { temperature: 0, num_ctx: 4096, num_predict: 32 } }) });
      if (!response.ok) throw new Error((await response.json()).error);
      return response;
    };
    const normal = await (await chat(false)).json();
    if (normal.done !== true || normal.done_reason === 'length' || !normal.message?.content?.trim()) throw new Error('文章生成を確認できませんでした。');
    const response = await chat(true), reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', text = '', done = false;
    const consume = line => { if (!line.trim()) return; const event = JSON.parse(line); if (event.error || event.done_reason === 'length') throw new Error('差分受信を確認できませんでした。'); text += event.message?.content || ''; done ||= event.done === true; };
    try { while (true) { const chunk = await reader.read(); buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(consume); if (chunk.done) break; } if (buffer.trim()) consume(buffer); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!done || !text.trim()) throw new Error('差分応答が途中で終了しました。');
    const format = { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false };
    const structured = await (await chat(false, format)).json();
    if (structured.done_reason === 'length' || structured.done !== true || JSON.parse(structured.message?.content || '{}').ok !== true) throw new Error('JSON形式の応答を確認できませんでした。');
    signal.throwIfAborted();
    if (input.revision !== this.revision) throw new Error('設定が更新されました。再テストしてください。');
    const token = randomUUID(), checkedAt = new Date().toISOString();
    this.proofs.clear(); this.proofs.set(token, { fingerprint: this.fingerprint(value), revision: this.revision, checkedAt, expires: Date.now() + 600000 });
    return { token, checkedAt, checks: ['文章生成', '差分受信', 'JSON出力'] };
  }
  save(input) {
    const value = this.draft(input), proof = this.proofs.get(input.token);
    if (!proof || proof.expires < Date.now() || proof.revision !== this.revision || proof.fingerprint !== this.fingerprint(value)) throw new Error('この設定をテストしてから保存してください。');
    if (!this.file) throw new Error('設定の保存先がありません。');
    const saved = { ...value, checkedAt: proof.checkedAt, schemaVersion: 1 };
    const directory = path.dirname(this.file), temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); restrict(directory, true);
      fs.writeFileSync(temporary, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); restrict(temporary);
      fs.renameSync(temporary, this.file);
    } catch { try { fs.unlinkSync(temporary); } catch { /* No temporary file remains. */ } throw new Error('LLM設定を保存できません。保存先のアクセス権と空き容量を確認してください。'); }
    this.current = { ...saved, origin: 'saved' }; this.revision = randomUUID(); this.error = ''; this.proofs.clear();
    return this.public();
  }
}
