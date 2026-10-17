import { useEffect, useState } from 'react';
import SpeakerLabel, { type SpeechMetadata } from './SpeakerLabel';

type Entry = { id: string; createdAt: string; status: string; count: number; incomplete: boolean };
type Meeting = Entry & { speakers: Record<string, string>; rows: (SpeechMetadata & { id: number; source: string; translation?: string; status: string; correction?: { correctedSource: string } })[]; utterances: { transcript: string }[]; gaps: { reason: string }[] };
export default function MeetingHistory({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]), [selected, setSelected] = useState<Meeting>(), [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch('/api/sessions', { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(); setEntries((await response.json()).sessions); }).catch(() => { if (!controller.signal.aborted) setError('端末の会議履歴を取得できません。'); });
    return () => controller.abort();
  }, [active]);
  async function open(id: string) {
    setError('');
    try { const response = await fetch(`/api/sessions/${id}`); if (!response.ok) throw new Error(); setSelected(await response.json()); }
    catch { setError('会議履歴を読み込めません。'); }
  }
  async function download(json = false) {
    if (!selected) return;
    try {
    const response = await fetch(`/api/sessions/${selected.id}`); if (!response.ok) { setError('保存用の会議データを取得できません。'); return; }
    const meeting: Meeting = await response.json();
    const text = meeting.rows.length ? meeting.rows.map(row => `${row.speaker ? meeting.speakers[row.speaker.speakerId || ''] || (row.speaker.speakerId ? `話者${row.speaker.speakerId.replace('spk-', '')}` : '話者不明') : ''}${Number.isFinite(row.audioStart) ? ` · ${row.audioStart!.toFixed(2)}秒` : ''}\n${row.source}${row.correction?.correctedSource && row.correction.correctedSource !== row.source ? `\n補正後: ${row.correction.correctedSource}` : ''}\n${row.translation || ''}\n（${row.status}）`).join('\n\n') : meeting.utterances.map(row => row.transcript).join('\n');
    const content = json ? JSON.stringify(meeting, null, 2) : text + meeting.gaps.map(gap => `\n\n［接続の欠損］${gap.reason}`).join('');
    const url = URL.createObjectURL(new Blob([content], { type: json ? 'application/json' : 'text/plain;charset=utf-8' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `ことば録-${meeting.id}.${json ? 'json' : 'txt'}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('会議データをダウンロードできません。接続と保存先を確認してください。'); }
  }
  return <section className="meeting-history" aria-label="端末に保存した会議"><h2>端末に保存した会議</h2><p>v1.0以降の確定原文・話者・訳文を、この端末のサーバーに保存します。音声ファイルは保存しません。</p>{error && <p role="alert">{error}</p>}
    <div className="meeting-list">{entries.map(entry => <button key={entry.id} className="button secondary" onClick={() => void open(entry.id)}>{new Date(entry.createdAt).toLocaleString('ja-JP')} · {entry.count}区間 · {entry.status === 'completed' ? '終了' : entry.status === 'recording' ? '録音中' : '中断'}</button>)}{!entries.length && <p>保存した会議はまだありません。</p>}</div>
    {selected && <div className="meeting-preview"><h3>{new Date(selected.createdAt).toLocaleString('ja-JP')}</h3><div className="llm-form-actions"><button className="button secondary" onClick={() => void download()}>会議テキストを保存</button><button className="button secondary" onClick={() => void download(true)}>会議JSONを保存</button><button className="button secondary" onClick={() => setSelected(undefined)}>履歴を閉じる</button></div>{selected.incomplete && <p role="status">保存途中の行があるため、復元できた範囲を表示しています。</p>}{selected.gaps.map((gap, index) => <p className="message notice" key={index}>接続の欠損：{gap.reason}</p>)}{selected.rows.length ? selected.rows.map(row => <article key={row.id}><SpeakerLabel row={row} /><p>{row.source}</p>{row.translation && <p>{row.translation}</p>}</article>) : selected.utterances.map((row, index) => <p key={index}>{row.transcript}</p>)}</div>}
  </section>;
}
