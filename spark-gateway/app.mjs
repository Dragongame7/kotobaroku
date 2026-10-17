import express from 'express';
import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { apiUrl, speechReady, verifySpeech } from '../server/speech-transport.mjs';

function equal(left, right) {
  const a = Buffer.from(left || ''), b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createSparkGateway({ apiKey, asrUrl = 'http://127.0.0.1:8081', llmUrl = 'http://127.0.0.1:8000/v1', asrApiKey = '', llmApiKey = '', diarization = true, leaseMs = 60000, runtime = {}, fetcher = fetch, verify = verifySpeech } = {}) {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('GATEWAY_API_KEYを設定してください。');
  for (const value of [asrUrl, llmUrl]) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('上流APIの起点URLが不正です。'); }
  const app = express(), server = http.createServer(app), sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  let lease = null, admitting = false, verifiedAt = 0, closing = false;
  const authorize = req => equal(req.headers.authorization, `Bearer ${apiKey}`);
  const owner = req => lease && !lease.closing && Date.now() < lease.expiresAt && equal(req.headers['x-kotoba-lease'], lease.token) ? lease : null;
  function retire(value) {
    if (!value || value.closing) return;
    value.closing = true;
    for (const resource of value.resources) resource.abort();
    if (!value.resources.size && lease === value) lease = null;
  }
  function track(value, abort) {
    const resource = { abort }; value.resources.add(resource);
    return () => { value.resources.delete(resource); if (value.closing && !value.resources.size && lease === value) lease = null; };
  }
  const timer = setInterval(() => { if (lease && Date.now() >= lease.expiresAt) retire(lease); }, Math.min(1000, leaseMs)); timer.unref();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path === '/health' && req.method === 'GET') return res.json({ service: 'kotoba-spark-gateway', version: '1.0.0' });
    if (closing || !authorize(req)) return res.status(401).json({ error: 'Sparkの認証に失敗しました。' });
    next();
  });
  app.use(express.json({ limit: '160kb' }));
  app.get('/speech/ready', async (_req, res) => {
    const ready = await speechReady({ baseUrl: asrUrl, apiKey: asrApiKey }, fetcher);
    res.status(ready.ready ? 200 : 503).json({ ...ready, diarization: diarization && verifiedAt > 0, busy: Boolean(lease), gateway: true });
  });
  app.post('/kotoba/v1/leases', async (req, res) => {
    if (lease || admitting || closing) return res.status(409).json({ error: '別の会議またはAI処理で使用中です。' });
    if (!['meeting', 'test', 'speech-test', 'llm-test', 'retry', 'document'].includes(req.body?.purpose)) return res.status(400).json({ error: '用途が不正です。' });
    admitting = true; const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (['meeting', 'test', 'speech-test'].includes(req.body.purpose) && (!verifiedAt || Date.now() - verifiedAt > 30000)) {
        await verify({ baseUrl: asrUrl, apiKey: asrApiKey, diarization }, { signal: controller.signal }); verifiedAt = Date.now();
      }
      if (controller.signal.aborted || closing) return;
      lease = { id: randomUUID(), token: randomBytes(32).toString('hex'), expiresAt: Date.now() + leaseMs, resources: new Set(), purpose: req.body.purpose, closing: false };
      res.json({ id: lease.id, token: lease.token, expiresAt: lease.expiresAt, runtime });
    } catch { if (!res.destroyed) res.status(503).json({ error: '音声サービスの準備を確認できません。' }); }
    finally { admitting = false; }
  });
  app.post('/kotoba/v1/leases/:id/heartbeat', (req, res) => {
    if (!lease || lease.closing || Date.now() >= lease.expiresAt || req.params.id !== lease.id || !equal(req.body?.token, lease.token)) return res.status(409).json({ error: '利用権が失効しました。' });
    lease.expiresAt = Date.now() + leaseMs; res.json({ expiresAt: lease.expiresAt });
  });
  app.delete('/kotoba/v1/leases/:id', (req, res) => {
    if (!lease || req.params.id !== lease.id || !equal(req.body?.token, lease.token)) return res.status(409).json({ error: '利用権が不正です。' });
    retire(lease); res.json({ released: !lease });
  });
  async function proxy(req, res, url, upstreamKey, requireLease) {
    const value = owner(req);
    if (requireLease && !value) return res.status(409).json({ error: '会議の利用権を取得してください。' });
    const controller = new AbortController();
    const untrack = value ? track(value, () => controller.abort()) : () => {};
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const response = await fetcher(url, { method: req.method, headers: { ...(upstreamKey ? { Authorization: `Bearer ${upstreamKey}` } : {}), 'Content-Type': 'application/json' }, body: req.method === 'POST' ? JSON.stringify(req.body) : undefined, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requireLease ? 180000 : 5000)]), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return res.status(response.status).json({ error: '上流の推論サービスが要求を完了できませんでした。' }); }
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
      res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
      if (response.body) {
        const body = Readable.fromWeb(response.body);
        await pipeline(body, res);
      } else res.end();
    } catch { if (!res.destroyed) { if (res.headersSent) res.destroy(); else res.status(502).json({ error: '上流サービスとの接続が終了しました。' }); } }
    finally { untrack(); }
  }
  app.get('/v1/models', (req, res) => void proxy(req, res, apiUrl(llmUrl, 'models'), llmApiKey, false));
  app.post('/v1/chat/completions', (req, res) => void proxy(req, res, apiUrl(llmUrl, 'chat/completions'), llmApiKey, true));
  app.get('/speech/v1/models', (req, res) => void proxy(req, res, apiUrl(asrUrl, 'v1/models'), asrApiKey, false));
  app.use((_req, res) => res.status(404).json({ error: 'このAPIは公開されていません。' }));
  server.on('upgrade', (req, socket, head) => {
    const value = owner(req);
    if (closing || req.url !== '/speech/v1/audio/transcriptions/realtime' || !authorize(req) || !value || !['meeting', 'test', 'speech-test'].includes(value.purpose) || value.audio) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return;
    }
    value.audio = true;
    sockets.handleUpgrade(req, socket, head, client => {
      const upstream = new WebSocket(apiUrl(asrUrl, 'v1/audio/transcriptions/realtime', true), { headers: asrApiKey ? { Authorization: `Bearer ${asrApiKey}` } : {}, maxPayload: 1024 * 1024, handshakeTimeout: 8000, followRedirects: false });
      let finished = false, upstreamClosed = false, clientClosed = false;
      const abort = () => { client.terminate(); upstream.terminate(); };
      const untrack = track(value, abort);
      const cleanup = () => { if (upstreamClosed && clientClosed && !finished) { finished = true; value.audio = false; untrack(); } };
      client.on('message', (data, binary) => {
        if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 256 * 1024) return abort();
        upstream.send(data, { binary });
      });
      upstream.on('message', (data, binary) => {
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 1024 * 1024) return abort();
        client.send(data, { binary });
      });
      client.on('error', abort); upstream.on('error', abort);
      client.on('close', () => { clientClosed = true; upstream.terminate(); cleanup(); });
      upstream.on('close', () => { upstreamClosed = true; client.close(); cleanup(); });
    });
  });
  return { app, server, sockets, get state() { return { busy: Boolean(lease), admitting, verified: verifiedAt > 0 }; }, close() { closing = true; clearInterval(timer); retire(lease); for (const client of sockets.clients) client.terminate(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
