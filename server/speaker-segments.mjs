// Align without changing the ASR transcript. If alignment is ambiguous or an
// ASR word is missing, retain the entire utterance with an unknown speaker.
export function speakerSegments(event, { sessionId, diarization = false } = {}) {
  const source = event.transcript || '';
  if (!diarization) return [{ source }];
  const words = Array.isArray(event.words) ? event.words : [];
  const unknown = () => [{ source, sessionId, speaker: { sessionId, speakerId: null, status: 'unknown', origin: 'nemotron3' }, speechSpans: [] }];
  if (!words.length || words.length > 20000) return unknown();
  let flat = ''; const positions = [];
  for (let i = 0; i < source.length;) {
    const character = String.fromCodePoint(source.codePointAt(i));
    if (!/\s/u.test(character)) { for (let j = 0; j < character.length; j++) positions.push(i + j); flat += character; }
    i += character.length;
  }
  const aligned = []; let cursor = 0;
  for (const word of words) {
    if (typeof word.word !== 'string') return unknown();
    const token = word.word.replace(/\s/gu, '');
    if (!token) continue;
    const start = flat.indexOf(token, cursor);
    if (start < 0 || /[\p{L}\p{N}]/u.test(flat.slice(cursor, start))) return unknown();
    const end = start + token.length;
    const validTime = Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start;
    aligned.push({ sourceStart: positions[start], sourceEnd: positions[end - 1] + 1, audioStart: validTime ? word.start : null, audioEnd: validTime ? word.end : null, nativeSpeaker: validTime && Number.isInteger(word.speaker) && word.speaker >= 1 && word.speaker <= 8 ? word.speaker : null });
    cursor = end;
  }
  if (!aligned.length || /[\p{L}\p{N}]/u.test(flat.slice(cursor))) return unknown();
  const runs = [];
  for (const word of aligned) {
    let run = runs.at(-1);
    if (!run || run.nativeSpeaker !== word.nativeSpeaker) {
      if (run) run.sourceEnd = word.sourceStart;
      run = { nativeSpeaker: word.nativeSpeaker, sourceStart: runs.length ? word.sourceStart : 0, sourceEnd: source.length, words: [] }; runs.push(run);
    }
    run.words.push(word);
  }
  return runs.map(run => ({
    source: source.slice(run.sourceStart, run.sourceEnd), sessionId,
    speaker: { sessionId, speakerId: run.nativeSpeaker ? `spk-${run.nativeSpeaker}` : null, status: run.nativeSpeaker ? 'assigned' : 'unknown', origin: 'nemotron3' },
    speechSpans: run.words.map(word => ({ sourceStart: word.sourceStart - run.sourceStart, sourceEnd: word.sourceEnd - run.sourceStart, audioStart: word.audioStart, audioEnd: word.audioEnd })),
    audioStart: run.words.find(word => word.audioStart !== null)?.audioStart,
    audioEnd: [...run.words].reverse().find(word => word.audioEnd !== null)?.audioEnd,
  }));
}

export function sliceSpeechPart(part, start, end) {
  const spans = (part.speechSpans || []).filter(span => span.sourceStart < end && span.sourceEnd > start).map(span => ({ ...span, sourceStart: Math.max(0, span.sourceStart - start), sourceEnd: Math.min(end - start, span.sourceEnd - start) }));
  return { ...part, text: part.text.slice(start, end), ...(part.speechSpans ? { speechSpans: spans } : {}) };
}
export function snapshotSpeech(parts) {
  const speaker = parts.find(part => part.speaker)?.speaker;
  if (!speaker) return {};
  let offset = 0; const speechSpans = [];
  for (const part of parts) {
    for (const span of part.speechSpans || []) speechSpans.push({ ...span, sourceStart: span.sourceStart + offset, sourceEnd: span.sourceEnd + offset });
    offset += part.text.length;
  }
  return { speaker, sessionId: speaker.sessionId, speechSpans, audioStart: speechSpans.find(span => span.audioStart !== null)?.audioStart, audioEnd: [...speechSpans].reverse().find(span => span.audioEnd !== null)?.audioEnd };
}
