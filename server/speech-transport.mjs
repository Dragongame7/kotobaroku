import { WebSocket } from 'ws';

export function apiUrl(base, route, websocket = false) {
  const url = new URL(base.replace(/\/+$/, '') + '/' + route.replace(/^\/+/, ''));
  if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export function speechHeaders(connection, lease) {
  return { ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}), ...(lease?.token ? { 'X-Kotoba-Lease': lease.token } : {}) };
}
export async function speechReady(connection, fetcher = fetch) {
  try {
    const response = await fetcher(apiUrl(connection.baseUrl, 'ready'), { headers: speechHeaders(connection), signal: AbortSignal.timeout(3000), redirect: 'error' });
    const data = await response.json();
    return { ready: response.ok && data.ready === true, device: data.device || null, busy: data.busy === true, diarization: data.diarization === true || data.capabilities?.includes('diarization') === true };
  } catch { return { ready: false, device: null, diarization: false }; }
}

// A silent, bounded request verifies the actual ASR session option, rather than
// mistaking a filename or a standalone diarizer for integrated word tagging.
export function verifySpeech(connection, { signal, lease, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(apiUrl(connection.baseUrl, 'v1/audio/transcriptions/realtime', true), { headers: speechHeaders(connection, lease), handshakeTimeout: 8000, maxPayload: 1024 * 1024, followRedirects: false });
    let settled = false;
    const end = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      ws.terminate(); error ? reject(error) : resolve({ diarization: Boolean(connection.diarization) });
    };
    const abort = () => end(new Error('音声接続の確認を中断しました。'));
    const timer = setTimeout(() => end(new Error('音声接続の確認がタイムアウトしました。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    ws.on('error', () => end(new Error('音声サービスに接続できません。URL・認証・起動状態を確認してください。')));
    ws.on('close', () => { if (!settled) end(new Error('音声の確認が完了する前に接続が終了しました。')); });
    ws.on('message', data => {
      try {
        const event = JSON.parse(data);
        if (event.type === 'session.created') ws.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, language: 'ja-JP', word_timestamps: true, speaker_diarization: Boolean(connection.diarization) } }));
        if (event.type === 'session.updated') { ws.send(Buffer.alloc(3200)); ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); }
        if (event.type === 'error') end(new Error('音声モデルまたは話者分離を利用できません。Sparkのモデルロード状態を確認してください。'));
        if (event.type === 'input_audio_buffer.committed') end();
      } catch { end(new Error('音声サービスの応答形式が正しくありません。')); }
    });
  });
}
