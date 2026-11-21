import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  cancelDownload,
  deleteVoice,
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
import CloneDialog from "./CloneDialog";

interface Run {
  id: number;
  engine: string;
  engineName: string;
  voice: VoiceInfo;
  text: string;
  stats: SpeakStats;
  audio: Float32Array;
  savedTo?: string;
}

const LOCALES: Record<string, string> = {
  custom: "My voices",
  "en-us": "US",
  "en-gb": "UK",
  en: "English",
  characters: "Characters",
};
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(0)} MB`;
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const ackKey = (engine: string) => `tts-bench-ack-${engine}`;

type Phase = "idle" | "downloading" | "verifying" | "installing" | "loading";

export default function App() {
  const player = useMemo(() => new Player(), []);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engineId, setEngineId] = useState("phonon");
  const [loadInfos, setLoadInfos] = useState<Record<string, LoadInfo>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [installMsg, setInstallMsg] = useState("");
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState(SAMPLES[0].text);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [locale, setLocale] = useState("all");
  const [gender, setGender] = useState("all");
  const [query, setQuery] = useState("");
  const [cloning, setCloning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [runs, setRuns] = useState<Run[]>([]);
  const [playingRun, setPlayingRun] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "one" | "all">(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const runId = useRef(0);
  const cancelBatch = useRef(false);

  const engine = engines.find((e) => e.id === engineId);
  const voices = engine?.voices ?? [];
  const voice = voices.find((v) => v.id === voiceId) ?? voices[0];
  const loadInfo = loadInfos[engineId] ?? null;
  const license = engine?.license;
  const licenseOk = !license || license.commercialOk || acked[engineId];

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
        setLoadInfos((prev) => ({ ...prev, [id]: info.loadMs > 0 || !prev[id] ? info : prev[id] }));
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setPhase("idle");
      }
    },
    [refresh],
  );

  useEffect(() => {
    setAcked(Object.fromEntries(["phonon", "kokoro", "kitten-nano", "kitten-micro", "kitten-mini", "woof"].map((id) => [id, localStorage.getItem(ackKey(id)) === "1"])));
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  // Load an engine when it is selected, if its files are in place.
  useEffect(() => {
    if (engine?.downloaded && !loadInfos[engine.id] && phase === "idle") void load(engine.id);
  }, [engine, loadInfos, phase, load]);

  useEffect(() => {
    if (loadInfo) player.setRate(loadInfo.sampleRate);
  }, [loadInfo, player]);

  useEffect(() => {
    player.onIdle = () => setPlayingRun(null);
  }, [player]);

  function switchEngine(id: string) {
    void stop();
    setEngineId(id);
    setVoiceId(null);
    setLocale("all");
    setGender("all");
    setQuery("");
  }

  function acknowledge(on: boolean) {
    localStorage.setItem(ackKey(engineId), on ? "1" : "0");
    setAcked((a) => ({ ...a, [engineId]: on }));
  }

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
        } else if (e.kind === "verifying") {
          setPhase("verifying");
        } else {
          setPhase("installing");
          setInstallMsg(e.message);
        }
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
    const run: Run = {
      id: ++runId.current,
      engine: engineId,
      engineName: engine?.name ?? engineId,
      voice: v,
      text,
      stats,
      audio: concat(chunks),
    };
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

  async function removeVoice(v: VoiceInfo) {
    if (confirmDelete !== v.id) {
      setConfirmDelete(v.id);
      return;
    }
    setConfirmDelete(null);
    try {
      await deleteVoice(engineId, v.id);
      if (voiceId === v.id) setVoiceId(null);
      await refresh();
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
  const locales = [...new Set(voices.map((v) => v.locale))].sort((a, b) => (a === "custom" ? -1 : b === "custom" ? 1 : 0));
  const genders = ["all", ...new Set(voices.map((v) => v.gender))];
  const ready = !!engine?.downloaded && phase === "idle" && !!loadInfo;
  const last = runs[0]?.stats;
  const setupOnly = !!engine && engine.presentBytes >= engine.totalBytes;

  return (
    <div className="app">
      <header>
        <h1>tts-bench</h1>
        <select value={engineId} onChange={(e) => switchEngine(e.target.value)}>
          {engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <span className="muted engine-desc">{engine?.description}</span>
        <span className="spacer" />
        {loadInfo && (
          <span className="chip" title="Time to load the model, and the memory of the process it runs in">
            loaded in {sec(loadInfo.loadMs)} · {loadInfo.ramMb.toFixed(0)} MB RAM
          </span>
        )}
      </header>

      {license && (
        <div className={`license ${license.commercialOk ? "" : "restricted"}`}>
          <strong>{license.name}</strong>
          <span>{license.commercialOk ? " · commercial use OK" : " · not for commercial use"}</span>
          <span className="muted"> — {license.summary}</span>
          {license.credit && <div className="credit">{license.credit}</div>}
          <button className="link" onClick={() => void openUrl(license.url)}>
            Read the license
          </button>
        </div>
      )}

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {engine && !engine.downloaded && (
        <section className="card setup">
          <div>
            {setupOnly ? (
              <>
                <strong>{engine.name}</strong> is downloaded. It still needs a one-time setup (a Python environment
                with numpy).
              </>
            ) : (
              <>
                <strong>{engine.name}</strong> needs to be downloaded once ({mb(engine.totalBytes)}).
              </>
            )}
          </div>
          {license && !license.commercialOk && (
            <label className="check">
              <input type="checkbox" checked={!!acked[engineId]} onChange={(e) => acknowledge(e.target.checked)} />
              <span>I'll use this model only for non-commercial purposes, and credit it as the license requires.</span>
            </label>
          )}
          {phase === "downloading" || phase === "verifying" ? (
            <div className="row">
              <div className="bar">
                <div style={{ width: `${(progress * 100).toFixed(1)}%` }} />
              </div>
              <span className="muted">{phase === "verifying" ? "Verifying…" : `${(progress * 100).toFixed(0)}%`}</span>
              <button onClick={() => void cancelDownload()}>Cancel</button>
            </div>
          ) : phase === "installing" ? (
            <div className="muted">{installMsg || "Setting up…"} (this can take a minute)</div>
          ) : (
            <div className="row">
              <button className="primary" disabled={!licenseOk} onClick={() => void download()}>
                {setupOnly ? "Finish setup" : engine.presentBytes > 0 ? "Resume download" : "Download"}
              </button>
              {!licenseOk && <span className="muted">Tick the box to continue.</span>}
            </div>
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
              {locales.length > 1 && (
                <div className="seg">
                  {["all", ...locales].map((l) => (
                    <button key={l} className={locale === l ? "on" : ""} onClick={() => setLocale(l)}>
                      {l === "all" ? "All" : (LOCALES[l] ?? l)}
                    </button>
                  ))}
                </div>
              )}
              {genders.length > 2 && (
                <div className="seg">
                  {genders.map((g) => (
                    <button key={g} className={gender === g ? "on" : ""} onClick={() => setGender(g)}>
                      {g === "all" ? "Any" : g[0].toUpperCase() + g.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="search"
                placeholder="Search voices…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {engine?.clone && (
                <button disabled={!ready || !!busy} onClick={() => setCloning(true)}>
                  + Clone a voice
                </button>
              )}
            </div>
            <div className="grid">
              {filtered.map((v) => (
                <button
                  key={v.id}
                  className={`voice ${voice?.id === v.id ? "on" : ""}`}
                  onClick={() => setVoiceId(v.id)}
                  title={v.description}
                >
                  <div className="name">
                    {v.name}
                    {v.custom && (
                      <span
                        role="button"
                        className="del"
                        title="Delete this voice"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeVoice(v);
                        }}
                      >
                        {confirmDelete === v.id ? "Delete?" : "✕"}
                      </span>
                    )}
                  </div>
                  <div className="meta">
                    {LOCALES[v.locale] ?? v.locale}
                    {v.gender !== "unknown" && v.gender !== "custom" ? ` · ${v.gender}` : ""}
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
                <Metric
                  label="Real-time factor"
                  value={last.rtf.toFixed(2)}
                  hint={last.rtf < 1 ? "faster than real time" : "slower than real time"}
                  good={last.rtf < 1}
                />
                <Metric label="First audio" value={sec(last.ttfaMs)} hint="time to first sound" />
                <Metric label="Generated" value={sec(last.totalMs)} hint={`${last.audioSec.toFixed(1)} s of audio`} />
                <Metric label="RAM" value={`${last.ramMb.toFixed(0)} MB`} hint="process the model runs in" />
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
                      <strong>{r.voice.name}</strong> <span className="muted">· {r.engineName}</span>{" "}
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

      {cloning && engine?.clone && (
        <CloneDialog
          engine={engine.id}
          engineName={engine.name}
          spec={engine.clone}
          onClose={() => setCloning(false)}
          onCreated={async (v) => {
            setCloning(false);
            await refresh();
            setLocale("custom");
            setGender("all");
            setVoiceId(v.id);
          }}
        />
      )}
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
