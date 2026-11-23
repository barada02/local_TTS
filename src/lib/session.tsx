// State shared by every page: the engines, which are loaded, saved (starred)
// voices, the text being tried, and audio playback.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  deleteEngineFiles,
  downloadEngine,
  listEngines,
  loadEngine,
  stopSpeaking,
  type EngineInfo,
  type LoadInfo,
  type VoiceInfo,
} from "./api";
import { Player } from "./audio";
import type { Clip } from "./clips";
import { SAMPLES } from "./samples";

export type Tab = "studio" | "saved" | "compare";

/** What an engine is doing right now. */
export type Phase =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "verifying" }
  | { kind: "installing"; message: string }
  | { kind: "loading" };

/** A voice the user starred. Kept with enough detail to show it before its engine is loaded. */
export interface Favorite {
  engine: string;
  engineName: string;
  voice: VoiceInfo;
}

export const favKey = (engine: string, voice: string) => `${engine}:${voice}`;
const STORE = "tts-bench-favorites-v1";

function readFavorites(): Favorite[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface Session {
  tab: Tab;
  setTab: (t: Tab) => void;

  engines: EngineInfo[];
  refresh: () => Promise<EngineInfo[]>;
  loadInfos: Record<string, LoadInfo>;
  phases: Record<string, Phase>;
  /** Downloads (and sets up) an engine, then loads it. */
  install: (id: string) => Promise<void>;
  /** Loads an engine if needed. Resolves with null if it isn't installed. */
  ensureLoaded: (id: string) => Promise<LoadInfo | null>;
  /** Unloads an engine and deletes its downloaded files. Resolves with the bytes freed. */
  uninstall: (id: string) => Promise<number>;

  /** The engine and voice picked in the Studio. */
  engineId: string;
  voiceId: string | null;
  openInStudio: (engine: string, voice: string) => void;
  setEngineId: (id: string) => void;
  setVoiceId: (id: string | null) => void;

  favorites: Favorite[];
  isFavorite: (engine: string, voice: string) => boolean;
  toggleFavorite: (engine: EngineInfo, voice: VoiceInfo) => void;
  removeFavorite: (engine: string, voice: string) => void;

  /** The text every page tries. */
  text: string;
  setText: (t: string) => void;

  player: Player;
  /** Id of the clip being played, if any. */
  playing: number | null;
  setPlaying: (id: number | null) => void;
  playClip: (clip: Clip) => void;
  /** Stops playback and any generation in progress. */
  stopAll: () => Promise<void>;

  /** Which page is generating, so another doesn't start at the same time. */
  busy: Tab | null;
  setBusy: (b: Tab | null) => void;

  error: string | null;
  setError: (e: string | null) => void;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const player = useMemo(() => new Player(), []);
  const [tab, setTab] = useState<Tab>("studio");
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [loadInfos, setLoadInfos] = useState<Record<string, LoadInfo>>({});
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const [engineId, setEngineId] = useState("phonon");
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>(readFavorites);
  const [text, setText] = useState(SAMPLES[0].text);
  const [playing, setPlaying] = useState<number | null>(null);
  const [busy, setBusy] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loaded = useRef<Record<string, LoadInfo>>({});
  const pending = useRef<Record<string, Promise<LoadInfo | null> | undefined>>({});
  const enginesRef = useRef<EngineInfo[]>([]);

  const setPhase = useCallback((id: string, phase: Phase) => setPhases((p) => ({ ...p, [id]: phase })), []);

  const refresh = useCallback(async () => {
    const list = await listEngines();
    enginesRef.current = list;
    setEngines(list);
    return list;
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    player.onIdle = () => setPlaying(null);
  }, [player]);

  const ensureLoaded = useCallback(
    (id: string): Promise<LoadInfo | null> => {
      if (loaded.current[id]) return Promise.resolve(loaded.current[id]);
      const existing = pending.current[id];
      if (existing) return existing;
      const job = (async () => {
        const list = enginesRef.current.length ? enginesRef.current : await refresh();
        if (!list.find((e) => e.id === id)?.downloaded) return null;
        setPhase(id, { kind: "loading" });
        try {
          const info = await loadEngine(id);
          loaded.current[id] = info;
          setLoadInfos((prev) => ({ ...prev, [id]: info }));
          await refresh();
          return info;
        } catch (e) {
          setError(String(e));
          return null;
        } finally {
          setPhase(id, { kind: "idle" });
          delete pending.current[id];
        }
      })();
      pending.current[id] = job;
      return job;
    },
    [refresh, setPhase],
  );

  const install = useCallback(
    async (id: string) => {
      const engine = enginesRef.current.find((e) => e.id === id);
      if (!engine) return;
      setError(null);
      setPhase(id, { kind: "downloading", progress: engine.presentBytes / Math.max(1, engine.totalBytes) });
      try {
        await downloadEngine(id, (e) => {
          if (e.kind === "progress") setPhase(id, { kind: "downloading", progress: e.downloaded / e.total });
          else if (e.kind === "verifying") setPhase(id, { kind: "verifying" });
          else setPhase(id, { kind: "installing", message: e.message });
        });
        await refresh();
        setPhase(id, { kind: "idle" });
        await ensureLoaded(id);
      } catch (e) {
        setError(String(e));
        setPhase(id, { kind: "idle" });
        await refresh();
      }
    },
    [ensureLoaded, refresh, setPhase],
  );

  const uninstall = useCallback(
    async (id: string) => {
      await stopSpeaking();
      try {
        return await deleteEngineFiles(id);
      } finally {
        // Forget every engine the backend no longer has loaded (deleting a
        // shared Python environment can unload more than one).
        const list = await refresh();
        for (const e of list) {
          if (!e.loaded) delete loaded.current[e.id];
        }
        setLoadInfos({ ...loaded.current });
      }
    },
    [refresh],
  );

  const isFavorite = useCallback(
    (engine: string, voice: string) => favorites.some((f) => f.engine === engine && f.voice.id === voice),
    [favorites],
  );

  const toggleFavorite = useCallback((engine: EngineInfo, voice: VoiceInfo) => {
    setFavorites((list) =>
      list.some((f) => f.engine === engine.id && f.voice.id === voice.id)
        ? list.filter((f) => !(f.engine === engine.id && f.voice.id === voice.id))
        : [...list, { engine: engine.id, engineName: engine.name, voice }],
    );
  }, []);

  const removeFavorite = useCallback((engine: string, voice: string) => {
    setFavorites((list) => list.filter((f) => !(f.engine === engine && f.voice.id === voice)));
  }, []);

  const openInStudio = useCallback((engine: string, voice: string) => {
    setEngineId(engine);
    setVoiceId(voice);
    setTab("studio");
  }, []);

  const playClip = useCallback(
    (clip: Clip) => {
      player.unlock();
      player.stop();
      player.setRate(clip.stats.sampleRate);
      player.push(clip.audio);
      setPlaying(clip.id);
    },
    [player],
  );

  const stopAll = useCallback(async () => {
    player.stop();
    setPlaying(null);
    await stopSpeaking();
  }, [player]);

  const value: Session = {
    tab,
    setTab,
    engines,
    refresh,
    loadInfos,
    phases,
    install,
    ensureLoaded,
    uninstall,
    engineId,
    voiceId,
    openInStudio,
    setEngineId,
    setVoiceId,
    favorites,
    isFavorite,
    toggleFavorite,
    removeFavorite,
    text,
    setText,
    player,
    playing,
    setPlaying,
    playClip,
    stopAll,
    busy,
    setBusy,
    error,
    setError,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
