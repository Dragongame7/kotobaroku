import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Mic, Square, Download, Copy, Check, ArrowUpRight, RefreshCw, FileText, SlidersHorizontal, CircleHelp, X, LoaderCircle, ChevronRight, Plus, Headphones, Clock3, AlignLeft, List, ShieldCheck, Settings2 } from 'lucide-react';
import { MicrophoneCapture, type SpeechEvent } from './audio';
import Comparison from './Comparison';
import Translation from './Translation';
import LiveTranslation from './LiveTranslation';
import Settings from './Settings';
import { useLiveTranslation } from './useLiveTranslation';
import type { TranslationSettings } from './TranslationComparison';
import type { AudioClip } from './wav';
import { correctedDocument, correctionLabel, readNdjson, savedCorrectionMode, type Correction, type CorrectionMode, type CorrectedCaption } from './corrections';

type Health = { llm?: { ready?: boolean; provider?: string; baseUrl?: string; error?: string };  correction?: { supported: boolean }; asr: { ready: boolean }; whisper?: { ready: boolean }; ollama: { ready: boolean; models: string[] }; defaultModel: string; translation?: TranslationSettings; recording: boolean; processing: boolean };
type SavedSession = { captions?: CorrectedCaption[]; recordedOriginal?: string; resultInput?: string; id: string; title: string; text: string; output: string; mode: 'cleanup' | 'summary'; date: string };
type Draft = { useCorrected?: boolean; captions?: CorrectedCaption[]; recordedOriginal?: string; resultInput?: string; id?: string; text: string; output: string; mode: 'cleanup' | 'summary' };
function readStorage<T,>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
const initial = readStorage<Draft>('kotoba.draft', { text: '', output: '', mode: 'cleanup' });
const timeLabel = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const historyReplace = (hash: string) => window.history.replaceState(null, '', location.pathname + location.search + hash);

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const [text, setText] = useState(initial.text);
  const [recordedOriginal, setRecordedOriginal] = useState(initial.recordedOriginal || initial.text);
  const [captions, setCaptions] = useState<CorrectedCaption[]>(() => (initial.captions || []).map(row => ({ ...row, correction: row.correction?.status === 'pending' ? { ...row.correction, status: 'canceled' } : row.correction })));
  const [correctionMode, setCorrectionMode] = useState<CorrectionMode>(savedCorrectionMode);
  const [useCorrected, setUseCorrected] = useState(initial.useCorrected ?? true);
  const [resultInput, setResultInput] = useState(initial.resultInput || '原文');
  const captionSession = useRef('');
  const captionDocumentOffset = useRef(0);
  const correctedText = correctedDocument(text, captions);
  useEffect(() => { try { localStorage.setItem('kotoba.correction-mode', correctionMode); } catch { /* Optional setting. */ } }, [correctionMode]);
  const [output, setOutput] = useState(initial.output);
  const [mode, setMode] = useState<'cleanup' | 'summary'>(initial.mode);
  const [resultMode, setResultMode] = useState<'cleanup' | 'summary'>(initial.mode);
  const [partial, setPartial] = useState('');
  const [recordState, setRecordState] = useState<'idle' | 'connecting' | 'recording' | 'stopping'>('idle');
  const [processing, setProcessing] = useState(false);
  const [compareMode, setCompareMode] = useState(location.hash === '#compare');
  const [translationMode, setTranslationMode] = useState(['#translate', '#live', '#settings'].includes(location.hash));
  const [liveMode, setLiveMode] = useState(['#live', '#settings'].includes(location.hash));
  const [settingsMode, setSettingsMode] = useState(location.hash === '#settings');
  const settingsBack = useRef('#live');
  const [translationReset, setTranslationReset] = useState(0);
  const [audioClip, setAudioClip] = useState<AudioClip | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(() => readStorage<string>('kotoba.microphone', ''));
  const [language, setLanguage] = useState(() => readStorage<string>('kotoba.translation-language', 'ja-JP') === 'en-US' ? 'en-US' : 'ja-JP');
  const [model, setModel] = useState('');
  const [history, setHistory] = useState<SavedSession[]>(() => readStorage('kotoba.history', []));
  const [copied, setCopied] = useState('');
  const [help, setHelp] = useState(false);
  const capture = useRef<MicrophoneCapture | null>(null);
  const request = useRef<AbortController | null>(null);
  const sessionId = useRef<string>(initial.id || crypto.randomUUID());
  const previousRecordState = useRef(recordState);
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const correctedInput = useRef<HTMLDivElement>(null);
  const correctedFollowing = useRef(false);
  useEffect(() => {
    const active = recordState !== 'idle' || processing;
    if ((active || correctedFollowing.current) && correctedInput.current) correctedInput.current.scrollTop = correctedInput.current.scrollHeight;
    correctedFollowing.current = active;
  }, [correctedText, recordState, processing]);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const outputEnd = useRef<HTMLDivElement>(null);
  const originalEnd = useRef<HTMLDivElement>(null);
  const locked = recordState !== 'idle' || processing || Boolean(health?.recording || health?.processing);
  const recording = recordState === 'recording';
  const llmReady = health?.llm?.ready ?? health?.ollama.ready ?? false;
  const remoteBusy = Boolean(health?.recording || health?.processing);
  const connectionLabel = !health?.llm?.baseUrl ? '接続先を確認中' : /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/.test(health.llm.baseUrl) ? 'このPCへ接続' : '外部サーバーへ接続';

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error();
      const status: Health = await response.json(); setHealth(status);
      setModel(status.defaultModel);
    } catch { setHealth(null); } finally { setChecking(false); }
  }, []);
  const listDevices = useCallback(async () => {
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput')); } catch { /* Labels appear after the first microphone permission. */ }
  }, []);

  const translationProps = { correctionMode, setCorrectionMode, device, language, setLanguage, model, settings: health?.translation, ready: Boolean(health?.asr.ready && llmReady), locked: locked || remoteBusy && !processing, onBusy: setProcessing, refresh: () => { void refresh(); }, resetKey: translationReset };
  const translation = useLiveTranslation(translationProps);
  const currentRoute = useRef(location.hash);
  function navigate(hash: string) {
    if (locked) return;
    if (hash === '#settings') { if (currentRoute.current !== '#settings') settingsBack.current = currentRoute.current || ''; setSettingsMode(true); currentRoute.current = hash; historyReplace(hash); return; }
    setSettingsMode(false);
    setLiveMode(hash === '#live'); setTranslationMode(hash === '#live' || hash === '#translate'); setCompareMode(hash === '#compare');
    if ((hash === '#live' || hash === '#translate') && language === 'auto') setLanguage('ja-JP');
    currentRoute.current = hash; historyReplace(hash);
  }
  useEffect(() => {
    const changed = () => { if (locked) historyReplace(currentRoute.current); else navigate(location.hash); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [locked, language]);
  useEffect(() => { try { localStorage.setItem('kotoba.microphone', JSON.stringify(device)); if (language !== 'auto') localStorage.setItem('kotoba.translation-language', JSON.stringify(language)); } catch { /* Optional preferences. */ } }, [device, language]);

  useEffect(() => { void refresh(); void listDevices(); const timer = setInterval(() => void refresh(), 15000); navigator.mediaDevices?.addEventListener('devicechange', listDevices); return () => { clearInterval(timer); navigator.mediaDevices?.removeEventListener('devicechange', listDevices); capture.current?.dispose(); request.current?.abort(); }; }, [refresh, listDevices]);
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setSeconds(value => value + 1), 1000); return () => clearInterval(timer); }, [recording]);
  useEffect(() => { try { localStorage.setItem('kotoba.draft', JSON.stringify({ schemaVersion: 2, id: sessionId.current, text, output, mode: resultMode, captions, recordedOriginal, resultInput, useCorrected })); } catch { setNotice('ブラウザの保存容量が不足しています。テキストを保存してください。'); } }, [text, output, resultMode, captions, recordedOriginal, resultInput, useCorrected]);
  useEffect(() => {
    if (compareMode || translationMode || (recordState === 'idle' && previousRecordState.current === 'idle') || (!text && !partial)) return;
    if (originalInput.current) originalInput.current.scrollTop = originalInput.current.scrollHeight;
    originalEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [text, partial, recordState, compareMode, translationMode]);
  useEffect(() => { outputEnd.current?.scrollIntoView({ block: 'nearest' }); }, [output]);
  useEffect(() => { if (help) helpDialog.current?.showModal(); else helpDialog.current?.close(); }, [help]);

  function saveSession(finalText = text, finalOutput = output, finalMode = resultMode, inputLabel = resultInput) {
    if (!finalText.trim()) return;
    const entry: SavedSession = { id: sessionId.current, title: finalText.trim().slice(0, 30), text: finalText, output: finalOutput, mode: finalMode, captions, recordedOriginal, resultInput: inputLabel, date: new Date().toISOString() };
    setHistory(current => {
      const next = [entry, ...current.filter(item => item.id !== entry.id)].slice(0, 12);
      try { localStorage.setItem('kotoba.history', JSON.stringify(next)); } catch { setNotice('履歴を保存できません。テキストをダウンロードしてください。'); }
      return next;
    });
  }

  function onSpeech(event: SpeechEvent) {
    if (event.type === 'caption.segment') {
      const value = event.segment as CorrectedCaption; const row = { ...value, documentOffset: captionDocumentOffset.current, id: `${captionSession.current}:${value.id}` };
      setCaptions(current => { const old = current.find(item => item.id === row.id); if (old && (old.revision || 0) > (row.revision || 0)) return current; return old ? current.map(item => item.id === row.id ? row : item) : [...current, row]; });
    } else if (event.type === 'caption.correction') {
      setCaptions(current => current.map(item => item.id === `${captionSession.current}:${event.id}` && item.revision === Number(event.revision) ? { ...item, correction: event.correction as Correction } : item));
    } else if (event.type === 'caption.completed') {
      setCaptions(current => current.map(item => item.id === `${captionSession.current}:${event.id}` && item.revision === Number(event.revision) ? { ...item, status: event.provisional ? 'draft' : 'done', timing: event.timing as Record<string, number> } : item));
    } else if (event.type === 'caption.error' || event.type === 'caption.paused') {
      setCaptions(current => current.map(row => (event.type === 'caption.paused' || row.id === `${captionSession.current}:${event.id}`) && (!row.correction || row.correction.status === 'pending') ? { ...row, status: 'canceled', correction: { ...row.correction, correctedSource: row.source, edits: [], status: 'canceled', fallbackReason: String(event.error || '補正を中断しました。') } } : row));
    } else if (event.type === 'caption.ready') { if (event.notice) setNotice(String(event.notice)); }
    else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      // The pinned runtime emits incremental deltas; a completed event replaces them.
      setPartial(current => current + (event.delta ?? event.transcript ?? event.text ?? ''));
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const final = event.transcript ?? event.text ?? '';
      if (final.trim()) {
        setText(current => current ? `${current.trimEnd()}\n${final.trim()}` : final.trim());
        setRecordedOriginal(current => current ? `${current.trimEnd()}\n${final.trim()}` : final.trim());
      }
      setPartial('');
    } else if (event.type === 'error') {
      setError(typeof event.error === 'string' ? event.error : event.error?.message || '音声認識でエラーが発生しました。');
    }
  }

  async function startRecording() {
    if (locked) return;
    setError(''); setNotice(''); setPartial(''); setSeconds(0); setRecordState('connecting');
    captionSession.current = crypto.randomUUID();
    captionDocumentOffset.current = text.replace(/\s/gu, '').length;
    if (output) setNotice('録音の内容を原文に追記します。終了後にAI処理を再実行してください。');
    const recorder = new MicrophoneCapture({ event: onSpeech, level: setLevel, disconnected: () => { setRecordState('idle'); setError('マイクまたは音声認識との接続が終了しました。確定済みの原文は残っています。'); void refresh(); } });
    capture.current = recorder;
    try { await recorder.start(device, language, undefined, { correctionMode: health?.correction?.supported ? correctionMode : 'off' }); if (capture.current !== recorder) return; setRecordState('recording'); void listDevices(); }
    catch (reason) {
      if (capture.current !== recorder) return;
      const cause = reason as Error;
      setError(cause.name === 'NotAllowedError' ? 'マイクが許可されていません。ブラウザのサイト設定でマイクを許可してください。' : cause.name === 'NotFoundError' ? 'マイクが見つかりません。接続を確認してください。' : cause.message);
      setRecordState('idle'); void refresh();
    }
  }
  async function stopRecording() {
    setRecordState('stopping');
    try { await capture.current?.stop(); setPartial(''); await capture.current?.waitForTranslation(); const clip = await capture.current?.comparisonClip(); if (clip) setAudioClip(clip); }
    catch (reason) { setError((reason as Error).message); }
    finally { capture.current?.dispose(); capture.current = null; setRecordState('idle'); void refresh(); }
  }
  useEffect(() => {
    if (recordState === 'idle' && previousRecordState.current !== 'idle' && text.trim()) saveSession();
    previousRecordState.current = recordState;
  }, [recordState]); // Save after final ASR events render; do not duplicate drafts on mount.

  async function processText() {
    if (locked || !text.trim()) return;
    setError(''); setNotice(''); setProcessing(true); setOutput(''); setResultMode(mode);
    const controller = request.current = new AbortController();
    const input = useCorrected ? correctedText : text; setResultInput(useCorrected ? '補正後' : '原文');
    let result = '';
    try {
      const response = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ text: input, mode, model }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'AI処理を開始できません。'); }
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; let done = false;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        if (event.delta) { result += event.delta; setOutput(result); }
        if (event.done) { done = true; if (event.truncated) setNotice('結果が出力上限に達しました。原文を短くして再実行してください。'); if (event.chunked) setNotice('長い文章を区間に分けて処理しました。要約も区間ごとの結果です。'); }
      };
      while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(consume); }
      buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
      if (!done) throw new Error('AIの出力が途中で終了しました。再試行してください。');
      saveSession(text, result, mode, useCorrected ? '補正後' : '原文');
    } catch (reason) { if ((reason as Error).name === 'AbortError') setNotice('AI処理を中断しました。生成済みの文章は残っています。'); else setError((reason as Error).message); }
    finally { setProcessing(false); request.current = null; void refresh(); }
  }

  async function correctDraft() {
    if (locked || !text.trim()) return;
    setProcessing(true); setError(''); setNotice('');
    const controller = request.current = new AbortController(); const group = crypto.randomUUID();
    setCaptions([]);
    try {
      await readNdjson(await fetch('/api/correct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ text, sourceLanguage: language === 'en-US' ? 'en-US' : 'ja-JP', mode: 'conservative', model }) }), event => {
        if (event.type === 'correction') setCaptions(current => [...current, { id: group + ':' + event.index, source: event.rawSource, rawSource: event.rawSource, correction: event.correction, status: 'done' }]);
      });
      setUseCorrected(true);
    } catch (error) { setNotice(controller.signal.aborted ? '補正を中断しました。原文は残っています。' : (error as Error).message); }
    finally { setProcessing(false); request.current = null; void refresh(); }
  }

  function newSession() { saveSession(); setTranslationReset(value => value + 1); sessionId.current = crypto.randomUUID(); setText(''); setRecordedOriginal(''); setCaptions([]); setOutput(''); setPartial(''); setSeconds(0); setError(''); setNotice(''); setAudioClip(null); }
  function loadSession(entry: SavedSession) { saveSession(); navigate(''); sessionId.current = entry.id; setText(entry.text); setRecordedOriginal(entry.recordedOriginal || entry.text); setCaptions(entry.captions || []); setResultInput(entry.resultInput || '原文'); setOutput(entry.output); setResultMode(entry.mode); setMode(entry.mode); setPartial(''); setSeconds(0); setError(''); setNotice(''); }
  async function copy(value: string, key: string) { try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(''), 1800); } catch { setError('コピーできません。本文を選択してコピーしてください。'); } }
  function download() { saveSession(); const content = `# 文字起こし\n\n${recordedOriginal || text}${recordedOriginal && recordedOriginal !== text ? `\n\n# 編集中の原文\n\n${text}` : ''}${captions.length ? `\n\n# 補正後\n\n${correctedText}\n\n${captions.map(row => `${row.stale ? '手編集により現在の原稿へは未適用' : correctionLabel(row.correction)}: ${row.correction?.edits.map(edit => `${edit.from} → ${edit.to}`).join(', ') || '変更なし'}`).join('\n')}` : ''}${output ? `\n\n# ${resultMode === 'cleanup' ? '整形した文章' : '要約'}（入力: ${resultInput}）\n\n${output}` : ''}`; const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `ことば録-${new Date().toISOString().slice(0, 10)}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  return <div className={`app-shell ${liveMode || settingsMode ? 'live-shell' : ''}`}>
    <header className="topbar">
      <a className="brand" href="/" onClick={event => { event.preventDefault(); navigate(''); }} aria-label="ことば録 ホーム"><span className="brand-mark"><AudioLines size={25} /></span><span>ことば録<small>声を、そのまま先へ。</small></span></a>
      <div className="top-actions"><button className="icon-button" disabled={locked || remoteBusy} onClick={() => navigate('#settings')} aria-label="設定"><Settings2 size={20} /></button><span className="local-label"><ShieldCheck size={15} /> {connectionLabel}</span><button className="icon-button mobile-new" onClick={newSession} disabled={locked} aria-label="新しい文字起こし"><Plus size={19} /></button><button className="icon-button" onClick={() => setHelp(true)} aria-label="使い方"><CircleHelp size={20} /></button></div>
    </header>

    <div className="workspace">
      <aside className="sidebar" hidden={liveMode || settingsMode}>
        <div className="sidebar-heading"><span>作業スペース</span><button className="icon-button" onClick={newSession} disabled={locked} aria-label="新しい文字起こし"><Plus size={19} /></button></div>
        <div className="settings">
          <label htmlFor="microphone"><Mic size={14} /> マイク</label>
          <select id="microphone" value={device} onChange={event => setDevice(event.target.value)} disabled={locked}><option value="">既定のマイク</option>{devices.filter(item => item.deviceId && item.deviceId !== 'default').map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `マイク ${index + 1}`}</option>)}</select>
          <label htmlFor="language">認識する言語</label>
          <select id="language" value={language} onChange={event => setLanguage(event.target.value)} disabled={locked}><option value="ja-JP">日本語</option><option value="auto" disabled={translationMode}>自動判定（日・英など）</option><option value="en-US">英語</option></select>
          <label htmlFor="model">使用モデル（全LLM共通）</label>
          <select id="model" value={model} disabled aria-label="整形・要約に使うAI"><option value={model}>{model || 'モデルを確認中'}</option></select>
          <label htmlFor="caption-correction">日本語の誤変換補正</label><select id="caption-correction" value={correctionMode} disabled={locked || language !== 'ja-JP'} onChange={event => setCorrectionMode(event.target.value as CorrectionMode)}><option value="conservative">ON · 文脈と読みで補正</option><option value="off">OFF · 原文を使う</option></select>
        </div>
        <button className="button secondary sidebar-llm-settings" disabled={locked || remoteBusy} onClick={() => navigate('#settings')}>LLM接続設定</button>
        <div className="history-heading"><Clock3 size={14} /><span>最近の文字起こし</span></div>
        <div className="history-list">{history.length ? history.map(entry => <button className={`history-item ${entry.id === sessionId.current ? 'selected' : ''}`} key={entry.id} onClick={() => loadSession(entry)} disabled={locked}><FileText size={15} /><span>{entry.title}<small>{new Date(entry.date).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}</small></span></button>) : <p className="history-empty">録音を終えると、ここに<br />履歴が残ります。</p>}</div>
        <div className="engine-status"><div className="engine-title">接続状態<button className={`icon-button ${checking ? 'spinning' : ''}`} onClick={() => void refresh()} disabled={checking} aria-label="接続状態を更新"><RefreshCw size={14} /></button></div><p><span className={`status-dot ${health?.asr.ready ? 'online' : ''}`} />音声認識<span>{health?.asr.ready ? '準備完了' : '未接続'}</span></p><p><span className={`status-dot ${llmReady ? 'online' : ''}`} />文章整形<span>{llmReady ? '接続済み' : '未接続'}</span></p></div>
      </aside>

      <main>
        <div hidden={!settingsMode}><Settings active={settingsMode} locked={locked || remoteBusy && !processing} onBusy={setProcessing} refresh={() => void refresh()} back={() => navigate(settingsBack.current)} /></div>
        <div hidden={settingsMode}>
        <div className="page-heading"><div><h1>{liveMode ? 'ライブ翻訳' : translationMode ? '話した先へ、言葉をつなぐ。' : compareMode ? '同じ声で、確かめよう。' : '話すことから、はじめよう。'}</h1><p>{liveMode ? '話したことと、その訳文を並べて。' : translationMode ? 'Nemotronの文字起こしを、その場で日英翻訳。' : compareMode ? 'NemotronとWhisperの認識を読み比べる。' : '文字に残して、読みやすく整える。'}</p></div>{!compareMode && !translationMode && <button className="button secondary save-button" onClick={download} disabled={!text.trim() || locked}><Download size={16} /> 保存</button>}</div>
        <div className="workspace-tabs" role="group" aria-label="作業モード"><button aria-pressed={liveMode} className={liveMode ? 'active' : ''} disabled={locked} onClick={() => navigate('#live')}>ライブ翻訳</button><button aria-pressed={!compareMode && !translationMode} className={!compareMode && !translationMode ? 'active' : ''} disabled={locked} onClick={() => navigate('')}>文字起こし・整形</button><button aria-pressed={compareMode} className={compareMode ? 'active' : ''} disabled={locked} onClick={() => navigate('#compare')}>Whisperと比較</button><button aria-pressed={translationMode && !liveMode} className={translationMode && !liveMode ? 'active' : ''} disabled={locked} onClick={() => navigate('#translate')}>リアルタイム翻訳</button></div>

        <section hidden={translationMode} className={`recorder ${recording ? 'is-recording' : ''}`} aria-label="録音操作">
          <div className="record-control"><button className={`record-button ${recording ? 'stop' : ''}`} onClick={() => void (recording ? stopRecording() : startRecording())} disabled={translationMode || processing || (remoteBusy && !recording) || recordState === 'connecting' || recordState === 'stopping' || (!health?.asr.ready && !recording)} aria-label={recording ? '録音を停止' : '録音を開始'}>{recordState === 'connecting' || recordState === 'stopping' ? <LoaderCircle className="spinning" size={24} /> : recording ? <Square size={21} fill="currentColor" /> : <Mic size={25} />}</button><div><h2>{recordState === 'connecting' ? 'マイクに接続しています' : recordState === 'stopping' ? '最後の言葉を確定しています' : recording ? '声を聞いています' : 'マイクから文字起こし'}</h2><p>{recording ? '話し終えたら、停止ボタンを押してください。' : health?.asr.ready ? 'ボタンを押して、いつもの言葉で話してください。' : '音声認識の起動を待っています。原文の直接入力もできます。'}</p></div></div>
          <div className="signal"><div className="level-bars" aria-label={`マイク音量 ${Math.round(level * 100)}%`}>{Array.from({ length: 25 }, (_, i) => <span key={i} style={{ height: `${recording ? 6 + level * 42 * (0.35 + 0.65 * Math.abs(Math.sin(i * 1.3))) : 5}px` }} />)}</div><span className="timer">{timeLabel(seconds)}</span></div>
        </section>

        {error && <div role="alert" className="message error"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="エラーを閉じる"><X size={16} /></button></div>}
        {recordState === 'connecting' && <button className="button secondary" onClick={() => { capture.current?.dispose(); setRecordState('idle'); }}>準備を中止</button>}
        {recordState === 'stopping' && <button className="button secondary" onClick={() => capture.current?.cancelTranslation()}>残りの補正を中断</button>}
        {notice && <div role="status" className="message notice"><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="通知を閉じる"><X size={16} /></button></div>}

        <div hidden={!compareMode}><Comparison clip={audioClip} onClip={setAudioClip} locked={locked} onBusy={setProcessing} language={language} ready={Boolean(health?.whisper?.ready)} refresh={() => void refresh()} /></div><div hidden={!translationMode}>{liveMode ? <LiveTranslation {...translationProps} controller={translation} devices={devices} setDevice={setDevice} openDetails={() => navigate('#translate')} openSettings={() => navigate('#settings')} /> : <Translation {...translationProps} controller={translation} />}</div><div className="editor-grid" hidden={compareMode || translationMode}>
          <section className="editor original">
            <div className="editor-heading"><div><span className="section-icon"><AlignLeft size={17} /></span><h2>文字起こし</h2>{recording && <span className="live-indicator">録音中</span>}</div><button className="icon-button" disabled={!text || locked} onClick={() => void copy(text, 'original')} aria-label="原文をコピー">{copied === 'original' ? <Check size={17} /> : <Copy size={17} />}</button></div>
            <div className="original-content"><label className="sr-only" htmlFor="transcript">文字起こしの原文</label><textarea ref={originalInput} id="transcript" value={text} onChange={event => { setText(event.target.value); setUseCorrected(false); setCaptions(current => current.map(row => ({ ...row, stale: true }))); setNotice('手編集後の文章は補正をやり直してください。認識原文は保存されています。'); if (output) setNotice('原文を変更しました。必要に応じてAI処理を再実行してください。'); }} readOnly={locked} placeholder={'録音すると、話した言葉がここに表示されます。\n\nテキストを貼り付けて、文章の整形だけを試すこともできます。'} maxLength={24000} spellCheck={false} /><div className="partial" aria-live="polite">{partial && <><span className="partial-dot" />{partial}</>}</div><div ref={originalEnd} aria-hidden="true" /></div>
            <div className="editor-foot"><span>{text.length.toLocaleString()} / 24,000 文字</span><span>原文はそのまま残ります</span></div>
          </section>

          <section className="editor result" aria-busy={processing}>
            <div className="editor-heading"><div><span className="section-icon accent"><FileText size={17} /></span><h2>{resultMode === 'cleanup' ? '整えた文章' : '要約'}</h2></div><button className="icon-button" disabled={!output || processing} onClick={() => void copy(output, 'result')} aria-label="整形結果をコピー">{copied === 'result' ? <Check size={17} /> : <Copy size={17} />}</button></div>
            <div className="result-content">{output ? <div className="output-text">{output}<div ref={outputEnd} /></div> : <div className="result-empty"><div className="empty-sheet"><AlignLeft size={30} strokeWidth={1.25} /></div><h3>{processing ? '文章を読み込んでいます' : '声の記録を、読める文章に。'}</h3><p>{processing ? '最初の出力まで少しお待ちください。' : <>言い直しや「あの」「えっと」を整理。<br />伝えたい内容は、そのままに。</>}</p></div>}</div>
            <div className="processing-toolbar"><div className="mode-select" role="group" aria-label="AIの処理方法"><button className={mode === 'cleanup' ? 'active' : ''} onClick={() => setMode('cleanup')} disabled={locked} aria-pressed={mode === 'cleanup'}><SlidersHorizontal size={14} /> 整形</button><button className={mode === 'summary' ? 'active' : ''} onClick={() => setMode('summary')} disabled={locked} aria-pressed={mode === 'summary'}><List size={15} /> 要約</button></div>{processing ? <button className="button secondary" onClick={() => request.current?.abort()}><Square size={13} /> 中断</button> : <button className="button primary" onClick={() => void processText()} disabled={!text.trim() || locked || !llmReady}>{mode === 'cleanup' ? '文章を整える' : '要約する'}<ArrowUpRight size={16} /></button>}</div>
            <div className="editor-foot"><span>{processing ? <><LoaderCircle size={12} className="spinning" /> AIが処理しています</> : '録音終了後にAIで処理 · 入力: ' + resultInput}</span><span>{model || 'モデルを確認中'}</span></div>
          </section>
        </div>
        {!compareMode && !translationMode && <section className="correction-panel" aria-label="日本語の補正結果">
          <div className="correction-heading"><h2>補正後の文章</h2><div className="correction-actions"><label><input type="checkbox" checked={useCorrected} onChange={event => setUseCorrected(event.target.checked)} disabled={locked} /> 整形・要約に補正後を使う</label><button className="button secondary" disabled={locked || !text.trim() || language === 'en-US'} onClick={() => void correctDraft()}>補正をやり直す</button><button className="button secondary" disabled={!correctedText} onClick={() => void copy(correctedText, 'corrected')}>補正後をコピー</button></div></div>
          <p className="comparison-note">認識原文はそのまま保持します。同じ読みの漢字語だけを検証して適用し、補正できない場合は原文を使います。単語登録はありません。</p>
          <div ref={correctedInput} className="corrected-document">{correctedText || '録音または原文の入力後に、文脈を使って補正します。'}</div>
          <details><summary>原文・補正差分と処理状態（{captions.length}区間）</summary>{captions.map(row => <article key={row.id}><p>{row.rawSource || row.source}</p><small>{row.stale ? '手編集のため再補正が必要' : correctionLabel(row.correction)}</small>{row.correction?.edits.map((edit, index) => <p key={index}>{edit.from} → {edit.to}</p>)}</article>)}{recordedOriginal && recordedOriginal !== text && <pre>{recordedOriginal}</pre>}</details>
        </section>}
        <footer className="workspace-footer"><span><Headphones size={14} /> 日本語も、英語も。あなたのペースで。</span><span>{liveMode ? '会話はこのブラウザに保存' : '文章はこのブラウザに保存 · 比較音声は一時保持'} <ChevronRight size={13} /></span></footer>
        </div>
      </main>
    </div>
    <dialog ref={helpDialog} aria-label="使い方" className="help-dialog" onCancel={() => setHelp(false)} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setHelp(false); } }}><button className="icon-button dialog-close" autoFocus onClick={() => setHelp(false)} aria-label="使い方を閉じる"><X size={20} /></button><h2>ことば録の使い方</h2><ol><li>マイクと言語を選び、録音を開始します。</li><li>話し終えたら停止し、文字起こしを確認します。</li><li>「文章を整える」または「要約する」を実行します。</li></ol><p>「ライブ翻訳」では言語を選んで開始すると、最新の対訳が上に表示されます。履歴を読んでいる間は表示位置を保ちます。終了後に会話のコピー・保存や詳細画面への切替ができます。</p><p>「リアルタイム翻訳」では日英の方向を選んで「翻訳を開始」を押します。文のまとまりを認識して翻訳し、続きがある場合は少し待ちます。長くなる場合は仮訳を表示して更新します。停止後も残りの翻訳を完了します。</p><p>録音はNemotron、文章の処理は設定したLLM接続先で行います。録音の先頭2分は比較用にブラウザ内で一時保持します。比較処理ではサーバーに一時ファイルを作り、処理後に削除します。原文・整形結果と最近12件の履歴はこのブラウザに保存します。</p><p>日英が切り替わるときは「自動判定」をお試しください。AIの結果は原文と照らし合わせて確認してください。</p><button className="button primary" onClick={() => setHelp(false)}>はじめる</button></dialog>
  </div>;
}
