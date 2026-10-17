import { makeWav } from './wav';
export type SpeechEvent = { type: string; delta?: string; transcript?: string; text?: string; error?: { message?: string } | string; [key: string]: unknown };

export class MicrophoneCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private socket?: WebSocket;
  private worklet?: AudioWorkletNode;
  private meter?: AnalyserNode;
  private frame = 0;
  private closing = false;
  private chunks: Int16Array[] = [];
  private capturedSamples = 0;
  private sampleRate = 16000;
  private translating = false;
  private processingCaptions = false;
  private translationFinished = false;
  private translationDone?: Promise<void>;
  private resolveTranslation?: () => void;
  private rejectTranslation?: (error: Error) => void;
  private resolveCommit?: () => void;
  private rejectCommit?: (error: Error) => void;
  private committed = false;
  private resolveFlush?: () => void;

  constructor(private callbacks: { event: (event: SpeechEvent) => void; level: (level: number) => void; disconnected: () => void }) {}

  async start(deviceId: string, language: string, translation?: { model: string; targetLanguage: string; boundaryMode?: 'llm' | 'rules'; sentenceMode?: 'speed' | 'balanced' | 'context'; correctionMode?: 'off' | 'conservative' }, captions?: { correctionMode: 'off' | 'conservative' }) {
    const settingsResponse = await fetch('/api/speech/settings', { signal: AbortSignal.timeout(5000) });
    if (!settingsResponse.ok) throw new Error('音声接続設定を取得できません。画面を再読み込みしてください。');
    const speechSettings = await settingsResponse.json();
    this.translating = Boolean(translation);
    this.processingCaptions = Boolean(translation || speechSettings.diarization || captions && captions.correctionMode !== 'off' && language === 'ja-JP');
    if (this.processingCaptions) {
      this.translationDone = new Promise<void>((resolve, reject) => { this.resolveTranslation = resolve; this.rejectTranslation = reject; });
      void this.translationDone.catch(() => {});
    }
    try {
      const browserProcessing = speechSettings.inputProfile !== 'conference';
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: browserProcessing, noiseSuppression: browserProcessing, autoGainControl: browserProcessing } });
      if (this.closing) throw new Error('録音を中止しました。');
      this.context = new AudioContext();
      this.sampleRate = this.context.sampleRate;
      await this.context.resume();
      await this.context.audioWorklet.addModule('/pcm-worklet.js');
      if (this.closing) throw new Error('録音を中止しました。');
      const source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'pcm-capture');
      this.meter = this.context.createAnalyser();
      this.meter.fftSize = 256;
      const silent = this.context.createGain();
      silent.gain.value = 0;
      const ws = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${translation ? 'translate' : 'transcribe'}`);
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        const timeout = window.setTimeout(() => reject(new Error('音声認識・翻訳サービスの準備がタイムアウトしました。')), this.processingCaptions ? 200000 : 15000);
        ws.onmessage = message => {
          let event: SpeechEvent;
          try { event = JSON.parse(message.data); } catch { return; }
          if (event.type === 'session.created') {
            ws.send(JSON.stringify({ type: 'session.update', session: { sample_rate: this.context!.sampleRate, language, automatic_punctuation: true, endpointing_ms: this.processingCaptions ? 800 : 700 }, translation, captions: !translation && this.processingCaptions ? captions : undefined }));
          } else if (event.type === 'session.updated' && !ready) {
            ready = true; clearTimeout(timeout); resolve();
          } else if (event.type === 'input_audio_buffer.committed') {
            this.committed = true;
            this.resolveCommit?.();
          } else if (event.type === 'translation.finished' || event.type === 'caption.finished') {
            this.translationFinished = true; this.resolveTranslation?.();
          } else if (event.type === 'error') {
            const detail = typeof event.error === 'string' ? event.error : event.error?.message;
            if (!ready) { clearTimeout(timeout); reject(new Error(detail || '音声認識を開始できません。')); }
            else { this.dispose(); this.callbacks.disconnected(); }
          }
          this.callbacks.event(event);
        };
        ws.onerror = () => { clearTimeout(timeout); if (!ready) reject(new Error('音声認識に接続できません。別の録音やAI処理が終了しているか確認してください。')); };
        ws.onclose = () => {
          clearTimeout(timeout);
          if (!this.committed) this.rejectCommit?.(new Error('原文を確定する前に接続が終了しました。表示中の原文を確認してください。'));
          if (this.processingCaptions && !this.translationFinished) this.rejectTranslation?.(new Error('補正・翻訳が完了する前に接続が終了しました。未完了の文章は再試行できます。'));
          if (!ready) reject(new Error('音声認識との接続が終了しました。'));
          if (!this.closing) { this.dispose(); this.callbacks.disconnected(); }
        };
      });
      if (this.closing) throw new Error('録音を中止しました。');
      this.worklet.port.onmessage = event => {
        if (event.data === 'flushed') { this.resolveFlush?.(); return; }
        if (!this.translating && event.data instanceof ArrayBuffer && this.capturedSamples < this.sampleRate * 120) {
          const samples = new Int16Array(event.data);
          const chunk = samples.slice(0, this.sampleRate * 120 - this.capturedSamples);
          this.chunks.push(chunk); this.capturedSamples += chunk.length;
        }
        if (ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 512 * 1024) {
            this.callbacks.event({ type: 'error', error: { message: '音声の送信が追いつきません。録音を停止して再試行してください。' } });
            this.dispose(); this.callbacks.disconnected(); return;
          }
          ws.send(event.data);
        }
      };
      source.connect(this.worklet);
      this.worklet.connect(silent);
      silent.connect(this.context.destination);
      source.connect(this.meter);
      const values = new Float32Array(this.meter.fftSize);
      const measure = () => {
        if (this.closing || !this.meter) return;
        this.meter.getFloatTimeDomainData(values);
        const rms = Math.sqrt(values.reduce((total, x) => total + x * x, 0) / values.length);
        this.callbacks.level(Math.min(1, rms * 5));
        this.frame = requestAnimationFrame(measure);
      };
      measure();
      this.stream.getAudioTracks().forEach(track => { track.onended = () => { if (!this.closing) { this.dispose(); this.callbacks.disconnected(); } }; });
    } catch (error) { this.dispose(); throw error; }
  }

  async stop() {
    this.closing = true;
    cancelAnimationFrame(this.frame);
    try {
      if (this.worklet && this.context?.state === 'running') {
        await Promise.race([new Promise<void>(resolve => { this.resolveFlush = resolve; this.worklet!.port.postMessage('flush'); }), new Promise(resolve => setTimeout(resolve, 1500))]);
        this.worklet.disconnect();
      }
      this.stream?.getTracks().forEach(track => track.stop());
      if (this.context && this.context.state !== 'closed') await this.context.close();
      if (this.socket?.readyState === WebSocket.OPEN) {
        const committed = new Promise<void>((resolve, reject) => { this.resolveCommit = resolve; this.rejectCommit = reject; });
        this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        await Promise.race([committed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('最終結果の確定がタイムアウトしました。表示中の原文を確認してください。')), 15000))]);
      }
    } finally { this.dispose(this.processingCaptions); }
  }

  dispose(keepSocket = false) {
    this.closing = true;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop());
    this.worklet?.disconnect();
    this.meter?.disconnect();
    this.meter = undefined;
    if (this.context && this.context.state !== 'closed') void this.context.close();
    if (!keepSocket) { if (this.socket) this.socket.onmessage = null; this.socket?.close(); }
    this.callbacks.level(0);
  }

  cancelTranslation() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: this.translating ? 'translation.cancel' : 'caption.cancel' })); }
  async waitForTranslation() {
    if (!this.translationDone) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.translationDone, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('翻訳の待機が長すぎるため終了しました。未完了の発話は再試行できます。')), 600000); })]); }
    finally { clearTimeout(timer); }
  }

  async comparisonClip() {
    if (this.capturedSamples < this.sampleRate * 0.2) return null;
    const samples = new Float32Array(this.capturedSamples); let offset = 0;
    for (const chunk of this.chunks) { for (const value of chunk) samples[offset++] = value / 32768; }
    this.chunks = [];
    return makeWav(samples, this.sampleRate, 'マイク録音（先頭2分まで）');
  }
}
