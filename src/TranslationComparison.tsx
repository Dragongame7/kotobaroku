import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Square } from 'lucide-react';

export type TranslationModel = { model: string; label: string; profile: string; installed: boolean };
export type TranslationSettings = { comparisonSupported?: boolean; models: TranslationModel[]; defaultModel: string; boundaryModel: string };
type Item = { text: string; sourceLanguage: string; targetLanguage: string };
type Result = { type: string; model: string; index?: number; source?: string; error?: string; warmMs?: number; result?: { text: string; firstTokenMs?: number; elapsedMs: number; profile?: string }; residency?: { gpuBytes?: number; fullyOnGpu?: boolean | null } | null };
export default function TranslationComparison({ items, models, locked, onBusy, supported = true }: { items: Item[]; models: TranslationModel[]; locked: boolean; onBusy: (busy: boolean) => void; supported?: boolean }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [compared, setCompared] = useState<TranslationModel[]>([]);
  const [snapshot, setSnapshot] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [date, setDate] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run() {
    if (running || locked || !supported || !items.length) return;
    const selected = models.filter(model => model.installed).slice(0, 3);
    if (selected.length < 2) return;
    const input = items.slice(-5).map(item => ({ ...item }));
    setRunning(true); onBusy(true); setResults([]); setCompared(selected); setSnapshot(input); setError(''); setDate(new Date().toISOString());
    const abort = controller.current = new AbortController();
    try {
      const response = await fetch('/api/translate/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ models: selected.map(item => item.model), items: input }) });
      if (!response.ok) throw new Error((await response.json()).error || '比較を開始できません。');
      let pending = '', done = false;
      const decoder = new TextDecoder(), reader = response.body!.getReader();
      const consume = (line: string) => {
        if (!line.trim()) return; const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'done') done = true;
        else setResults(current => [...current, event]);
      };
      while (true) { const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); const lines = pending.split('\n'); pending = lines.pop() || ''; lines.forEach(consume); }
      pending += decoder.decode(); if (pending.trim()) consume(pending);
      if (!done) throw new Error('比較が途中で終了しました。完了した結果は残っています。');
    } catch (reason) { setError(abort.signal.aborted ? '比較を中断しました。完了した結果は残っています。' : (reason as Error).message); }
    finally { controller.current = null; setRunning(false); onBusy(false); }
  }
  function save() {
    const blob = new Blob([JSON.stringify({ createdAt: date, items: snapshot, models: compared, context: 'none', results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `翻訳モデル比較-${date.slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="translation-benchmark">
    <summary>翻訳モデルを比較</summary>
    {!supported && <p>外部接続でのモデル比較は未対応です。以前の比較結果はそのまま確認できます。</p>}
    <p>録音停止後、直近の確定原文（最大5文）を同じ条件・前後文脈なしで順番に翻訳します。訳抜けや数字の正確さを見比べてください。</p>
    <div className="translation-bench-actions">{running ? <button className="button secondary" onClick={() => controller.current?.abort()}><Square size={14} /> 比較を中断</button> : <button className="button secondary" onClick={() => void run()} disabled={!supported || locked || !items.length || models.filter(item => item.installed).length < 2}>直近の原文で比較</button>}{results.some(item => item.result) && <button className="button secondary" onClick={save} disabled={running}><Download size={14} /> 比較結果を保存</button>}</div>
    {error && <p className="message error" role="alert">{error}</p>}
    <div className="translation-bench-grid">{compared.map(model => {
      const entries = results.filter(item => item.model === model.model), warmMs = entries.find(item => item.warmMs !== undefined)?.warmMs;
      return <article className="translation-bench-model" key={model.model}><h3>{model.label}</h3>{warmMs !== undefined && <small>モデル準備 {warmMs.toLocaleString()} ms</small>}{entries.some(item => item.type === 'model.started') && !entries.some(item => item.result || item.error) && running && <p><LoaderCircle className="spinning" size={14} /> 翻訳しています</p>}{entries.filter(item => item.result || item.error).map((entry, index) => <div className="translation-bench-result" key={`${entry.index ?? index}:${entry.type}`}><p className="translation-bench-source">{entry.source}</p>{entry.error ? <p className="caption-error">{entry.error}</p> : <><p>{entry.result!.text}</p><small>最初の訳文 {entry.result!.firstTokenMs ?? '—'} ms · 完了 {entry.result!.elapsedMs} ms{entry.residency?.gpuBytes !== undefined && <> · GPU常駐 {(entry.residency.gpuBytes / 1024 ** 3).toFixed(1)} GB{entry.residency.fullyOnGpu === false && '（CPU併用）'}</>}</small></>}</div>)}</article>;
    })}</div>
    {compared.length > 0 && <p>時間は翻訳要求からの実測で、音声認識・文末の待ち時間を含みません。GPU常駐量はモデルの測定値で、GPU全体のピーク使用量ではありません。</p>}
  </details>;
}
