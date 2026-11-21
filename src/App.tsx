import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  cancelDownload,
  downloadEngine,
  listEngines,
  loadEngine,
  saveWav,
  speak,
  stopSpeaking,
  type EngineInfo,
  type LoadInfo,
  type SpeakStats,
  type VoiceInfo,
} from "./lib/api";
import { Player, concat, encodeWav } from "./lib/audio";
import { SAMPLES } from "./lib/samples";

interface Run {
  id: number;
  engine: string;
  voice: VoiceInfo;
  text: string;
  stats: SpeakStats;
  audio: Float32Array;
  savedTo?: string;
}

const LOCALES: Record<string, string> = { "en-us": "US", "en-gb": "UK", characters: "Characters" };
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(0)} MB`;
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export default function App() {
  const player = useMemo(() => new Player(), []);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engineId, setEngineId] = useState("phonon");
  const [loadInfo, setLoadInfo] = useState<LoadInfo | null>(null);
  const [phase, setPhase] = useState<"idle" | "downloading" | "verifying" | "loading">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState(SAMPLES[0].text);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [locale, setLocale] = useState("all");
  const [gender, setGender] = useState("all");
  const [query, setQuery] = useState("");

  const [runs, setRuns] = useState<Run[]>([]);
  const [playingRun, setPlayingRun] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "one" | "all">(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const runId = useRef(0);
  const cancelBatch = useRef(false);

  const engine = engines.find((e) => e.id === engineId);
  const voices = engine?.voices ?? [];
  const voice = voices.find((v) => v.id === voiceId) ?? voices[0];

  const refresh = useCallback(async () => {
    const list = await listEngines();
    setEngines(list);
    return list;
  }, []);

  const load = useCallback(
    async (id: string) => {
      setPhase("loading");
      setError(null);
      try {
        const info = await loadEngine(id);
        player.setRate(info.sampleRate);
        setLoadInfo((prev) => (info.loadMs > 0 || !prev ? info : prev));
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setPhase("idle");
      }
    },
    [player, refresh],
  );

  useEffect(() => {
    refresh()
      .then((list) => {
        const e = list.find((x) => x.id === engineId);
        if (e?.downloaded) void load(e.id);
      })
      .catch((e) => setError(String(e)));
    // Only on first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    player.onIdle = () => setPlayingRun(null);
  }, [player]);

  async function download() {
    if (!engine) return;
    setError(null);
    setPhase("downloading");
    setProgress(engine.presentBytes / engine.totalBytes);
    try {
      await downloadEngine(engine.id, (e) => {
        if (e.kind === "progress") {
          setPhase("downloading");
          setProgress(e.downloaded / e.total);
        } else setPhase("verifying");
      });
      await refresh();
      await load(engine.id);
    } catch (e) {
      setError(String(e));
      setPhase("idle");
      await refresh();
    }
  }

  /** Generates one clip. Live playback is optional (off during "run all"). */
  async function generate(v: VoiceInfo, live: boolean): Promise<Run | null> {
    const chunks: Float32Array[] = [];
    const stats = await speak(engineId, text, v.id, (c) => {
      chunks.push(c);
      if (live) player.push(c);
    });
    if (stats.stopped || chunks.length === 0) return null;
    const run: Run = { id: ++runId.current, engine: engineId, voice: v, text, stats, audio: concat(chunks) };
    setRuns((r) => [run, ...r]);
    return run;
  }

  async function generateOne() {
    if (!voice || !text.trim()) return;
    player.unlock();
    player.stop();
    await stopSpeaking();
    setBusy("one");
    setError(null);
    try {
      const run = await generate(voice, true);
      if (run) setPlayingRun(run.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function generateAll(list: VoiceInfo[]) {
    if (!text.trim() || list.length === 0) return;
    player.unlock();
    player.stop();
    await stopSpeaking();
    cancelBatch.current = false;
    setBusy("all");
    setError(null);
    try {
      for (let i = 0; i < list.length; i++) {
        if (cancelBatch.current) break;
        setBatch({ done: i, total: list.length });
        await generate(list[i], false);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBatch(null);
      setBusy(null);
    }
  }

  async function stop() {
    cancelBatch.current = true;
    player.stop();
    setPlayingRun(null);
    await stopSpeaking();
  }

  function replay(run: Run) {
    player.unlock();
    player.stop();
    player.setRate(run.stats.sampleRate);
    player.push(run.audio);
    setPlayingRun(run.id);
  }

  async function save(run: Run) {
    const name = `${run.engine}-${run.voice.name}-${run.id}`;
    try {
      const path = await saveWav(encodeWav(run.audio, run.stats.sampleRate), name);
      setRuns((rs) => rs.map((r) => (r.id === run.id ? { ...r, savedTo: path } : r)));
      await revealItemInDir(path);
    } catch (e) {
      setError(String(e));
    }
  }

  const filtered = voices.filter(
    (v) =>
      (locale === "all" || v.locale === locale) &&
      (gender === "all" || v.gender === gender) &&
      (!query || `${v.name} ${v.description}`.toLowerCase().includes(query.toLowerCase())),
  );
  const locales = [...new Set(voices.map((v) => v.locale))];
  const ready = !!engine?.downloaded && phase === "idle" && !!loadInfo;
  const last = runs[0]?.stats;

  return (
    <div className="app">
      <header>
        <h1>tts-bench</h1>
        <select value={engineId} onChange={(e) => setEngineId(e.target.value)}>
          {engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <span className="muted engine-desc">{engine?.description}</span>
        <span className="spacer" />
        {loadInfo && (
          <span className="chip" title="Time to load the model into memory, and this process's memory afterwards">
            loaded in {sec(loadInfo.loadMs)} · {loadInfo.ramMb.toFixed(0)} MB RAM
          </span>
        )}
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {engine && !engine.downloaded && (
        <section className="card setup">
          <div>
            <strong>{engine.name}</strong> needs to be downloaded once ({mb(engine.totalBytes)}: the model and{" "}
            {voices.length} voices).
          </div>
          {phase === "downloading" || phase === "verifying" ? (
            <div className="row">
              <div className="bar">
                <div style={{ width: `${(progress * 100).toFixed(1)}%` }} />
              </div>
              <span className="muted">{phase === "verifying" ? "Verifying…" : `${(progress * 100).toFixed(0)}%`}</span>
              <button onClick={() => void cancelDownload()}>Cancel</button>
            </div>
          ) : (
            <button className="primary" onClick={() => void download()}>
              {engine.presentBytes > 0 ? "Resume download" : "Download"}
            </button>
          )}
        </section>
      )}
      {phase === "loading" && <div className="card muted">Loading the model…</div>}

      <main>
        <div className="col">
          <section className="card">
            <div className="row">
              <label className="muted" htmlFor="sample">
                Test text
              </label>
              <select
                id="sample"
                value=""
                onChange={(e) => {
                  const s = SAMPLES.find((x) => x.label === e.target.value);
                  if (s) setText(s.text);
                }}
              >
                <option value="" disabled>
                  Load a sample…
                </option>
                {SAMPLES.map((s) => (
                  <option key={s.label}>{s.label}</option>
                ))}
              </select>
              <span className="spacer" />
              <span className="muted">{text.length} chars</span>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} />
            <div className="row">
              {busy ? (
                <button className="danger" onClick={() => void stop()}>
                  Stop
                </button>
              ) : (
                <button className="primary" disabled={!ready || !text.trim()} onClick={() => void generateOne()}>
                  Generate · {voice?.name ?? "…"}
                </button>
              )}
              <button
                disabled={!ready || !!busy || !text.trim() || filtered.length === 0}
                onClick={() => void generateAll(filtered)}
                title="Generate the same text with every voice shown below (no playback; listen from the history)"
              >
                Run all {filtered.length} voices
              </button>
              {batch && (
                <span className="muted">
                  {batch.done + 1} / {batch.total}
                </span>
              )}
            </div>
          </section>

          <section className="card voices">
            <div className="row wrap">
              <strong>Voices</strong>
              <div className="seg">
                {["all", ...locales].map((l) => (
                  <button key={l} className={locale === l ? "on" : ""} onClick={() => setLocale(l)}>
                    {l === "all" ? "All" : (LOCALES[l] ?? l)}
                  </button>
                ))}
              </div>
              <div className="seg">
                {["all", "female", "male", "character"].map((g) => (
                  <button key={g} className={gender === g ? "on" : ""} onClick={() => setGender(g)}>
                    {g === "all" ? "Any" : g[0].toUpperCase() + g.slice(1)}
                  </button>
                ))}
              </div>
              <input
                className="search"
                placeholder="Search voices…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="grid">
              {filtered.map((v) => (
                <button
                  key={v.id}
                  className={`voice ${voice?.id === v.id ? "on" : ""}`}
                  onClick={() => setVoiceId(v.id)}
                  title={v.description}
                >
                  <div className="name">{v.name}</div>
                  <div className="meta">
                    {LOCALES[v.locale] ?? v.locale} · {v.gender}
                    {v.age ? ` · ${v.age}` : ""}
                  </div>
                  <div className="desc">{v.description}</div>
                </button>
              ))}
              {filtered.length === 0 && <div className="muted">No voices match.</div>}
            </div>
          </section>
        </div>

        <div className="col">
          <section className="card">
            <strong>Last run</strong>
            {last ? (
              <div className="metrics">
                <Metric label="Real-time factor" value={last.rtf.toFixed(2)} hint={last.rtf < 1 ? "faster than real time" : "slower than real time"} good={last.rtf < 1} />
                <Metric label="First audio" value={sec(last.ttfaMs)} hint="time to first sound" />
                <Metric label="Generated" value={sec(last.totalMs)} hint={`${last.audioSec.toFixed(1)} s of audio`} />
                <Metric label="RAM" value={`${last.ramMb.toFixed(0)} MB`} hint="this process" />
              </div>
            ) : (
              <div className="muted">Generate something to see speed numbers.</div>
            )}
          </section>

          <section className="card history">
            <div className="row">
              <strong>History</strong>
              <span className="spacer" />
              {runs.length > 0 && <button onClick={() => setRuns([])}>Clear</button>}
            </div>
            {runs.length === 0 && <div className="muted">Nothing yet.</div>}
            <ul>
              {runs.map((r) => (
                <li key={r.id} className={playingRun === r.id ? "playing" : ""}>
                  <button className="play" onClick={() => (playingRun === r.id ? void stop() : replay(r))}>
                    {playingRun === r.id ? "■" : "▶"}
                  </button>
                  <div className="info">
                    <div>
                      <strong>{r.voice.name}</strong>{" "}
                      <span className="muted">
                        RTF {r.stats.rtf.toFixed(2)} · first {sec(r.stats.ttfaMs)} · {r.stats.audioSec.toFixed(1)} s audio
                      </span>
                    </div>
                    <div className="snippet muted">{r.text}</div>
                    {r.savedTo && <div className="muted saved">Saved: {r.savedTo}</div>}
                  </div>
                  <button onClick={() => void save(r)} title="Save as WAV">
                    Save
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}

function Metric(props: { label: string; value: string; hint?: string; good?: boolean }) {
  return (
    <div className="metric">
      <div className="label">{props.label}</div>
      <div className={`value ${props.good ? "good" : ""}`}>{props.value}</div>
      {props.hint && <div className="hint">{props.hint}</div>}
    </div>
  );
}
