import { useEffect, useRef, useState } from 'react';
import { MicrophoneCapture, type SpeechEvent } from './audio';
import type { TranslationSettings } from './TranslationComparison';
import { correctionLabel, type Correction, type CorrectionMode } from './corrections';
import type { Caption } from './translation-types';
import { speakerPrefix } from './SpeakerLabel';
export type TranslationProps = { correctionMode: CorrectionMode; setCorrectionMode: (value: CorrectionMode) => void; device: string; language: string; setLanguage: (value: string) => void; model: string; settings?: TranslationSettings; ready: boolean; locked: boolean; onBusy: (busy: boolean) => void; refresh: () => void; resetKey: number };
function savedCaptions(): Caption[] { try { const saved = JSON.parse(localStorage.getItem('kotoba.translation') || '[]'); return Array.isArray(saved) ? saved.filter(item => typeof item?.id === 'string' && typeof item.source === 'string' && typeof item.translation === 'string').map(item => ({ ...item, correction: item.correction?.status === 'pending' ? { ...item.correction, status: 'canceled' } : item.correction, status: ['assembling', 'draft', 'queued', 'translating'].includes(item.status) ? 'canceled' : item.status })) : []; } catch { return []; } }
export const labels = { assembling: '続きを待っています', draft: '仮訳 · 続きを待っています', queued: '翻訳待ち', translating: '翻訳中', done: '確定', error: '失敗', canceled: '中断' };
export const sentenceModes = { speed: { label: '速度重視', seconds: 6, chars: 100 }, balanced: { label: 'バランス重視', seconds: 10, chars: 150 }, context: { label: '文脈重視', seconds: 15, chars: 200 } };
export type SentenceMode = keyof typeof sentenceModes;
function savedSentenceMode(): SentenceMode { try { const value = localStorage.getItem('kotoba.sentence-mode') || ''; return Object.hasOwn(sentenceModes, value) ? value as SentenceMode : 'balanced'; } catch { return 'balanced'; } }
export function boundaryLabel(boundary?: string) { return boundary === 'speaker-change' ? '話者の交代で区切りました。' : boundary === 'time' ? '待ち時間の上限で区切りました。' : boundary === 'length' ? '文字数の上限で区切りました。' : boundary === 'limit' ? '長文のため途中で区切りました。' : ''; }

