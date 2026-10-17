import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, RefreshCw, Settings2 } from 'lucide-react';
import SpeechSettings from './SpeechSettings';
import MeetingHistory from './MeetingHistory';

export type LlmSettings = { provider: 'ollama' | 'openai'; baseUrl: string; model: string; hasApiKey: boolean; origin: string; revision: string; checkedAt?: string; error?: string; disableThinking?: boolean };
type Draft = Pick<LlmSettings, 'provider' | 'baseUrl' | 'model' | 'revision' | 'disableThinking'> & { apiKeyAction: 'keep' | 'replace' | 'clear'; apiKey: string };
type TestResult = { token: string; checkedAt: string; checks: string[] };
const origins: Record<string, string> = { saved: '設定画面から保存', environment: 'LLM環境変数', legacy: '従来のOllama環境変数', default: '既定値', error: '読み込みエラー', initial: '起動時の設定' };
export default function Settings({ active, locked, onBusy, refresh, back }: { active: boolean; locked: boolean; onBusy: (value: boolean) => void; refresh: () => void; back: () => void }) {
  const [current, setCurrent] = useState<LlmSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [result, setResult] = useState<TestResult | null>(null);
  const [running, setRunning] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
  function install(value: LlmSettings) {
    setCurrent(value); setDraft({ provider: value.provider, baseUrl: value.baseUrl, model: value.model, revision: value.revision, disableThinking: Boolean(value.disableThinking), apiKeyAction: 'keep', apiKey: '' }); setResult(null); setModels([]);
  }
  async function load() {
    loadController.current?.abort(); const request = loadController.current = new AbortController();
    try { const response = await fetch('/api/llm/settings', { signal: request.signal }); if (!response.ok) throw new Error(); install(await response.json()); setError(''); }
    catch { if (!request.signal.aborted) setError('設定を取得できません。再読み込みしてください。'); }
  }
  useEffect(() => { if (active) { void load(); setNotice(''); } return () => loadController.current?.abort(); }, [active]);
  useEffect(() => () => controller.current?.abort(), []);
  function edit(changes: Partial<Draft>) { setDraft(value => value ? { ...value, ...changes } : value); setResult(null); setNotice(''); setError(''); }
  async function run(operation: 'models' | 'test' | 'save') {
    if (!draft || locked || running || controller.current) return;
    const abort = controller.current = new AbortController(); setRunning(operation); onBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/llm/settings/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ ...draft, token: operation === 'save' ? result?.token : undefined }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '接続設定を処理できませんでした。');
      if (operation === 'models') { setModels(value.models); setNotice(value.models.length ? 'モデル候補を取得しました。接続テストはまだ完了していません。' : 'モデル候補はありません。公開モデル名を入力できます。'); }
      else if (operation === 'test') { setResult(value); setNotice('文章生成・差分受信・JSON出力を確認しました。「保存して適用」で切り替わります。'); }
      else { install(value); setNotice('設定を保存して適用しました。次の処理から使用します。'); }
    } catch (reason) { setError(abort.signal.aborted ? '接続確認を中断しました。現在の設定は変わりません。' : (reason as Error).message); if (operation !== 'models') setResult(null); }
    finally { controller.current = null; setRunning(''); onBusy(false); refresh(); }
  }
  const disabled = locked || Boolean(running);
  const sameEndpoint = draft && current && draft.provider === current.provider && draft.baseUrl.replace(/\/+$/, '') === current.baseUrl;
  return <section className="llm-settings-page" aria-label="LLM接続設定">
    <div className="settings-page-heading"><div><span className="settings-kicker"><Settings2 size={16} /> 設定</span><h1>LLM接続</h1><p>補正・翻訳・整形・要約で共通の接続先を使います。</p></div><button className="button secondary" disabled={disabled} onClick={back}><ArrowLeft size={16} />作業へ戻る</button></div>
    <div className="llm-current"><h2>適用中の設定</h2>{current ? <dl><dt>接続方式</dt><dd>{current.provider === 'ollama' ? 'Ollama' : 'OpenAI互換（vLLM）'}</dd><dt>接続先</dt><dd>{current.baseUrl}</dd><dt>モデル</dt><dd>{current.model}</dd><dt>APIキー</dt><dd>{current.hasApiKey ? '保存済み' : '未設定'}</dd><dt>設定の由来</dt><dd>{origins[current.origin] || current.origin}</dd><dt>最終確認</dt><dd>{current.checkedAt ? new Date(current.checkedAt).toLocaleString('ja-JP') : '未確認'}</dd></dl> : <p>読み込んでいます。</p>}{current?.error && <p className="message error" role="alert">{current.error}</p>}</div>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message notice" role="status">{notice}</p>}
    {!draft && <button className="button secondary" disabled={disabled} onClick={() => void load()}>設定を再読み込み</button>}
    {draft && <form className="llm-connection-form" onSubmit={event => { event.preventDefault(); void run('test'); }}>
      <h2>接続先を設定する</h2><p>文章処理は設定した接続先で実行します。テストでは固定の確認文だけを送ります。</p>
      <fieldset disabled={disabled}>
        <label htmlFor="llm-provider">接続方式</label><select id="llm-provider" value={draft.provider} onChange={event => { edit({ provider: event.target.value as Draft['provider'], apiKeyAction: 'clear', apiKey: '' }); setModels([]); }}><option value="ollama">Ollama</option><option value="openai">OpenAI互換（vLLM）</option></select>
        <label htmlFor="llm-url">接続先URL</label><input id="llm-url" type="url" required value={draft.baseUrl} placeholder={draft.provider === 'openai' ? 'http://IPアドレス:8001/v1' : 'http://127.0.0.1:11434'} autoComplete="off" spellCheck={false} onChange={event => { edit({ baseUrl: event.target.value, apiKeyAction: 'clear', apiKey: '' }); setModels([]); }} /><small>{draft.provider === 'openai' ? '例：http://IPアドレス:8001/v1（IPアドレスは実際の値に置き換えてください）' : 'OllamaのベースURLを指定してください。'}</small>
        <label htmlFor="llm-model">モデル</label><input id="llm-model" required value={draft.model} list="llm-model-options" autoComplete="off" spellCheck={false} onChange={event => edit({ model: event.target.value })} /><datalist id="llm-model-options">{models.map(model => <option key={model} value={model} />)}</datalist>
        <label htmlFor="llm-key-action">APIキー</label><select id="llm-key-action" value={draft.apiKeyAction} onChange={event => edit({ apiKeyAction: event.target.value as Draft['apiKeyAction'], apiKey: '' })}><option value="keep" disabled={!sameEndpoint}>現在のキーを維持{current?.hasApiKey ? '（保存済み）' : '（未設定）'}</option><option value="replace">新しいキーを入力</option><option value="clear">キーなし・保存済みキーを削除</option></select>
        {draft.apiKeyAction === 'replace' && <><label htmlFor="llm-api-key">新しいAPIキー</label><input id="llm-api-key" type="password" autoComplete="new-password" value={draft.apiKey} onChange={event => edit({ apiKey: event.target.value })} /></>}
        <small>APIキーはサーバーの非公開ファイルに平文で保存し、OSのアクセス権で制限します。ブラウザには保存しません。</small>
        {draft.provider === 'openai' && <label className="thinking-option"><input type="checkbox" checked={Boolean(draft.disableThinking)} onChange={event => edit({ disableThinking: event.target.checked })} />対応モデルの思考モードを無効にする（enable_thinking）</label>}
      </fieldset>
      {result && <div className="llm-checks" role="status">{result.checks.map(check => <span key={check}><Check size={15} />{check}</span>)}</div>}
      <div className="llm-form-actions"><button className="button secondary" type="button" disabled={disabled || !draft.baseUrl.trim()} onClick={() => void run('models')}><RefreshCw size={15} />モデル一覧を取得</button><button className="button secondary" type="submit" disabled={disabled}>{running === 'test' ? '接続を確認しています' : '接続をテスト'}</button><button className="button primary" type="button" disabled={disabled || !result} onClick={() => void run('save')}>保存して適用</button>{running && running !== 'save' && <button className="button secondary" type="button" onClick={() => controller.current?.abort()}>接続確認を中止</button>}</div>
      <button className="settings-reload" type="button" disabled={disabled} onClick={() => void load()}>適用中の設定を再読み込み</button>
    </form>}
    <SpeechSettings active={active} locked={disabled} onBusy={onBusy} refresh={refresh} />
    <MeetingHistory active={active} />
  </section>;
}
