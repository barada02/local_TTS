// A generated piece of speech and the numbers measured while making it.

import { speak, type EngineInfo, type SpeakStats, type VoiceInfo } from "./api";
import { concat } from "./audio";

export interface Clip {
  id: number;
  engine: string;
  engineName: string;
  voice: VoiceInfo;
  text: string;
  stats: SpeakStats;
  audio: Float32Array;
  savedTo?: string;
}

let nextId = 1;

/**
 * Generates `text` in `voice`. `onChunk` receives audio as it is produced (for
 * live playback). Resolves with null if the run was stopped before any audio.
 */
export async function synthesize(
  engine: Pick<EngineInfo, "id" | "name">,
  voice: VoiceInfo,
  text: string,
  onChunk?: (samples: Float32Array) => void,
): Promise<Clip | null> {
  const chunks: Float32Array[] = [];
  const stats = await speak(engine.id, text, voice.id, (c) => {
    chunks.push(c);
    onChunk?.(c);
  });
  if (stats.stopped || chunks.length === 0) return null;
  return { id: nextId++, engine: engine.id, engineName: engine.name, voice, text, stats, audio: concat(chunks) };
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
