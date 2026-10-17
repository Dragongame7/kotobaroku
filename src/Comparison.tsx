import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Upload, Play, Square, Download, Copy, Check, LoaderCircle } from 'lucide-react';
import { loadAudio, type AudioClip } from './wav';
import { characterErrorRate } from './quality';
              
type EngineResult = { text: string; elapsedMs: number; model: string; runtime: string; device?: string; fallback?: boolean; settings?: string };
type Props = { clip: AudioClip | null; onClip: (clip: AudioClip) => void; locked: boolean; onBusy: (busy: boolean) => void; language: string; ready: boolean; refresh: () => void };

export default function Comparison({ clip, onClip, locked, onBusy, language, ready, refresh }: Props) {
  const [results, setResults] = useState<Partial<Record<'nemotron' | 'whisper', EngineResult>>>({});
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [clipUrl, setClipUrl] = useState('');
  const [resultLanguage, setResultLanguage] = useState(language);
  const request = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scores = useMemo(() => ({ nemotron: characterErrorRate(reference, results.nemotron?.text || ''), whisper: characterErrorRate(reference, results.whisper?.text || '') }), [reference, results]);
  useEffect(() => {
    setResults({}); setError(''); setReference('');
    if (!clip) { setClipUrl(''); return; }
    const url = URL.createObjectURL(clip.blob); setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function selectFile(file?: File) {
    if (!file) return;
    setError(''); setUploading(true); onBusy(true);
    try { onClip(await loadAudio(file)); }
    catch (reason) { setError((reason as Error).message || '音声を読み込めませんでした。'); }
    finally { setUploading(false); onBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function compare() {
    if (!clip || locked) return;
    setError(''); setResults({}); setBusy(true); onBusy(true); setResultLanguage(language);
    const controller = request.current = new AbortController();
    let finished = false;
    try {
      const response = await fetch(`/api/compare?language=${encodeURIComponent(language)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: clip.blob, signal: controller.signal });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || '比較を開始できません。'); }
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '';
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'result' && ['nemotron', 'whisper'].includes(event.engine)) setResults(current => ({ ...current, [event.engine]: event.result }));
        if (event.type === 'done') finished = true;
      };
      while (true) { const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); const lines = pending.split('\n'); pending = lines.pop() || ''; lines.forEach(consume); }
      pending += decoder.decode(); if (pending.trim()) consume(pending);
      if (!finished) throw new Error('比較が途中で終了しました。再試行してください。');
    } catch (reason) { setError((reason as Error).name === 'AbortError' ? '比較を中断しました。完了した結果は残っています。' : (reason as Error).message); }
    finally { setBusy(false); onBusy(false); request.current = null; refresh(); }
  }
  async function copy(engine: 'nemotron' | 'whisper') {
    try { await navigator.clipboard.writeText(results[engine]?.text || ''); setCopied(engine); setTimeout(() => setCopied(''), 1800); }
    catch { setError('本文を選択してコピーしてください。'); }
  }
  function save() {
    const report = { createdAt: new Date().toISOString(), audio: { name: clip?.name, seconds: clip?.seconds, sampleRate: 16000, channels: 1 }, language: resultLanguage, llmPostprocessing: false, normalization: 'NFKC, lowercase, remove Unicode punctuation and whitespace; numerals unchanged', reference, results, scores: Object.fromEntries(Object.entries(results).map(([engine]) => [engine, scores[engine as 'nemotron' | 'whisper']])) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `文字起こし比較-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="comparison" aria-label="Whisperとの品質比較">
    <div className="comparison-source">
      <div className="comparison-source-title"><ArrowRightLeft size={19} /><div><h2>同じ音声で、認識結果を比べる</h2><p>LLMによる整形をせず、録音後に両モデルで認識します。</p></div></div>
      <div className="comparison-audio"><div><span className="clip-label">{clip ? clip.name : '上で録音するか、音声ファイルを選んでください'}</span><small>{clip ? `${clip.seconds.toFixed(1)}秒 · 同一の16kHzモノラル音声` : '2分以内の音声。マイク録音は先頭2分を比較に使用します。'}</small></div>{clipUrl && <audio controls preload="metadata" src={clipUrl} aria-label="比較する音声を再生" />}</div>
      <div className="comparison-actions"><input className="sr-only" ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.m4a,.flac" aria-label="比較する音声ファイル" onChange={event => void selectFile(event.target.files?.[0])} disabled={locked} /><button className="button secondary" onClick={() => fileInput.current?.click()} disabled={locked}>{uploading ? <LoaderCircle className="spinning" size={15} /> : <Upload size={15} />} 音声を選ぶ</button>{busy ? <button className="button secondary" onClick={() => request.current?.abort()}><Square size={13} /> 比較を中断</button> : <button className="button primary" onClick={() => void compare()} disabled={!clip || locked || !ready}><Play size={15} /> 同じ音声で比較</button>}<button className="button secondary compare-save" onClick={save} disabled={busy || !results.nemotron}><Download size={15} /> 結果を保存</button></div>
      {!ready && <p className="comparison-note">Whisperの準備が必要です。導入後に接続状態を更新してください。</p>}
    </div>
    {error && <p role="alert" className="message error">{error}</p>}
    <div className="comparison-grid">{(['nemotron', 'whisper'] as const).map(engine => {
      const result = results[engine], score = scores[engine];
      const running = busy && !result && (engine === 'nemotron' || Boolean(results.nemotron));
      return <section key={engine} className="comparison-result" aria-busy={running}>
        <div className="comparison-result-head"><div><h3>{engine === 'nemotron' ? 'Nemotron' : 'Whisper'}</h3><span>{engine === 'nemotron' ? '3.5 ASR · Q8' : 'large-v3 · FP16'}</span></div><button className="icon-button" onClick={() => void copy(engine)} disabled={!result} aria-label={`${engine === 'nemotron' ? 'Nemotron' : 'Whisper'}の結果をコピー`}>{copied === engine ? <Check size={16} /> : <Copy size={16} />}</button></div>
        <div className="comparison-transcript" data-testid={`${engine}-transcript`}>{result ? result.text || '（認識結果は空です）' : <p className="comparison-placeholder">{running ? <><LoaderCircle size={17} className="spinning" />{engine === 'whisper' ? 'Whisperで認識しています。モデルの読込を含みます。' : 'Nemotronで認識しています。'}</> : '比較すると、整形前の認識結果が表示されます。'}</p>}</div>
        <div className="comparison-metrics"><div><span>文字誤り率 CER</span><strong data-testid={`${engine}-cer`}>{result && score ? `${score.percent.toFixed(1)}%` : '—'}</strong><small>{result && score ? `${score.errors} / 正解 ${score.length}文字` : '正解文を入力すると計算'}</small></div><div><span>認識処理の所要時間</span><strong>{result ? `${(result.elapsedMs / 1000).toFixed(2)}秒` : '—'}</strong><small>{result?.device ? `${result.device.toUpperCase()}${result.fallback ? '（CPUへ切替）' : ''} · 読込込み` : '録音時間は含みません'}</small></div></div>
      </section>;
    })}</div>
    <div className="comparison-reference"><label htmlFor="comparison-reference">正解の文章 <span>任意 · 音声を聞いて入力してください</span></label><textarea id="comparison-reference" value={reference} onChange={event => setReference(event.target.value)} maxLength={2000} placeholder="音声で実際に話している文章を入力すると、両モデルのCERを計算します。" /><p>CERは低いほど正解文に近くなります。全半角・大文字小文字・句読点・空白を正規化します。漢数字と算用数字、漢字とかなの表記差は誤りとして数えます。</p></div>
    <p className="comparison-note">同じ音声・同じ言語指定で比較します。Nemotronはモデル読込済み、Whisperは毎回読込を含むため、所要時間は参考値です。1本の音声だけでは一般的な優劣は判断できません。音声は比較中のみ一時保持し、処理後にサーバーの一時ファイルを削除します。</p>
  </section>;
}
