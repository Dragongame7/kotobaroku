import { useEffect, useState } from 'react';

export type SpeechMetadata = { sessionId?: string; audioStart?: number; audioEnd?: number; speaker?: { sessionId: string; speakerId: string | null; status: string; origin: string } };
const names = new Map<string, Record<string, string>>();
const pending = new Map<string, Promise<Record<string, string>>>();
export function speakerPrefix(row: SpeechMetadata) {
  if (!row.speaker) return '';
  const id = row.speaker.speakerId;
  const name = id ? names.get(row.speaker.sessionId)?.[id] || `話者${id.replace('spk-', '')}` : '話者不明';
  const time = Number.isFinite(row.audioStart) ? `${Math.floor(row.audioStart! / 60)}:${String(Math.floor(row.audioStart! % 60)).padStart(2, '0')} · ` : '';
  return `${time}${name}`;
}
export default function SpeakerLabel({ row }: { row: SpeechMetadata }) {
  const [version, refresh] = useState(0), [editing, setEditing] = useState(false), [value, setValue] = useState(''), [error, setError] = useState('');
  const session = row.speaker?.sessionId, id = row.speaker?.speakerId;
  useEffect(() => {
    if (!session) return;
    let alive = true;
    if (!names.has(session)) {
      if (!pending.has(session)) pending.set(session, fetch(`/api/sessions/${session}/speakers`).then(async response => { if (!response.ok) throw new Error(); const result = await response.json(); names.set(session, result); if (names.size > 100) names.delete(names.keys().next().value!); return result; }).finally(() => pending.delete(session)));
      void pending.get(session)!.then(() => { if (alive) refresh(n => n + 1); }).catch(() => {});
    }
    const updated = () => refresh(n => n + 1);
    window.addEventListener('kotoba-speakers', updated);
    return () => { alive = false; window.removeEventListener('kotoba-speakers', updated); };
  }, [session]);
  if (!row.speaker) return null;
  const label = speakerPrefix(row); void version;
  async function save() {
    try {
      const response = await fetch(`/api/sessions/${session}/speakers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      names.set(session!, data); window.dispatchEvent(new Event('kotoba-speakers')); setEditing(false); setError('');
    } catch (reason) { setError((reason as Error).message || '話者名を保存できません。'); }
  }
  return <div className="speaker-label" data-speaker={id || 'unknown'}>
    {editing ? <form onSubmit={event => { event.preventDefault(); void save(); }}><label>会議内の話者名<input autoFocus maxLength={40} required value={value} onChange={event => setValue(event.target.value)} /></label><button className="button secondary" type="submit">名前を保存</button><button className="button secondary" type="button" onClick={() => setEditing(false)}>中止</button></form> : <><button type="button" className="speaker-name" disabled={!id} title={id ? 'この会議内の話者名を変更' : undefined} onClick={() => { setValue(names.get(session!)?.[id!] || `話者${id!.replace('spk-', '')}`); setEditing(true); }}>{label}</button>{id && <small>推定</small>}</>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
