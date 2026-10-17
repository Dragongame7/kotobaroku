// The existing inference pipeline uses one chat request/NDJSON contract.
// Provider differences stay here, including SSE -> NDJSON and structured output.
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const encode = new TextEncoder();
const failure = status => status === 401 || status === 403 ? '接続先の認証に失敗しました。APIキーを確認してください。' : status === 404 ? '接続先またはモデルが見つかりません。URLとモデルを確認してください。' : `LLM要求が失敗しました (${status})。`;

async function* sseEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = [];
  function line(value) {
    if (!value) { const event = data.join('\n'); data = []; return event || null; }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    return null;
  }
  try {
    while (true) {
      const chunk = await reader.read(); buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let match;
      while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
        const value = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const event = line(value); if (event !== null) yield event;
      }
      if (buffer.length > 1024 * 1024) throw new Error('LLM応答が大きすぎます。');
      if (chunk.done) { if (buffer) line(buffer.replace(/\r$/, '')); if (data.length) yield data.join('\n'); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function normalizedStream(body) {
  const events = sseEvents(body);
  let finished = false, ended = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (!ended) {
          const item = await events.next();
          if (item.done || item.value === '[DONE]') {
            ended = true; await events.return();
            if (!finished) throw new Error('LLMの応答が途中で終了しました。');
            controller.close(); return;
          }
          const value = JSON.parse(item.value);
          if (value.error) throw new Error('LLMの生成中にエラーが発生しました。');
          const choice = value.choices?.find(item => item.index === 0 || item.index === undefined);
          if (!choice) continue;
          const text = choice.delta?.content;
          if (choice.finish_reason) {
            if (choice.finish_reason !== 'stop') throw new Error(choice.finish_reason === 'length' ? 'LLM出力が上限に達しました。' : 'LLMが本文の生成を完了できませんでした。');
            finished = true;
          }
          const event = { ...(typeof text === 'string' && text ? { message: { content: text } } : {}), ...(finished ? { done: true } : {}) };
          if (Object.keys(event).length) { controller.enqueue(encode.encode(JSON.stringify(event) + '\n')); return; }
        }
      } catch (error) {
        ended = true; await events.return().catch(() => {});
        // Keep previously delivered text readable even when the upstream stream fails.
        controller.enqueue(encode.encode(JSON.stringify({ error: error.name === 'AbortError' ? 'LLM処理を中断しました。' : 'LLMの応答が途中で終了、または不正な形式になりました。' }) + '\n'));
        controller.close();
      }
    },
    async cancel() { ended = true; await events.return(); },
  });
}

export function createLlmTransport(connection, fetcher = fetch) {
  const snapshot = Object.freeze({ ...connection });
  const transport = async (url, options = {}) => {
    const headers = new Headers(options.headers);
    if (snapshot.apiKey) headers.set('Authorization', `Bearer ${snapshot.apiKey}`);
    const requestOptions = { ...options, headers, redirect: 'error' };
    if (snapshot.provider === 'ollama') {
      const response = await fetcher(url, requestOptions);
      if (!response.ok) { await response.body?.cancel(); return json({ error: failure(response.status) }, response.status); }
      // A configured secret must never be echoed by a provider in errors or content.
      if (!snapshot.apiKey || !response.body) return response;
      const decoder = new TextDecoder(); let pending = '';
      return new Response(response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) { pending += decoder.decode(chunk, { stream: true }); const parts = pending.split('\n'); pending = parts.pop(); for (const part of parts) controller.enqueue(encode.encode(part.split(snapshot.apiKey).join('[非公開]') + '\n')); },
        flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(encode.encode(pending.split(snapshot.apiKey).join('[非公開]'))); },
      })), { status: response.status, headers: response.headers });
    }
    if (url.endsWith('/api/ps')) return json({ models: [] });
    if (url.endsWith('/api/generate')) throw new Error('外部接続のモデル管理には対応していません。');
    if (url.endsWith('/api/tags')) {
      const response = await fetcher(`${snapshot.baseUrl}/models`, requestOptions);
      if (!response.ok) { await response.body?.cancel(); return json({ error: failure(response.status) }, response.status); }
      const value = await response.json();
      return json({ models: (value.data || []).filter(item => typeof item.id === 'string').map(item => ({ name: item.id.split(snapshot.apiKey || '\0').join('[非公開]') })) });
    }
    if (!url.endsWith('/api/chat')) throw new Error('未対応のLLM操作です。');
    const input = JSON.parse(options.body || '{}');
    const body = {
      model: input.model || snapshot.model,
      messages: input.messages?.length ? input.messages : [{ role: 'user', content: 'Reply only OK.' }],
      stream: Boolean(input.stream),
      ...(input.options?.temperature !== undefined ? { temperature: input.options.temperature } : {}),
      max_tokens: input.options?.num_predict || (input.messages?.length ? 1024 : 8),
      ...(input.options?.top_p !== undefined ? { top_p: input.options.top_p } : {}),
      ...(input.options?.seed !== undefined ? { seed: input.options.seed } : {}),
      ...(input.format ? { response_format: { type: 'json_schema', json_schema: { name: 'kotoba_result', schema: input.format } } } : {}),
    };
    const response = await fetcher(`${snapshot.baseUrl}/chat/completions`, { ...requestOptions, method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); return json({ error: failure(response.status) }, response.status); }
    if (body.stream) {
      if (!response.body) throw new Error('LLM応答がありません。');
      return new Response(normalizedStream(response.body), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    const value = await response.json(), choice = value.choices?.[0];
    if (!choice || choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('LLM応答が空、途中終了、またはJSON出力に未対応です。');
    return json({ message: { content: snapshot.apiKey ? choice.message.content.split(snapshot.apiKey).join('[非公開]') : choice.message.content }, done: true, done_reason: 'stop' });
  };
  transport.connection = snapshot;
  return transport;
}
