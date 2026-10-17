import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, Download, Mic, Square, X, Maximize, Minimize } from 'lucide-react';
import type { TranslationController, TranslationProps } from './useLiveTranslation';
import type { Caption } from './translation-types';
import type { CorrectionMode } from './corrections';
import SpeakerLabel from './SpeakerLabel';

type Props = TranslationProps & { controller: TranslationController; devices: MediaDeviceInfo[]; setDevice: (value: string) => void; openDetails: () => void; openSettings: () => void };
const languageName = (language: string) => language === 'en-US' ? '英語' : '日本語';
function rowStatus(row: Caption) {
  if (row.status === 'error') return 'この文を翻訳できませんでした';
  if (row.status === 'canceled') return '未完了の訳文があります';
  if (row.status === 'assembling' && !row.translation) return '話のまとまりを待っています';
  if (row.status === 'done') return '翻訳済み';
  if (row.status === 'queued' && !row.translation && !row.provisional) return '翻訳を待っています';
  return '訳文を更新中';
}

export default function LiveTranslation({ controller: c, devices, device, setDevice, setLanguage, correctionMode, setCorrectionMode, ready, locked, openDetails, openSettings }: Props) {
  const root = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreenUnavailable, setFullscreenUnavailable] = useState(!document.fullscreenEnabled);
  const [displayNotice, setDisplayNotice] = useState('');
  const [changingDisplay, setChangingDisplay] = useState(false);
  const displayAnchor = useRef<{ id: string; offset: number } | null>(null);
  const changing = useRef(false);
  const layoutChanging = useRef(false);
  const focusAfterDisplay = useRef(false);
  const [fontSize, setFontSize] = useState(() => { try { return localStorage.getItem('kotoba.live-font') === 'large' ? 'large' : 'normal'; } catch { return 'normal'; } });
  const [unread, setUnread] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const known = useRef(new Set(c.rows.map(row => row.id)));
  const disabled = c.busy || locked;
  const partialRow = c.rows.find(row => row.id === c.partialSegmentId && row.provisional);
  const standalonePartial = Boolean(c.partial && !partialRow);
  const focused = fullscreen || expanded;

  useEffect(() => {
    const changed = () => {
      if (!displayAnchor.current) displayAnchor.current = anchor.current;
      layoutChanging.current = true;
      const active = document.fullscreenElement === root.current;
      if (!active) focusAfterDisplay.current = true;
      setFullscreen(active);
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    if (!focused) return;
    const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      displayAnchor.current = anchor.current; layoutChanging.current = true;
      if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
      else if (expanded) { focusAfterDisplay.current = true; setExpanded(false); }
    };
    document.addEventListener('keydown', escape);
    const backgrounds: { element: HTMLElement; inert: boolean }[] = [];
    let element: HTMLElement | null = root.current;
    while (element && element !== document.body) {
      for (const sibling of Array.from(element.parentElement?.children || [])) if (sibling !== element && sibling instanceof HTMLElement) { backgrounds.push({ element: sibling, inert: sibling.inert }); sibling.inert = true; }
      element = element.parentElement;
    }
    return () => { document.body.style.overflow = old; document.removeEventListener('keydown', escape); backgrounds.forEach(({ element, inert }) => { element.inert = inert; }); };
  }, [focused, expanded]);
  async function changeDisplay() {
    if (changing.current) return;
    changing.current = true; layoutChanging.current = true; setChangingDisplay(true); displayAnchor.current = anchor.current; setDisplayNotice('');
    try {
      if (fullscreen) await document.exitFullscreen();
      else if (expanded) { focusAfterDisplay.current = true; setExpanded(false); }
      else if (fullscreenUnavailable || !root.current?.requestFullscreen) setExpanded(true);
      else { try { await root.current.requestFullscreen(); } catch { setFullscreenUnavailable(true); setExpanded(true); setDisplayNotice('全画面表示を利用できないため、ウィンドウ内で画面を広げました。'); } }
    } finally { changing.current = false; setChangingDisplay(false); }
  }
  async function leaveDisplay(action: () => void) {
    if (fullscreen) await document.exitFullscreen();
    setExpanded(false); action();
  }

  function rememberPosition() {
    const box = viewport.current; if (!box) return;
    const top = box.getBoundingClientRect().top + box.clientTop;
    const row = Array.from(box.querySelectorAll<HTMLElement>('[data-row-id]')).find(element => element.getBoundingClientRect().bottom > top + 1);
    anchor.current = row ? { id: row.dataset.rowId!, offset: row.getBoundingClientRect().top - top } : null;
  }
  function restorePosition() {
    const box = viewport.current; if (!box) return;
    if (following.current) { box.scrollTop = 0; rememberPosition(); return; }
    const saved = anchor.current;
    const row = saved && Array.from(box.querySelectorAll<HTMLElement>('[data-row-id]')).find(element => element.dataset.rowId === saved.id);
    if (row && saved) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop - saved.offset;
    rememberPosition();
  }
  useLayoutEffect(() => {
    const added = c.rows.filter(row => !known.current.has(row.id)).length;
    known.current = new Set(c.rows.map(row => row.id));
    if (!following.current && added) setUnread(value => value + added);
    if (!c.rows.length && !c.partial) { following.current = true; setUnread(0); }
    restorePosition();
  }, [c.rows, c.partial, fontSize]);
  useLayoutEffect(() => {
    if (displayAnchor.current && !following.current) anchor.current = displayAnchor.current;
    displayAnchor.current = null; restorePosition();
    const frame = requestAnimationFrame(() => { restorePosition(); layoutChanging.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [focused]);
  useLayoutEffect(() => {
    if (focused || changingDisplay || !focusAfterDisplay.current) return;
    focusAfterDisplay.current = false;
    expandButton.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => expandButton.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focused, changingDisplay]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(restorePosition);
    if (content.current) observer.observe(content.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  function latest() { following.current = true; if (viewport.current) viewport.current.scrollTop = 0; setUnread(0); rememberPosition(); }
  const incomplete = c.rows.some(row => row.status === 'canceled' || row.status === 'error');
  const status = c.phase === 'connecting' ? '翻訳を準備しています' : c.phase === 'recording' ? '聞き取り中 · そのまま話してください' : c.phase === 'stopping' || c.phase === 'draining' ? '聞き取りを停止しました。残りを翻訳しています' : c.retryId ? '選んだ文を翻訳しています' : incomplete ? '未完了の訳文があります' : c.rows.length ? '翻訳が完了しました。会話はそのまま残ります' : '開始すると、話した内容と訳文が表示されます';
  return <section ref={root} className={`live-view live-font-${fontSize} ${focused ? 'live-focused' : ''} ${expanded ? 'live-window-expanded' : ''}`} aria-label="ライブ翻訳">
    <div className="live-toolbar">
      <div className="live-direction"><label htmlFor="live-direction">話す言語 → 訳す言語</label><select id="live-direction" value={c.sourceLanguage} disabled={disabled} onChange={event => setLanguage(event.target.value)}><option value="ja-JP">日本語 → 英語</option><option value="en-US">英語 → 日本語</option></select></div>
      <button className={`button ${c.phase === 'recording' ? 'translation-stop' : 'primary'}`} disabled={c.phase === 'stopping' || c.phase === 'draining' || Boolean(c.retryId) || (c.phase === 'idle' && (locked || !ready))} onClick={() => void (c.phase === 'connecting' ? c.cancelPreparation() : c.phase === 'recording' ? c.stop() : c.start())}>{c.phase === 'connecting' ? <><X size={17} />準備を中止</> : c.phase === 'recording' ? <><Square size={16} fill="currentColor" />翻訳を終了</> : c.phase === 'stopping' || c.phase === 'draining' ? '残りを翻訳しています' : <><Mic size={18} />翻訳を開始</>}</button>
      <label className="live-font-control" htmlFor="live-font">文字サイズ<select id="live-font" value={fontSize} onChange={event => { setFontSize(event.target.value); try { localStorage.setItem('kotoba.live-font', event.target.value); } catch { /* Optional preference. */ } }}><option value="normal">標準</option><option value="large">大きく</option></select></label>
      <button ref={expandButton} className="button secondary live-expand" disabled={changingDisplay} aria-pressed={focused} onClick={() => void changeDisplay()}>{focused ? <Minimize size={16} /> : <Maximize size={16} />}{fullscreen ? '全画面を終了' : expanded ? '元の表示に戻る' : fullscreenUnavailable ? '画面を広げる' : '全画面表示'}</button>
      <div className="live-status" role="status"><span className={`live-input ${c.phase === 'recording' ? 'active' : ''}`} aria-hidden="true" style={{ opacity: c.phase === 'recording' ? .35 + c.level * .65 : 1, transform: `scale(${1 + c.level * .5})` }} />{status}</div>
      <span className="sr-only" role="status">会話 {c.rows.length}件、翻訳済み {c.rows.filter(row => row.status === 'done').length}件、未完了 {c.rows.filter(row => row.status === 'error' || row.status === 'canceled').length}件</span>
      {c.phase === 'draining' && !c.paused && <button className="button secondary" onClick={c.cancelTranslation}>残りの翻訳を中断</button>}
      {c.retryId && <button className="button secondary" onClick={c.cancelRetry}>再翻訳を中断</button>}
    </div>
    {displayNotice && <p className="message notice" role="status">{displayNotice}</p>}
    {!ready && !c.busy && <p className="message notice">翻訳の準備ができていません。接続を確認してから、もう一度開始してください。<button className="button secondary" onClick={() => void leaveDisplay(openSettings)} disabled={disabled}>接続設定を確認</button></p>}
    {c.error && <p className="message error" role="alert">{/Gemma|Ollama|LLM|ASR|Nemotron|モデル/i.test(c.error) ? '翻訳の準備または接続に失敗しました。接続設定を確認し、もう一度開始してください。' : c.error}</p>}
    {c.storageError && <p className="message error" role="alert">ブラウザに保存できません。会話をファイルに保存してください。</p>}
    <div className="live-paper">
      <div className="live-columns" aria-hidden="true"><span>話したこと · {languageName(c.sourceLanguage)}</span><span>翻訳 · {languageName(c.targetLanguage)}</span></div>
      <div className="live-history" ref={viewport} tabIndex={0} aria-label="会話の履歴 · 新しい会話が上" onScroll={() => { if (layoutChanging.current || fullscreen !== (document.fullscreenElement === root.current)) return; following.current = viewport.current!.scrollTop <= 24; if (following.current) setUnread(0); rememberPosition(); }}>
        <div ref={content}>
          {!c.rows.length && !c.partial && <div className="live-empty"><Mic size={30} strokeWidth={1.3} /><h2>話したことの、すぐとなりに。</h2><p>言語を選んで「翻訳を開始」を押してください。<br />話のまとまりに合わせて訳文が届きます。</p></div>}
          {standalonePartial && <article className="live-pair latest" data-row-id="receiving"><div className="live-source"><span className="live-row-label">今、話していること{c.diarization ? ' · 話者判定待ち' : ''} · {languageName(c.sourceLanguage)}</span><p>{c.partial}</p></div><div className="live-target"><span className="live-row-label">話のまとまりを待っています</span></div></article>}
          {[...c.rows].reverse().map((row, index) => <article key={row.id} className={`live-pair ${index === 0 && !standalonePartial ? 'latest' : ''}`} data-row-id={row.id} data-status={row.status}>
            <div className="live-source"><SpeakerLabel row={row} /><span className="live-row-label">{partialRow === row && c.partial ? '今、話していること' : index === 0 && !standalonePartial ? '新しい会話' : '話したこと'} · {languageName(row.sourceLanguage)}</span><p>{row.rawSource || row.source}{partialRow === row && c.partial && <span className="live-partial">{row.sourceLanguage === 'en-US' ? ' ' : ''}{c.partial}</span>}</p></div>
            <div className="live-target"><span className="live-row-label">{rowStatus(row)} · {languageName(row.targetLanguage)}</span><p>{row.translation || (row.status === 'assembling' ? '話のまとまりに合わせて翻訳します。' : row.status === 'queued' ? '順番に翻訳しています。' : row.status === 'translating' ? '訳文が届くまでお待ちください。' : '訳文はまだありません。')}</p>{row.provisional && row.translation && <small>続きに合わせて訳文が変わることがあります。</small>}{['error', 'canceled'].includes(row.status) && <button className="button secondary" disabled={disabled} onClick={() => void c.retryCaption(row)}>この文を再試行</button>}</div>
          </article>)}
        </div>
      </div>
      <div className="live-history-footer"><span>↑ 新しい会話 / ↓ 過去の会話</span><button className="button secondary" hidden={!unread} onClick={latest}><ArrowUp size={14} />新しい会話 {unread}件 · 最新へ戻る</button></div>
    </div>
    <details className="live-settings"><summary>マイクと翻訳の設定</summary><div className="live-setting-fields">
      <label htmlFor="live-microphone">マイク<select id="live-microphone" value={device} disabled={disabled} onChange={event => setDevice(event.target.value)}><option value="">既定のマイク</option>{devices.filter(item => item.deviceId && item.deviceId !== 'default').map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `マイク ${index + 1}`}</option>)}</select></label>
      <label htmlFor="live-timing">訳すタイミング<select id="live-timing" value={c.sentenceMode} disabled={disabled} onChange={event => c.setSentenceMode(event.target.value as typeof c.sentenceMode)}><option value="speed">早め</option><option value="balanced">標準</option><option value="context">文脈を優先</option></select></label>
      <label htmlFor="live-correction">日本語の誤変換補正<select id="live-correction" aria-label="日本語の誤変換補正" value={correctionMode} disabled={disabled || c.sourceLanguage !== 'ja-JP'} onChange={event => setCorrectionMode(event.target.value as CorrectionMode)}><option value="conservative">ON</option><option value="off">OFF</option></select>{c.sourceLanguage === 'en-US' && <small>英語は補正対象外です</small>}</label>
    </div><button className="button secondary" disabled={disabled} onClick={() => void leaveDisplay(openSettings)}>LLM接続設定</button></details>
    <details className={`live-extra ${focused ? '' : 'live-extra-normal'}`} open={focused ? undefined : true}><summary>保存とその他の操作</summary><div className="live-actions">{!c.busy && c.rows.length > 0 && <><button className="button secondary" onClick={() => void c.copy()}>{c.copied ? <Check size={16} /> : <Copy size={16} />}会話をコピー</button><button className="button secondary" onClick={c.save}><Download size={16} />会話を保存</button><button className="button secondary" disabled={disabled} onClick={c.clear}>会話を空にする</button></>}<button className="button secondary live-details" disabled={disabled} onClick={() => void leaveDisplay(openDetails)}>詳細画面を開く</button></div></details>
  </section>;
}
