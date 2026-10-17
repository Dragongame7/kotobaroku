import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { restrict } from './llm-settings.mjs';
import { speechReady, verifySpeech } from './speech-transport.mjs';
import { acquireLease } from './meeting-session.mjs';

function baseUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('音声サービスのURLを入力してください。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('認証情報・クエリを含まないHTTP/HTTPSの起点URLを指定してください。');
  return url.href.replace(/\/+$/, '');
}
export function validateSpeech(input) {
  if (!['local', 'spark'].includes(input?.mode)) throw new Error('音声の処理場所を選択してください。');
  const result = { mode: input.mode, baseUrl: baseUrl(input.baseUrl), diarization: input.diarization === true, inputProfile: input.inputProfile === 'conference' ? 'conference' : 'browser', apiKey: input.apiKey || '' };
  if (typeof result.apiKey !== 'string' || result.apiKey.length > 4096 || /[\r\n]/.test(result.apiKey)) throw new Error('音声APIキーの形式が正しくありません。');
  if (input.mode === 'spark') {
    result.gatewayUrl = baseUrl(input.gatewayUrl || result.baseUrl.replace(/\/speech$/, ''));
    if (result.baseUrl !== result.gatewayUrl + '/speech') throw new Error('Sparkの音声APIは共通ゲートウェイURLに /speech を付けた起点を指定してください。');
  }
  return result;
}
export function speechEnvironment(env = process.env) {
  if (env.SPEECH_MODE === 'spark' && !env.SPEECH_URL) throw new Error('Spark構成ではSPEECH_URLを指定してください。');
  return validateSpeech({ mode: env.SPEECH_MODE || 'local', baseUrl: env.SPEECH_URL || env.ASR_URL || 'http://127.0.0.1:8081', gatewayUrl: env.SPARK_GATEWAY_URL, apiKey: env.SPEECH_API_KEY, diarization: env.SPEAKER_DIARIZATION === 'true', inputProfile: env.AUDIO_INPUT_PROFILE || 'browser' });
}
export class SpeechSettings {
  constructor({ file, initial, fetcher = fetch } = {}) {
    Object.assign(this, { file, fetcher, revision: randomUUID(), proofs: new Map(), error: '' });
    try { this.current = file && fs.existsSync(file) ? { ...validateSpeech(JSON.parse(fs.readFileSync(file, 'utf8'))), origin: 'saved' } : { ...(initial ? validateSpeech(initial) : speechEnvironment()), origin: initial ? 'initial' : 'environment' }; }
    catch { this.current = { ...validateSpeech({ mode: 'local', baseUrl: 'http://127.0.0.1:8081' }), origin: 'error' }; this.error = '音声設定を読み込めません。設定画面で確認してください。'; }
  }
  public() { const { apiKey, ...value } = this.current; return { ...value, hasApiKey: Boolean(apiKey), revision: this.revision, error: this.error }; }
  draft(input) {
    if (input.revision !== this.revision) throw new Error('音声設定が変更されています。再読み込みしてください。');
    if (!['keep', 'replace', 'clear'].includes(input.apiKeyAction)) throw new Error('音声APIキーの操作を選択してください。');
    if (input.apiKeyAction === 'replace' && !input.apiKey) throw new Error('新しい音声APIキーを入力してください。');
    if (input.apiKeyAction === 'keep' && this.current.apiKey && (input.mode !== this.current.mode || input.baseUrl?.replace(/\/+$/, '') !== this.current.baseUrl || (input.gatewayUrl || '') !== (this.current.gatewayUrl || ''))) throw new Error('音声の接続先が変わりました。キーを入力し直すか、削除を選んでください。');
    const apiKey = input.apiKeyAction === 'replace' ? input.apiKey : input.apiKeyAction === 'clear' ? '' : input.baseUrl?.replace(/\/+$/, '') === this.current.baseUrl && input.mode === this.current.mode && (input.gatewayUrl || '') === (this.current.gatewayUrl || '') ? this.current.apiKey : '';
    return validateSpeech({ ...input, apiKey });
  }
  fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  async test(input, signal) {
    const value = this.draft(input);
    const ready = await speechReady(value, this.fetcher);
    if (!ready.ready) throw new Error('音声サービスが準備できていません。接続先とモデルの状態を確認してください。');
    const lease = await acquireLease(value, { purpose: 'speech-test', signal, fetcher: this.fetcher });
    try { await verifySpeech(value, { signal, lease }); }
    finally { await lease?.release(); }
    signal?.throwIfAborted();
    if (input.revision !== this.revision) throw new Error('音声設定が更新されています。再テストしてください。');
    const token = randomUUID(); this.proofs.clear(); this.proofs.set(token, { fingerprint: this.fingerprint(value), expires: Date.now() + 600000 });
    return { token, checks: ['音声接続', 'PCM送信・末尾確定', ...(value.diarization ? ['話者分離オプション'] : [])], checkedAt: new Date().toISOString() };
  }
  save(input) {
    const value = this.draft(input), proof = this.proofs.get(input.token);
    if (!proof || proof.expires < Date.now() || proof.fingerprint !== this.fingerprint(value)) throw new Error('この音声設定をテストしてから保存してください。');
    if (!this.file) throw new Error('音声設定の保存先がありません。');
    const directory = path.dirname(this.file), temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); restrict(directory, true);
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); restrict(temporary); fs.renameSync(temporary, this.file);
    } catch { try { fs.unlinkSync(temporary); } catch {} throw new Error('音声設定を保存できません。保存先のアクセス権を確認してください。'); }
    this.current = { ...value, origin: 'saved' }; this.error = ''; this.revision = randomUUID(); this.proofs.clear(); return this.public();
  }
}
