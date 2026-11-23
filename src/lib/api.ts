// Thin wrapper over the Rust commands in src-tauri/src/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface VoiceInfo {
  id: string;
  name: string;
  locale: string;
  gender: string;
  age: string;
  description: string;
  /** A voice you made yourself (cloned). */
  custom: boolean;
}

export interface LicenseInfo {
  name: string;
  url: string;
  summary: string;
  /** False means commercial use is not allowed. */
  commercialOk: boolean;
  credit: string | null;
}

export interface CloneSpec {
  sampleRate: number;
  minSeconds: number;
  maxSeconds: number;
}

export interface EngineInfo {
  id: string;
  name: string;
  description: string;
  voices: VoiceInfo[];
  license: LicenseInfo;
  /** Present when the engine can clone voices. */
  clone: CloneSpec | null;
  downloaded: boolean;
  presentBytes: number;
  totalBytes: number;
  /** Space deleting this engine's files would free (its folder, plus a shared Python environment nothing else needs). */
  diskBytes: number;
  loaded: boolean;
}

export interface LoadInfo {
  sampleRate: number;
  loadMs: number;
  ramMb: number;
}

export interface SpeakStats {
  sampleRate: number;
  samples: number;
  audioSec: number;
  ttfaMs: number;
  totalMs: number;
  rtf: number;
  ramMb: number;
  stopped: boolean;
}

export type DownloadEvent =
  | { kind: "progress"; downloaded: number; total: number }
  | { kind: "verifying" }
  | { kind: "installing"; message: string };

export const listEngines = () => invoke<EngineInfo[]>("engines_list");

export function downloadEngine(engine: string, onEvent: (e: DownloadEvent) => void): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  return invoke("engine_download", { engine, onEvent: channel });
}

export const cancelDownload = () => invoke("cancel_download");

/** Deletes an engine's downloaded files (it can be downloaded again). Resolves with the bytes freed. */
export const deleteEngineFiles = (engine: string) => invoke<number>("engine_delete_files", { engine });
export const loadEngine = (engine: string) => invoke<LoadInfo>("engine_load", { engine });
export const stopSpeaking = () => invoke("engine_stop");

/**
 * Generates speech. `onChunk` receives each piece of mono f32 audio as soon as
 * it is ready; the promise resolves with the timings once generation is done.
 */
export function speak(
  engine: string,
  text: string,
  voice: string,
  onChunk: (samples: Float32Array) => void,
): Promise<SpeakStats> {
  const channel = new Channel<ArrayBuffer | number[]>();
  channel.onmessage = (data) => {
    const buffer = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    onChunk(new Float32Array(buffer));
  };
  return invoke<SpeakStats>("engine_speak", { engine, text, voice, onAudio: channel });
}

/** Writes a WAV file into the app's outputs folder; resolves with its path. */
export function saveWav(wav: Uint8Array, name: string): Promise<string> {
  return invoke<string>("save_wav", wav, { headers: { "x-name": name } });
}

/** Makes a voice from a recording (mono samples at the engine's clone rate). */
export function createVoice(engine: string, name: string, pcm: Float32Array): Promise<VoiceInfo> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return invoke<VoiceInfo>("engine_create_voice", bytes, {
    headers: { "x-engine": encodeURIComponent(engine), "x-name": encodeURIComponent(name) },
  });
}

export const deleteVoice = (engine: string, voice: string) =>
  invoke("engine_delete_voice", { engine, voice });
