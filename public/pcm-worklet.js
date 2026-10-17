// Stream mono PCM16 at the AudioContext's actual rate. The ASR server resamples.
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Int16Array(2048); this.offset = 0; this.active = true;
    this.port.onmessage = event => { if (event.data === 'flush') { this.active = false; if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset).buffer); this.offset = 0; this.port.postMessage('flushed'); } };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      value = Math.max(-1, Math.min(1, value / channels.length));
      this.buffer[this.offset++] = value < 0 ? value * 32768 : value * 32767;
      if (this.offset === this.buffer.length) { this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]); this.buffer = new Int16Array(2048); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
