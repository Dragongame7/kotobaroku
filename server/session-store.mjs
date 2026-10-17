import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { restrict } from './llm-settings.mjs';

const validId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export class SessionStore {
  constructor(directory) { this.directory = directory; this.writers = new Map(); }
  location(id) { if (!validId(id)) throw new Error('会議IDが不正です。'); return path.join(this.directory, id, 'events.jsonl'); }
  create(settings) {
    if (!this.directory) return null;
    const id = randomUUID(), file = this.location(id), directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); restrict(directory, true);
    const fd = fs.openSync(file, 'wx', 0o600); restrict(file);
    this.writers.set(id, { fd, sequence: 0, bytes: 0, createdAt: new Date().toISOString(), rows: new Set(), indexedAt: 0 });
    try { this.append(id, { type: 'meeting.started', settings, sessionId: id, schemaVersion: 3 }); return id; }
    catch (error) { fs.closeSync(fd); this.writers.delete(id); throw error; }
  }
  append(id, event) {
    if (!id) return;
    const writer = this.writers.get(id);
    if (!writer) throw new Error('会議の保存が終了しています。');
    const line = JSON.stringify({ ...event, sequence: ++writer.sequence, savedAt: new Date().toISOString() }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > 1024 * 1024 || writer.bytes + bytes > 128 * 1024 * 1024) throw new Error('会議の保存上限に達しました。テキストを保存して録音を終了してください。');
    fs.writeSync(writer.fd, line); fs.fsyncSync(writer.fd); writer.bytes += bytes;
    if (/^(translation|caption)\.segment$/.test(event.type)) writer.rows.add(event.segment.id);
    if (Date.now() - writer.indexedAt >= 5000 || event.type === 'meeting.ended') this.index(id, event.type === 'meeting.ended' ? event.reason : 'recording');
  }
  index(id, status) {
    const writer = this.writers.get(id), file = path.join(path.dirname(this.location(id)), 'summary.json');
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ id, createdAt: writer.createdAt, status, count: writer.rows.size, incomplete: false }), { mode: 0o600 });
    fs.renameSync(temporary, file); writer.indexedAt = Date.now();
  }
  finish(id, reason = 'completed') {
    if (!id || !this.writers.has(id)) return;
    try { this.append(id, { type: 'meeting.ended', reason }); }
    finally { fs.closeSync(this.writers.get(id).fd); this.writers.delete(id); }
  }
  read(id) {
    const file = this.location(id);
    const size = fs.statSync(file).size;
    if (size > 128 * 1024 * 1024) throw new Error('会議ファイルが大きすぎます。');
    const text = fs.readFileSync(file, 'utf8'), events = []; let incomplete = false;
    const lines = text.split('\n');
    if (lines.at(-1)) { lines.pop(); incomplete = true; }
    for (const line of lines) { if (!line) continue; try { events.push(JSON.parse(line)); } catch { incomplete = true; break; } }
    const rows = new Map(), speakers = {}; let ended;
    for (const event of events) {
      if (event.type === 'speaker.renamed') speakers[event.speakerId] = event.name;
      if (event.type === 'meeting.ended') ended = event;
      if (/^(translation|caption)\.segment$/.test(event.type)) rows.set(event.segment.id, { ...event.segment });
      if (/^(translation|caption)\.(completed|correction|error)$/.test(event.type)) {
        const row = rows.get(event.id);
        if (row && row.revision === event.revision) Object.assign(row, event.type.endsWith('.error') ? { status: 'error', error: event.error } : event.type.endsWith('.correction') ? { correction: event.correction, translationInput: event.translationInput } : { translation: event.text || '', status: event.provisional ? 'draft' : 'done', ...(event.model ? { model: event.model } : {}), ...(event.llm ? { llm: event.llm } : {}) });
      }
    }
    return { id, createdAt: events[0]?.savedAt, settings: events[0]?.settings, status: this.writers.has(id) ? 'recording' : ended?.reason || 'interrupted', incomplete, speakers, rows: [...rows.values()], utterances: events.filter(event => event.type === 'speech.final'), gaps: events.filter(event => event.type === 'meeting.gap') };
  }
  list() {
    if (!this.directory || !fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(validId).map(id => {
      try {
        const writer = this.writers.get(id);
        if (writer) return { id, createdAt: writer.createdAt, status: 'recording', count: writer.rows.size, incomplete: false };
        const file = path.join(path.dirname(this.location(id)), 'summary.json');
        if (fs.existsSync(file)) { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return { ...value, status: value.status === 'recording' ? 'interrupted' : value.status }; }
        const value = this.read(id); return { id, createdAt: value.createdAt, status: value.status, count: value.rows.length, incomplete: value.incomplete };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 100);
  }
  rename(id, speakerId, name) {
    if (!/^spk-[1-8]$/.test(speakerId) || typeof name !== 'string' || !name.trim() || name.length > 40 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('話者名は1〜40文字で入力してください。');
    this.record(id, { type: 'speaker.renamed', speakerId, name: name.trim() });
    return this.read(id).speakers;
  }
  record(id, event) {
    this.read(id);
    if (this.writers.has(id)) this.append(id, event);
    else {
      // A crash may leave an incomplete final line. Keep the recoverable prefix.
      const file = this.location(id), text = fs.readFileSync(file, 'utf8');
      const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      let sequence = 0;
      for (const line of complete.split('\n').filter(Boolean)) { try { sequence = Math.max(sequence, JSON.parse(line).sequence || 0); } catch { throw new Error('会議ファイルが破損しているため変更できません。復元できた本文を保存してください。'); } }
      const encoded = JSON.stringify({ ...event, sequence: sequence + 1, savedAt: new Date().toISOString() }) + '\n';
      if (Buffer.byteLength(complete) + Buffer.byteLength(encoded) > 128 * 1024 * 1024) throw new Error('会議ファイルの保存上限に達しました。');
      if (!text.endsWith('\n')) fs.truncateSync(file, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
      const fd = fs.openSync(file, 'a'); try { fs.writeSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
}