export function useLiveTranslation({ correctionMode, device, language, model: generalModel, settings, ready, locked, onBusy, refresh, resetKey }: TranslationProps) {
  const [rows, setRows] = useState<Caption[]>(savedCaptions);
  const [diarization, setDiarization] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'recording' | 'stopping' | 'draining'>('idle');
  const [partial, setPartial] = useState('');
  const [partialSegmentId, setPartialSegmentId] = useState<string | null>(null);
  const partialSpeech = useRef({ text: '', id: null as string | null, session: '' });
  const [pending, setPending] = useState(0);
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [boundaryMode, setBoundaryMode] = useState<'llm' | 'rules'>('llm');
  const [sentenceMode, setSentenceMode] = useState<SentenceMode>(savedSentenceMode);
  const [boundaryNotice, setBoundaryNotice] = useState('');
  const [comparing, setComparing] = useState(false);
  const recorder = useRef<MicrophoneCapture | null>(null);
  const retry = useRef<AbortController | null>(null);
  const previousReset = useRef(resetKey);
  const sourceLanguage = language === 'en-US' ? 'en-US' : 'ja-JP';
  const targetLanguage = sourceLanguage === 'ja-JP' ? 'en-US' : 'ja-JP';
  const active = phase !== 'idle';
  const busy = active || Boolean(retryId) || comparing;
  const options = settings?.models || [{ model: generalModel, label: generalModel, profile: 'general', installed: true }];
  const model = settings?.defaultModel || generalModel;
  const judge = settings?.boundaryModel || generalModel;
  const sentenceSettings = sentenceModes[sentenceMode];
  useEffect(() => { try { localStorage.setItem('kotoba.sentence-mode', sentenceMode); } catch { /* Preference persistence is optional. */ } }, [sentenceMode]);

  useEffect(() => {
    const persist = () => { try { localStorage.setItem('kotoba.translation', JSON.stringify(rows)); setStorageError(false); } catch { setStorageError(true); } };
    const timer = setTimeout(persist, 350); window.addEventListener('pagehide', persist);
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', persist); };
  }, [rows]);
  useEffect(() => { if (previousReset.current !== resetKey) { setRows([]); setPartial(''); setError(''); previousReset.current = resetKey; } }, [resetKey]);
  useEffect(() => { if (phase !== 'recording') return; const timer = setInterval(() => setSeconds(value => value + 1), 1000); return () => clearInterval(timer); }, [phase]);
  useEffect(() => () => { recorder.current?.dispose(); retry.current?.abort(); }, []);


  function update(id: string, changes: Partial<Caption>) { setRows(current => current.map(row => row.id === id ? { ...row, ...changes } : row)); }
  function receive(event: SpeechEvent, session: string) {
    const id = `${session}:${event.id}`;
    if (event.type === 'meeting.started') { setDiarization(Boolean(event.diarization)); return; }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const segmentId = event.translationSegmentId == null ? null : `${session}:${event.translationSegmentId}`;
      partialSpeech.current = { text: partialSpeech.current.text + (event.delta || ''), id: segmentId, session };
      setPartial(partialSpeech.current.text); setPartialSegmentId(segmentId);
    }
    else if (event.type === 'conversation.item.input_audio_transcription.completed') { partialSpeech.current.text = ''; setPartial(''); setPartialSegmentId(null); }
    else if (event.type === 'translation.segment') {
      const segment = event.segment as Omit<Caption, 'id'> & { id: number };
      if (typeof segment?.source === 'string') setRows(current => {
        const caption = { ...segment, id: `${session}:${segment.id}` };
        const old = current.find(row => row.id === caption.id);
        if (old && (old.revision || 0) > (caption.revision || 0)) return current;
        return old ? current.map(row => row.id === caption.id ? caption : row) : [...current, caption];
      });
    } else if (event.type === 'translation.correction') {
      setRows(current => current.map(row => row.id === id && row.revision === Number(event.revision) ? { ...row, correction: event.correction as Correction, translationInput: event.translationInput as Caption['translationInput'] } : row));
    } else if (['translation.started', 'translation.delta', 'translation.completed', 'translation.error'].includes(event.type)) {
      setRows(current => current.map(row => {
        if (row.id !== id || (event.revision !== undefined && row.revision !== Number(event.revision))) return row;
        if (event.type === 'translation.started') return { ...row, status: 'translating', translation: '', error: undefined };
        if (event.type === 'translation.delta') return { ...row, translation: row.translation + String(event.delta || '') };
        if (event.type === 'translation.completed') return { ...row, status: event.provisional ? 'draft' : 'done', provisional: Boolean(event.provisional), translation: String(event.text || ''), firstTokenMs: Number(event.firstTokenMs), timing: event.timing as Caption['timing'] };
        return { ...row, status: event.canceled ? 'canceled' : 'error', error: String(event.error || '翻訳に失敗しました。') };
      }));
    }
    else if (event.type === 'translation.queue') setPending(Number(event.pending) || 0);
    else if (event.type === 'translation.paused') setPaused(true);
    else if (event.type === 'translation.finished') setRows(current => current.map(row => ['assembling', 'draft', 'queued', 'translating'].includes(row.status) ? { ...row, status: 'canceled' } : row));
    else if (event.type === 'translation.ready') { setBoundaryNotice(String(event.notice || '')); if (event.boundaryMode === 'rules') setBoundaryMode('rules'); }
    else if (event.type === 'error') setError(typeof event.error === 'string' ? event.error : event.error?.message || '接続でエラーが発生しました。');
  }

  function retainPartial() {
    const speech = { ...partialSpeech.current };
    if (!speech.text.trim()) return;
    setRows(current => {
      const old = current.find(row => row.id === speech.id && row.provisional);
      if (old) {
        const original = old.rawSource || old.source;
        const separator = old.sourceLanguage === 'en-US' && !/\s$/.test(original) && !/^\s/.test(speech.text) ? ' ' : '';
        const source = original + separator + speech.text;
        return current.map(row => row === old ? { ...row, source, rawSource: source, status: 'canceled', provisional: true } : row);
      }
      return [...current, { id: `${speech.session}:input`, source: speech.text, translation: '', status: 'canceled', sourceLanguage, targetLanguage, model }];
    });
    partialSpeech.current.text = ''; setPartial(''); setPartialSegmentId(null);
  }

  async function start() {
    if (locked || busy || !ready || recorder.current) return;
    setPhase('connecting'); onBusy(true); setError(''); setBoundaryNotice(''); setPartial(''); setPending(0); setPaused(false); setSeconds(0);
    const session = crypto.randomUUID();
    partialSpeech.current = { text: '', id: null, session }; setPartialSegmentId(null);
    const capture = new MicrophoneCapture({
      event: event => receive(event, session), level: setLevel,
      disconnected: () => {
        if (recorder.current !== capture) return;
        retainPartial();
        setError('接続が終了しました。確定済みの原文と訳文は残っています。');
        setRows(current => current.map(row => ['assembling', 'draft', 'queued', 'translating'].includes(row.status) ? { ...row, status: 'error', error: '接続が終了しました。再試行できます。' } : row));
        setPhase('idle'); onBusy(false); recorder.current = null; refresh();
      },
    });
    recorder.current = capture;
    try {
      await capture.start(device, sourceLanguage, { targetLanguage, model, boundaryMode, sentenceMode, correctionMode });
      if (recorder.current === capture) setPhase('recording');
    } catch (reason) {
      if (recorder.current !== capture) return;
      setError((reason as Error).name === 'NotAllowedError' ? 'ブラウザのサイト設定でマイクの使用を許可して、もう一度開始してください。' : (reason as Error).name === 'NotFoundError' || (reason as Error).name === 'OverconstrainedError' ? 'マイクが見つかりません。接続を確認し、設定でマイクを選び直してください。' : (reason as Error).message);
      recorder.current = null; setPhase('idle'); onBusy(false); refresh();
    }
  }
  function cancelPreparation() { recorder.current?.dispose(); recorder.current = null; setPhase('idle'); onBusy(false); refresh(); }
  async function stop() {
    const capture = recorder.current; if (!capture) return;
    setPhase('stopping');
    try {
      await capture.stop(); if (recorder.current !== capture) return; retainPartial(); setPhase('draining');
      await capture.waitForTranslation();
    } catch (reason) {
      if (recorder.current !== capture) return;
      retainPartial();
      setError((reason as Error).message);
      setRows(current => current.map(row => ['assembling', 'draft', 'queued', 'translating'].includes(row.status) ? { ...row, status: 'error', error: '翻訳が未完了です。再試行できます。' } : row));
    } finally { capture.dispose(); if (recorder.current === capture) { recorder.current = null; setPhase('idle'); onBusy(false); setPending(0); refresh(); } }
  }
  async function retryCaption(row: Caption, modeOverride?: CorrectionMode) {
    if (busy || locked) return;
    setRetryId(row.id); onBusy(true); setError(''); update(row.id, { status: 'translating', error: undefined, model, previousModel: row.previousModel || row.model });
    const controller = retry.current = new AbortController();
    try {
      const index = rows.findIndex(item => item.id === row.id);
      const context = rows.slice(0, index).filter(item => item.status === 'done' && item.sourceLanguage === row.sourceLanguage && item.targetLanguage === row.targetLanguage).slice(-2).map(item => ({ ...item, source: item.translationInput?.text || item.source }));
      const response = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ ...(row.sessionId ? { sessionId: row.sessionId, segmentId: Number(row.id.split(':').at(-1)), inputRevision: row.revision } : {}), text: row.rawSource || row.source, sourceLanguage: row.sourceLanguage, targetLanguage: row.targetLanguage, model, context, correctionMode: modeOverride || correctionMode, correctionContext: rows.slice(0, index).slice(-2).map(item => item.rawSource || item.source) }) });
      if (!response.ok) throw new Error((await response.json()).error || '再試行を開始できません。');
      let buffer = '', output = '', done = false; const decoder = new TextDecoder(); const reader = response.body!.getReader();
      const consume = (line: string) => {
        if (!line.trim()) return; const event = JSON.parse(line); if (event.error) throw new Error(event.error);
        if (event.correction) update(row.id, { correction: event.correction, translationInput: event.translationInput });
        if (event.delta) { output += event.delta; update(row.id, { translation: output }); }
        if (event.done) { done = true; update(row.id, { status: 'done', provisional: false, translation: event.text || output, firstTokenMs: event.firstTokenMs, llm: event.llm }); }
      };
      while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(consume); }
      buffer += decoder.decode(); if (buffer.trim()) consume(buffer); if (!done) throw new Error('翻訳が途中で終了しました。');
    } catch (reason) { update(row.id, { status: controller.signal.aborted ? 'canceled' : 'error', error: controller.signal.aborted ? '翻訳を中断しました。' : (reason as Error).message }); }
    finally { setRetryId(null); retry.current = null; onBusy(false); refresh(); }
  }
  function transcript() { return rows.map(row => `${speakerPrefix(row) ? speakerPrefix(row) + "\n" : ""}${row.sourceLanguage === 'ja-JP' ? '日本語 → English' : 'English → 日本語'} · ${row.model}\n${row.rawSource || row.source}${row.correction?.status === 'applied' ? `\n補正後: ${row.correction.correctedSource}\n変更: ${row.correction.edits.map(edit => `${edit.from} → ${edit.to}`).join(', ')}` : ''}\n${correctionLabel(row.correction)}${row.translationInput ? ` · 翻訳入力: ${row.translationInput.origin === 'corrected' ? '補正後' : '原文'}` : ''}\n${row.translation}${row.status === 'done' ? '' : `\n（${labels[row.status]}${row.translation && row.provisional && row.status !== 'draft' ? '・仮訳' : ''}）`}${boundaryLabel(row.boundary) ? `\n（${boundaryLabel(row.boundary)}）` : ''}`).join('\n\n'); }
  async function copy() { try { await navigator.clipboard.writeText(transcript()); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError('コピーできません。本文を選択してコピーしてください。'); } }
  function save() {
    const url = URL.createObjectURL(new Blob([`# リアルタイム翻訳\n\n${transcript()}\n`], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `ことば録-翻訳-${new Date().toISOString().slice(0, 10)}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { rows, diarization, phase, partial, partialSegmentId, pending, paused, seconds, level, error, storageError, copied, retryId, boundaryMode, setBoundaryMode, sentenceMode, setSentenceMode, boundaryNotice, active, busy, options, model, judge, sentenceSettings, sourceLanguage, targetLanguage, start, cancelPreparation, stop, retryCaption, copy, save, cancelTranslation: () => recorder.current?.cancelTranslation(), cancelRetry: () => retry.current?.abort(), comparisonBusy: (value: boolean) => { setComparing(value); onBusy(value); if (!value) refresh(); }, clear: () => { if (!busy && !locked) { setRows([]); setPartial(''); setError(''); } } };
}
export type TranslationController = ReturnType<typeof useLiveTranslation>;
