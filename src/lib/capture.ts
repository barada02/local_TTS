// Getting a clean reference recording for voice cloning: record from the
// microphone or decode a file, then convert it to mono at the model's rate.

/** Decodes any audio the webview supports and resamples it to mono at `rate`. */
export async function decodeToMono(data: ArrayBuffer, rate: number): Promise<Float32Array> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data.slice(0));
  } finally {
    void ctx.close();
  }
  // An offline context with one channel mixes stereo down to mono for us.
  const length = Math.max(1, Math.ceil(decoded.duration * rate));
  const offline = new OfflineAudioContext(1, length, rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Cuts silence off both ends, keeping a short margin. */
export function trimSilence(pcm: Float32Array, rate: number, thresholdDb = -45): Float32Array {
  const frame = Math.round(rate * 0.02);
  const limit = Math.pow(10, thresholdDb / 20);
  const loud = (start: number) => {
    let sum = 0;
    const end = Math.min(pcm.length, start + frame);
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / Math.max(1, end - start)) > limit;
  };
  let first = 0;
  while (first < pcm.length && !loud(first)) first += frame;
  let last = pcm.length - frame;
  while (last > first && !loud(last)) last -= frame;
  const margin = Math.round(rate * 0.1);
  return pcm.slice(Math.max(0, first - margin), Math.min(pcm.length, last + frame + margin));
}

/** Root-mean-square level, 0..1, for judging whether a recording is too quiet. */
export function rms(pcm: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

export interface Recording {
  stop(): Promise<ArrayBuffer>;
}

/** Starts recording the microphone. Processing that colours the voice is turned off. */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => parts.push(e.data);
  recorder.start();
  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          void new Blob(parts, { type: recorder.mimeType }).arrayBuffer().then(resolve);
        };
        recorder.stop();
      }),
  };
}
