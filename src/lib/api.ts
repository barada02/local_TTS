// Thin wrapper over the Rust commands in src-tauri/src/lib.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface VoiceInfo {
  id: string;
  name: string;
  locale: string;
  gender: string;
  age: string;
  description: string;
}

export interface EngineInfo {
  id: string;
  name: string;
  description: string;
  voices: VoiceInfo[];
  downloaded: boolean;
  presentBytes: number;
  totalBytes: number;
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
  | { kind: "verifying" };

export const listEngines = () => invoke<EngineInfo[]>("engines_list");

export function downloadEngine(engine: string, onEvent: (e: DownloadEvent) => void): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  return invoke("engine_download", { engine, onEvent: channel });
}

export const cancelDownload = () => invoke("cancel_download");
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
