import { randomUUID } from 'node:crypto';
import { apiUrl } from './speech-transport.mjs';

export async function acquireLease(connection, { purpose = 'meeting', signal, onLost = () => {}, fetcher = fetch } = {}) {
  if (connection.mode !== 'spark') return null;
  const headers = { 'Content-Type': 'application/json', ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) };
  const call = async (route, method, body, requestSignal = signal, timeoutMs = 5000) => {
    const response = await fetcher(apiUrl(connection.gatewayUrl, `kotoba/v1/${route}`), { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.any([...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(timeoutMs)]), redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 409 ? 'Sparkは別の会議またはAI処理で使用中です。終了を待ってください。' : 'Sparkの利用権を取得・更新できません。接続と認証を確認してください。');
    return response.json();
  };
  // Admission may perform the gateway's bounded 20-second speech probe.
  const value = await call('leases', 'POST', { clientId: randomUUID(), purpose }, signal, 30000);
  if (!/^[\w-]{1,100}$/.test(value.id) || typeof value.token !== 'string') throw new Error('Sparkの利用権応答が不正です。');
  let released = false, refreshing = false;
  const timer = setInterval(async () => {
    if (released || refreshing) return; refreshing = true;
    try { await call(`leases/${value.id}/heartbeat`, 'POST', { token: value.token }); }
    catch { if (!released) onLost(); }
    finally { refreshing = false; }
  }, 15000);
  timer.unref?.();
  return { ...value, async release() {
    if (released) return; released = true; clearInterval(timer);
    try { await call(`leases/${value.id}`, 'DELETE', { token: value.token }, null); } catch { /* Gateway also expires and aborts abandoned requests. */ }
  } };
}
