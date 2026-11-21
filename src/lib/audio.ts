// Audio playback of streamed chunks, and WAV encoding.

/** Plays chunks back to back as they arrive. */
export class Player {
  private ctx: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private rate = 24000;
  /** Called when everything queued has finished playing. */
  onIdle: () => void = () => {};

  /** Call from a click: browsers only start audio after a user gesture. */
  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setRate(rate: number) {
    this.rate = rate;
  }

  push(samples: Float32Array) {
    if (samples.length === 0) return;
    this.unlock();
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, samples.length, this.rate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // A short lead on the first chunk avoids a click if playback starts late.
    const at = Math.max(ctx.currentTime + 0.05, this.nextStart);
    source.start(at);
    this.nextStart = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onIdle();
    };
  }

  stop() {
    for (const s of this.sources) {
      s.onended = null;
      s.stop();
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  get playing() {
    return this.sources.size > 0;
  }
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const v = Math.max(-1, Math.min(1, s));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  });
  return bytes;
}
