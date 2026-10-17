import { validateSpeech } from '../server/speech-settings.mjs';
import { validateConnection } from '../server/llm-settings.mjs';

export function clientConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('connection.jsonの形式が正しくありません。');
  const allowed = ['gatewayUrl', 'model', 'port', 'inputProfile', 'disableThinking'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('connection.jsonには接続先・モデル・ポート・マイク設定だけを指定してください。APIキーはアプリの設定画面で入力します。');
  const gatewayUrl = input.gatewayUrl ?? 'http://127.0.0.1:8001';
  if (typeof gatewayUrl !== 'string') throw new Error('DGXゲートウェイURLを文字列で指定してください。');
  const base = gatewayUrl.replace(/\/+$/, '');
  const speech = validateSpeech({ mode: 'spark', baseUrl: base + '/speech', gatewayUrl: base, diarization: true, inputProfile: input.inputProfile ?? 'conference' });
  const llm = validateConnection({ provider: 'openai', baseUrl: base + '/v1', model: input.model ?? 'meeting-llm', disableThinking: input.disableThinking === true });
  const port = input.port ?? 3210;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('起動ポートは1024〜65535の整数で指定してください。');
  if (input.inputProfile !== undefined && !['browser', 'conference'].includes(input.inputProfile)) throw new Error('マイク設定はbrowserまたはconferenceを指定してください。');
  if (input.disableThinking !== undefined && typeof input.disableThinking !== 'boolean') throw new Error('disableThinkingはtrueまたはfalseを指定してください。');
  return { gatewayUrl: speech.gatewayUrl, model: llm.model, port, inputProfile: speech.inputProfile, disableThinking: llm.disableThinking === true };
}

export function applyClientDefaults(config, env = process.env) {
  const defaults = {
    PORT: String(config.port), SPEECH_MODE: 'spark', SPARK_GATEWAY_URL: config.gatewayUrl,
    SPEECH_URL: config.gatewayUrl + '/speech', SPEAKER_DIARIZATION: 'true', AUDIO_INPUT_PROFILE: config.inputProfile,
    LLM_PROVIDER: 'openai', LLM_BASE_URL: config.gatewayUrl + '/v1', LLM_MODEL: config.model,
    LLM_DISABLE_THINKING: String(config.disableThinking),
  };
  for (const [key, value] of Object.entries(defaults)) env[key] ??= value;
}
