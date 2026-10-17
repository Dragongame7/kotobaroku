export type CorrectionMode = 'off' | 'conservative';
export type Correction = { status: string; mode?: CorrectionMode; correctedSource: string; edits: { from: string; to: string; start: number; end: number; reason: string }[]; fallbackReason?: string; elapsedMs?: number; model?: string };
export type CorrectedCaption = { documentOffset?: number; stale?: boolean; id: string; source: string; rawSource?: string; revision?: number; status?: string; correction?: Correction; timing?: Record<string, number> };
export function savedCorrectionMode(): CorrectionMode { try { return localStorage.getItem('kotoba.correction-mode') === 'off' ? 'off' : 'conservative'; } catch { return 'conservative'; } }
export function correctionLabel(correction?: Correction) {
  if (!correction) return '補正待ち';
  if (correction.status === 'applied') return '補正済み';
  if (correction.status === 'unchanged') return '変更なし';
  if (correction.status === 'off') return '未補正';
  if (correction.status === 'pending') return '補正待ち';
  if (correction.status === 'canceled') return '補正中断';
  return correction.fallbackReason || '原文を使用';
}
// ASR inserts display newlines between fragments, while sentence assembly
// joins them. Map whitespace-insensitive offsets back to the untouched draft.
export function correctedDocument(text: string, rows: CorrectedCaption[]) {
  let normalized = ''; const positions: number[] = [];
  for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i])) { normalized += text[i]; positions.push(i); }
  let cursor = 0; const patches: { start: number; end: number; to: string }[] = [];
  for (const row of rows) {
    if (row.stale) continue;
    // New recordings append to an existing, possibly hand-edited draft.
    // Their offsets count non-whitespace UTF-16 units, matching normalized.
    cursor = Math.max(cursor, row.documentOffset || 0);
    const raw = row.rawSource || row.source; const source = raw.replace(/\s/gu, '');
    const offset = normalized.indexOf(source, cursor); if (offset < 0 || !source) continue;
    cursor = offset + source.length;
    for (const edit of row.correction?.status === 'applied' ? row.correction.edits : []) {
      const index = offset + raw.slice(0, edit.start).replace(/\s/gu, '').length;
      const endIndex = offset + raw.slice(0, edit.end).replace(/\s/gu, '').length - 1;
      const start = positions[index], end = positions[endIndex] + 1;
      if (Number.isFinite(start) && Number.isFinite(end) && text.slice(start, end).replace(/\s/gu, '') === edit.from) patches.push({ start, end, to: edit.to });
    }
  }
  let result = text;
  for (const patch of patches.reverse()) result = result.slice(0, patch.start) + patch.to + result.slice(patch.end);
  return result;
}
export async function readNdjson(response: Response, consume: (event: Record<string, any>) => void) {
  if (!response.ok) throw new Error((await response.json()).error || '処理を開始できません。');
  const decoder = new TextDecoder(); let buffer = ''; let done = false;
  const line = (value: string) => { if (!value.trim()) return; const event = JSON.parse(value); if (event.error) throw new Error(event.error); consume(event); if (event.done) done = true; };
  const reader = response.body!.getReader();
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(line); } buffer += decoder.decode(); if (buffer.trim()) line(buffer); if (!done) throw new Error('結果が途中で終了しました。'); }
  finally { reader.releaseLock(); }
}
