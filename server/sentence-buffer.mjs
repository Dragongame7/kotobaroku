import { sliceSpeechPart } from './speaker-segments.mjs';
export const MAX_SENTENCE_BYTES = 1200;
export const SENTENCE_MODES = Object.freeze({
  speed: { maxWaitMs: 6000, maxChars: 100, softChars: 55 },
  balanced: { maxWaitMs: 10000, maxChars: 150, softChars: 80 },
  context: { maxWaitMs: 15000, maxChars: 200, softChars: 110 },
});
const bytes = text => Buffer.byteLength(text, 'utf8');
const bare = text => text.trim().replace(/[。.!?！？」』”"'）)]+$/u, '').trim();

export function sentenceState(text, language) {
  const value = bare(text);
  if (/^(はい|いいえ|こんにちは|こんばんは|ありがとう(?:ございます)?|yes|no|hello|thanks|thank you)$/iu.test(value)) return 'complete';
  if (language === 'ja-JP') {
    if (/(?:ですが|ますが|けど|けれど(?:も)?|ので|だから|ため|なら|ても|および|または|そして|[がはをにのともでてし])$/u.test(value)) return 'continuation';
    if (/[。！？!?][」』”"'）)]*$/u.test(text.trim()) || /(?:です|ます|でした|ました|ません|ください|でしょう|だろう|必要だ|と思う)$/u.test(value)) return 'complete';
  } else {
    if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|\be\.g|\bi\.e)\.$/u.test(text.trim())) return 'continuation';
    if (/\b(?:and|but|or|because|if|although|when|while|unless|so|to|of|for|with|at|in|on|from|the|a|an|is|are|was|were|will|would|can|could|should|have|has|that|which)$/iu.test(value)) return 'continuation';
    if (/^(?:if|because|although|when|while|unless)\b/iu.test(value) && !/[,;]/u.test(value)) return 'unknown';
    if (/[.!?][”"')]*$/u.test(text.trim())) return 'complete';
  }
  return 'unknown';
}

// All offsets come from the original text. The model selects a candidate ID;
// it never supplies rewritten text or an unchecked character offset.
export function sentenceCandidates(text, partEnds = [], language) {
  const ends = new Set(partEnds);
  for (const match of text.matchAll(/[。！？!?]+[」』”"'）)]*/gu)) ends.add(match.index + match[0].length);
  for (const match of text.matchAll(/\.+[”"')]*(?=\s|$)/gu)) {
    const offset = match.index;
    if (text[offset - 1] === '.' || text[offset + 1] === '.') continue;
    if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|\be\.g|\bi\.e)$/u.test(text.slice(0, offset))) continue;
    ends.add(offset + match[0].length);
  }
  ends.add(text.length);
  const semanticEnds = new Set();
  const clauseStarts = new Set();
  // Internal clause candidates are offered to the judge, not automatically
  // treated as complete sentences by the fast rules.
  if (language === 'ja-JP') {
    for (const match of text.matchAll(/(?:でした|ました|ません|でしょう|ください|と思う|必要だ|です|ます|だった|した|する|ある|いる)(?![がので]|けど|けれど|なら|という)|[、，；;]/gu)) semanticEnds.add(match.index + match[0].length);
  } else if (language === 'en-US') {
    for (const match of text.matchAll(/\s+|[,;]/gu)) {
      const end = match.index;
      // Do not split decimal numbers or inside an abbreviation.
      if (end > 0 && !/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|\be\.g|\bi\.e)\.$/u.test(text.slice(0, end))) {
        semanticEnds.add(end);
        const following = text.slice(end).trimStart();
        if (/^(?:I|you|we|he|she|they|it|this|these|those|there|next|then|however)\b/iu.test(following) || /^[A-Z]/u.test(following)) clauseStarts.add(end);
      }
    }
  }
  return [...new Set([...ends, ...semanticEnds])].filter(end => end > 0 && end <= text.length).sort((a, b) => a - b)
    .map(end => ({ end, text: text.slice(0, end), ...(ends.has(end) ? {} : { semanticOnly: true }), ...(clauseStarts.has(end) ? { clauseStart: true } : {}) }));
}

export function continuesPrevious(text, language) {
  const tail = text.trimStart().replace(/^[、，,]+\s*/u, '');
  return language === 'ja-JP' ? /^(?:が|けど|けれど|ので|から[、，,\s]|ため|という|との|と思|であ)/u.test(tail)
    : /^(?:and|but|because|which|that|although|unless)\b/iu.test(tail);
}
function completeCandidate(snapshot, language, prefixOnly = false) {
  return snapshot.candidates.find(candidate => !candidate.semanticOnly && (!prefixOnly || candidate.end < snapshot.source.length)
    && sentenceState(candidate.text, language) === 'complete' && !continuesPrevious(snapshot.source.slice(candidate.end), language));
}

function boundedEnd(text) {
  let end = 0, size = 0, soft = 0;
  for (const character of text) {
    if (size + bytes(character) > MAX_SENTENCE_BYTES) break;
    size += bytes(character); end += character.length;
    if (/[、,;；\s]/u.test(character)) soft = end;
  }
  const sentenceEnd = sentenceCandidates(text).filter(item => item.end <= end && /[。！？!?.][」』”"')）]*$/u.test(item.text.trim())).at(-1)?.end;
  return sentenceEnd || (soft > end / 2 ? soft : end);
}

export class SentenceBuffer {
  constructor({ language, update, commit, check, sentenceMode = 'balanced', settleMs = 750, previewMs = 6000, checkMs = 2000, ...limits }) {
    Object.assign(this, { language, update, commit, check, settleMs, previewMs, checkMs }, SENTENCE_MODES[sentenceMode] || SENTENCE_MODES.balanced, limits);
    this.parts = []; this.sequence = 0; this.utterance = 0; this.revision = 0;
    this.current = null; this.closed = false; this.previewSource = ''; this.lastCheckAt = 0; this.lastCheckSource = '';
  }
  source() { return this.parts.map(part => part.text).join(''); }
  snapshot() {
    let end = 0;
    const partEnds = this.parts.map(part => (end += part.text.length));
    return { id: this.current, revision: this.revision, sourceReceivedAt: this.parts[0]?.receivedAt, source: this.source(), sourceParts: this.parts.map(({ receivedAt, ...part }) => ({ ...part })), candidates: sentenceCandidates(this.source(), partEnds, this.language) };
  }
  publish() {
    if (!this.current) this.current = ++this.sequence;
    this.revision++; this.update(this.snapshot());
  }
  push(text, metadata = {}) {
    if (this.closed || !text.trim()) return;
    const source = this.source();
    const separator = source && (this.language === 'en-US' || /[a-z0-9]$/iu.test(source) && /^[a-z0-9]/iu.test(text.trim())) ? ' ' : '';
    const leading = text.length - text.trimStart().length;
    const { source: _source, ...speechMetadata } = metadata;
    const spans = metadata.speechSpans?.map(span => ({ ...span, sourceStart: Math.max(0, span.sourceStart - leading + separator.length), sourceEnd: Math.min(separator.length + text.trim().length, span.sourceEnd - leading + separator.length) }));
    this.parts.push({ ...speechMetadata, ...(spans ? { speechSpans: spans } : {}), utteranceId: metadata.utteranceId || ++this.utterance, text: separator + text.trim(), receivedAt: Date.now() });
    this.publish();
    // A Japanese full stop is an explicit user-facing sentence boundary.
    // Commit it immediately, including after a conjunction; only text without
    // a full stop uses semantic lookahead and the short settling timer.
    let stop;
    while ((stop = /。+[」』”"'）)]*/u.exec(this.source()))) {
      const end = stop.index + stop[0].length;
      if ([...this.source().slice(0, end)].length > this.maxChars) this.cut(this.limitEnd(this.maxChars), 'length');
      else if (bytes(this.source().slice(0, end)) > MAX_SENTENCE_BYTES) this.cut(boundedEnd(this.source().slice(0, end)), 'limit');
      else this.cut(end, 'sentence');
    }
    // A following finalized ASR fragment is already lookahead for an earlier
    // sentence. Do not keep it waiting while the next sentence is being spoken.
    let complete;
    while (this.parts.length && (complete = completeCandidate(this.snapshot(), this.language, true))) this.cut(complete.end, 'sentence');
    this.enforceLimits();
    while (bytes(this.source()) > MAX_SENTENCE_BYTES) this.cut(boundedEnd(this.source()), 'limit');
    if ([...this.source()].length >= this.softChars) this.requestCheck();
    this.schedule();
  }
  schedule() {
    clearTimeout(this.settleTimer);
    if (!this.parts.length || this.closed) return;
    this.settleTimer = setTimeout(() => this.settle(), this.settleMs);
    if (!this.previewTimer) this.previewTimer = setTimeout(() => {
      this.previewTimer = null; this.preview();
    }, this.previewMs);
    this.scheduleClocks();
  }
  scheduleClocks() {
    if (!this.parts.length || this.closed) return;
    // Neither clock is reset by microphone activity or appended ASR fragments.
    if (!this.checkTimer) this.checkTimer = setTimeout(() => {
      this.checkTimer = null; this.requestCheck(); this.scheduleClocks();
    }, Date.now() - this.lastCheckAt < this.checkMs ? this.checkMs - (Date.now() - this.lastCheckAt) : this.checkMs);
    if (!this.limitTimer) this.limitTimer = setTimeout(() => {
      this.limitTimer = null; this.enforceLimits(); this.scheduleClocks();
    }, Math.max(1, this.maxWaitMs - (Date.now() - this.parts[0].receivedAt)));
  }
  activity() { if (this.parts.length) this.schedule(); }
  requestCheck() {
    if (!this.parts.length || this.closed) return;
    const snapshot = this.snapshot();
    if (snapshot.source === this.lastCheckSource || Date.now() - this.lastCheckAt < this.checkMs) return;
    // Even an unfinished tail can contain a complete internal sentence.
    if (sentenceState(snapshot.source, this.language) === 'continuation' && !snapshot.candidates.some(item => item.end < snapshot.source.length && sentenceState(item.text, this.language) !== 'continuation')) return;
    this.lastCheckAt = Date.now(); this.lastCheckSource = snapshot.source;
    this.check(snapshot);
  }
  accepts(snapshot, end = 0) {
    return !this.closed && snapshot.id === this.current && this.source().startsWith(snapshot.source)
      && (!end || !continuesPrevious(this.source().slice(end), this.language));
  }
  limitEnd(maxChars) {
    const source = this.source();
    const ceiling = [...source].slice(0, maxChars).join('').length;
    const candidates = this.snapshot().candidates.filter(item => item.end <= ceiling && item.end >= ceiling / 2 && item.end < source.length);
    const complete = candidates.find(item => sentenceState(item.text, this.language) === 'complete' && !continuesPrevious(source.slice(item.end), this.language));
    return complete?.end || candidates.at(-1)?.end || ceiling;
  }
  enforceLimits() {
    while (this.parts.length && !this.closed) {
      const tooLong = [...this.source()].length >= this.maxChars;
      const tooOld = Date.now() - this.parts[0].receivedAt >= this.maxWaitMs;
      if (!tooLong && !tooOld) break;
      this.cut(this.limitEnd(this.maxChars), tooLong ? 'length' : 'time');
    }
  }
  settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (!this.parts.length || this.closed) return;
    const snapshot = this.snapshot();
    const complete = completeCandidate(snapshot, this.language);
    if (complete) { this.cut(complete.end, 'sentence'); this.settle(); return; }
    this.requestCheck();
    if (this.previewSource) this.preview();
  }
  resolve(snapshot, end) {
    if (!this.accepts(snapshot, end)) return;
    if (end > 0 && snapshot.candidates.some(candidate => candidate.end === end)) {
      this.cut(end, 'sentence'); this.settle();
    } else if (this.previewSource) this.preview();
  }
  preview() {
    const source = this.source();
    if (!source || source === this.previewSource || this.closed) return;
    this.previewSource = source;
    this.commit({ ...this.snapshot(), provisional: true, boundary: 'waiting' });
  }
  cut(end, boundary) {
    this.clearTimers();
    const snapshot = this.snapshot(); const head = [], tail = [];
    let remaining = end;
    for (const part of this.parts) {
      if (remaining >= part.text.length) { head.push(part); remaining -= part.text.length; }
      else if (remaining > 0) { head.push(sliceSpeechPart(part, 0, remaining)); tail.push(sliceSpeechPart(part, remaining, part.text.length)); remaining = 0; }
      else tail.push(part);
    }
    this.revision++;
    this.commit({ ...snapshot, revision: this.revision, source: head.map(part => part.text).join(''), sourceParts: head.map(({ receivedAt, ...part }) => ({ ...part })), provisional: false, boundary });
    this.parts = tail; this.current = null; this.previewSource = ''; this.lastCheckSource = ''; this.lastCheckAt = 0;
    if (this.source().trim()) { this.publish(); this.schedule(); }
    else this.parts = [];
  }
  flush(boundary = 'stop', close = true) {
    while (this.parts.length) {
      const source = this.source();
      const candidate = completeCandidate(this.snapshot(), this.language);
      this.cut(candidate?.end || source.length, candidate ? 'sentence' : boundary);
    }
    if (boundary !== 'canceled' && close) this.close();
  }
  close() {
    this.closed = true; this.clearTimers();
  }
  clearTimers() {
    for (const name of ['settleTimer', 'previewTimer', 'checkTimer', 'limitTimer']) { clearTimeout(this[name]); this[name] = null; }
  }
  get pending() { return this.parts.length > 0; }
}
