import { useEffect, useRef, useState } from 'react';

type Speech = { mode: 'local' | 'spark'; baseUrl: string; gatewayUrl?: string; diarization: boolean; inputProfile: 'browser' | 'conference'; revision: string; hasApiKey: boolean; error?: string };
type Draft = Speech & { apiKeyAction: 'keep' | 'replace' | 'clear'; apiKey: string };
export default function SpeechSettings({ active, locked, onBusy, refresh }: { active: boolean; locked: boolean; onBusy: (busy: boolean) => void; refresh: () => void }) {
  const [draft, setDraft] = useState<Draft>(), [current, setCurrent] = useState<Speech>(), [result, setResult] = useState<{ token: string; checks: string[] }>(), [running, setRunning] = useState(false), [message, setMessage] = useState('');
  const abort = useRef<AbortController | null>(null);
  function install(value: Speech) { setCurrent(value); setDraft({ ...value, apiKeyAction: 'keep', apiKey: '' }); setResult(undefined); }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch('/api/speech/settings', { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(); install(await response.json()); }).catch(() => { if (!controller.signal.aborted) setMessage('音声設定を読み込めません。画面を再読み込みしてください。'); });
    return () => controller.abort();
  }, [active]);
  useEffect(() => () => abort.current?.abort(), []);
  function edit(changes: Partial<Draft>) { setDraft(value => value ? { ...value, ...changes } : value); setResult(undefined); setMessage(''); }
  async function run(operation: 'test' | 'save') {
    if (!draft || running || locked || abort.current) return;
    const controller = abort.current = new AbortController(); setRunning(true); onBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/speech/settings/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, token: result?.token }), signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '音声設定を処理できません。');
      if (operation === 'test') { setResult(data); setMessage('無音PCMによる音声接続と末尾確定を確認しました。話者の精度は会議音声で確認してください。'); }
      else { install(data); setMessage('音声設定を保存しました。次の録音から適用します。'); }
    } catch (reason) { setResult(undefined); setMessage(controller.signal.aborted ? '音声の確認を中止しました。' : (reason as Error).message); }
    finally { abort.current = null; setRunning(false); onBusy(false); refresh(); }
  }
  return <section className="speech-settings" aria-label="音声認識・話者分離設定"><h2>音声認識・話者分離</h2><p>GPUなしの端末では、音声認識と話者分離もDGX Sparkで処理します。音声ファイルは保存しません。</p>
    {current && <p>適用中：{current.mode === 'spark' ? 'DGX Spark' : 'このPC'} · 話者分離{current.diarization ? 'ON（最大8人）' : 'OFF'} · {current.baseUrl}</p>}
    {current?.error && <p className="message error" role="alert">{current.error}</p>}
    {message && <p className="message notice" role="status">{message}</p>}
    {draft && <form className="llm-connection-form" onSubmit={event => { event.preventDefault(); void run('test'); }}><fieldset disabled={locked || running}>
      <label htmlFor="speech-mode">音声の処理場所</label><select id="speech-mode" value={draft.mode} onChange={event => edit({ mode: event.target.value as Draft['mode'], apiKeyAction: 'clear', apiKey: '' })}><option value="local">このPC（音声モデルの導入が必要）</option><option value="spark">DGX Spark（端末GPU不要）</option></select>
      {draft.mode === 'spark' && <><label htmlFor="speech-gateway">Spark共通ゲートウェイURL</label><input id="speech-gateway" type="url" required value={draft.gatewayUrl || ''} placeholder="https://Spark名:8001" onChange={event => edit({ gatewayUrl: event.target.value, apiKeyAction: 'clear', apiKey: '' })} /><small>初回は音声設定を確認・適用してから、LLM接続にもこのURLに /v1 を付けた起点を設定してテストしてください。</small></>}
      <label htmlFor="speech-url">音声APIの起点URL</label><input id="speech-url" type="url" required value={draft.baseUrl} placeholder={draft.mode === 'spark' ? 'https://Spark名:8001/speech' : 'http://127.0.0.1:8081'} onChange={event => edit({ baseUrl: event.target.value, apiKeyAction: 'clear', apiKey: '' })} />
      <label htmlFor="speech-diarization">話者分離</label><select id="speech-diarization" value={String(draft.diarization)} onChange={event => edit({ diarization: event.target.value === 'true' })}><option value="false">OFF</option><option value="true">ON · Nemotron-3-Diarization（最大8人）</option></select>
      <label htmlFor="speech-input">マイク入力</label><select id="speech-input" value={draft.inputProfile} onChange={event => edit({ inputProfile: event.target.value as Draft['inputProfile'] })}><option value="conference">会議用マイク（ブラウザの追加音声処理OFF）</option><option value="browser">ブラウザ標準（雑音抑制・AGC・AEC ON）</option></select>
      <label htmlFor="speech-key-action">音声・ゲートウェイAPIキー</label><select id="speech-key-action" value={draft.apiKeyAction} onChange={event => edit({ apiKeyAction: event.target.value as Draft['apiKeyAction'], apiKey: '' })}><option value="keep">現在のキーを維持{current?.hasApiKey ? '（保存済み）' : '（未設定）'}</option><option value="replace">新しいキーを入力</option><option value="clear">キーなし・削除</option></select>
      {draft.apiKeyAction === 'replace' && <><label htmlFor="speech-key">新しい音声APIキー</label><input id="speech-key" type="password" autoComplete="new-password" value={draft.apiKey} onChange={event => edit({ apiKey: event.target.value })} /></>}
    </fieldset><div className="llm-form-actions"><button className="button secondary" type="submit" disabled={locked || running}>{running ? '音声接続を確認中' : '音声の動作を確認'}</button><button className="button primary" type="button" disabled={locked || running || !result} onClick={() => void run('save')}>音声設定を適用</button>{running && <button className="button secondary" type="button" onClick={() => abort.current?.abort()}>音声確認を中止</button>}</div>{result && <p>{result.checks.join(' / ')}</p>}</form>}
  </section>;
}
