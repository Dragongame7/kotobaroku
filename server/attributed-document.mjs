import { splitUtterance } from './translation.mjs';

const normalize = value => value.replace(/\s/gu, '');
export function documentChunks(text, attribution) {
  if (!Array.isArray(attribution) || !attribution.length) return splitUtterance(text);
  if (attribution.length > 500 || attribution.some(row => typeof row?.text !== 'string' || typeof row?.id !== 'string' || row.id.length > 160 || typeof row?.speaker !== 'string' || row.speaker.length > 100)) throw new Error('話者付き原稿の形式が正しくありません。');
  if (normalize(attribution.map(row => row.text).join('')) !== normalize(text)) throw new Error('話者付き原稿が現在の本文と一致しません。');
  const chunks = []; let group = [], bytes = 0;
  for (const row of attribution) for (const part of splitUtterance(row.text)) {
    const entry = { sourceId: row.id, speaker: row.speaker, text: part }, size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes && bytes + size > 2400) { chunks.push(JSON.stringify(group)); group = []; bytes = 0; }
    group.push(entry); bytes += size;
  }
  if (group.length) chunks.push(JSON.stringify(group));
  return chunks;
}
