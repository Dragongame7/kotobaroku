export type AudioClip = { blob: Blob; seconds: number; name: string };
export async function makeWav(samples: Float32Array, sampleRate: number, name: string): Promise<AudioClip> {
  const length = Math.round(samples.length / sampleRate * 16000);
  if (length < 3200 || length > 1920000) throw new Error('比較には0.2秒〜2分の音声を使ってください。');
  let pcm = samples;
  if (sampleRate !== 16000) {
    const context = new OfflineAudioContext(1, length, 16000);
    const source = context.createBufferSource(); const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0); source.buffer = buffer; source.connect(context.destination); source.start();
    pcm = (await context.startRendering()).getChannelData(0);
  }
  const result = new ArrayBuffer(44 + pcm.length * 2); const view = new DataView(result);
  const string = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  string(0, 'RIFF'); view.setUint32(4, result.byteLength - 8, true); string(8, 'WAVE'); string(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((value, i) => { const sample = Math.max(-1, Math.min(1, value)); view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true); });
  return { blob: new Blob([result], { type: 'audio/wav' }), seconds: pcm.length / 16000, name };
}
export async function loadAudio(file: File): Promise<AudioClip> {
  if (file.size > 25 * 1024 * 1024) throw new Error('25MB以下の音声ファイルを選んでください。');
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > 120) throw new Error('2分以内の音声を選んでください。');
    const samples = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) { const data = buffer.getChannelData(channel); for (let i = 0; i < samples.length; i++) samples[i] += data[i] / buffer.numberOfChannels; }
    return await makeWav(samples, buffer.sampleRate, file.name);
  } finally { await context.close(); }
}
