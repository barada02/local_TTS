import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { deleteVoice, saveWav, type VoiceInfo } from "../lib/api";
import { encodeWav } from "../lib/audio";
import { seconds, synthesize, type Clip } from "../lib/clips";
import { useSession } from "../lib/session";
import CloneDialog from "../CloneDialog";
import { PlayIcon, SaveIcon, StarIcon, StopIcon } from "../components/Icons";
import ModelFiles from "../components/ModelFiles";
import SetupBanner, { LicenseStrip } from "../components/SetupBanner";
import TextBox from "../components/TextBox";
import VoiceCard, { LOCALES } from "../components/VoiceCard";

export default function Studio() {
  const s = useSession();
  const { engines, engineId, voiceId, loadInfos, phases, player } = s;
  const engine = engines.find((e) => e.id === engineId);
  const voices = engine?.voices ?? [];
  const voice = voices.find((v) => v.id === voiceId) ?? voices[0];
  const loadInfo = loadInfos[engineId];
  const phase = phases[engineId] ?? { kind: "idle" };

  const [runs, setRuns] = useState<Clip[]>([]);
  const [locale, setLocale] = useState("all");
  const [gender, setGender] = useState("all");
  const [query, setQuery] = useState("");
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const cancelBatch = useRef(false);
  const tried = useRef(new Set<string>());

  const busy = s.busy === "studio";
  const ready = !!engine?.downloaded && phase.kind === "idle" && !!loadInfo && !s.busy;

  // Load the selected engine once it is installed.
  useEffect(() => {
    if (engine?.downloaded && !loadInfo && phase.kind === "idle" && !tried.current.has(engine.id)) {
      tried.current.add(engine.id);
      void s.ensureLoaded(engine.id);
    }
  }, [engine?.downloaded, engine?.id, loadInfo, phase.kind, s]);

  // A new engine starts with fresh filters.
  useEffect(() => {
    setLocale("all");
    setGender("all");
    setQuery("");
  }, [engineId]);

  function pickEngine(id: string) {
    void s.stopAll();
    s.setEngineId(id);
    s.setVoiceId(null);
  }

  async function generateOne() {
    if (!engine || !voice || !s.text.trim()) return;
    player.unlock();
    player.stop();
    await s.stopAll();
    if (loadInfo) player.setRate(loadInfo.sampleRate);
    s.setBusy("studio");
    s.setError(null);
    try {
      const clip = await synthesize(engine, voice, s.text, (c) => player.push(c));
      if (clip) {
        setRuns((r) => [clip, ...r]);
        s.setPlaying(clip.id);
      }
    } catch (e) {
      s.setError(String(e));
    } finally {
      s.setBusy(null);
    }
  }

  async function generateAll(list: VoiceInfo[]) {
    if (!engine || !s.text.trim() || list.length === 0) return;
    player.unlock();
    player.stop();
    await s.stopAll();
    cancelBatch.current = false;
    s.setBusy("studio");
    s.setError(null);
    try {
      for (let i = 0; i < list.length; i++) {
        if (cancelBatch.current) break;
        setBatch({ done: i, total: list.length });
        const clip = await synthesize(engine, list[i], s.text);
        if (clip) setRuns((r) => [clip, ...r]);
      }
    } catch (e) {
      s.setError(String(e));
    } finally {
      setBatch(null);
      s.setBusy(null);
    }
  }

  async function stop() {
    cancelBatch.current = true;
    await s.stopAll();
  }

  async function save(clip: Clip) {
    try {
      const path = await saveWav(encodeWav(clip.audio, clip.stats.sampleRate), `${clip.engine}-${clip.voice.name}-${clip.id}`);
      setRuns((rs) => rs.map((r) => (r.id === clip.id ? { ...r, savedTo: path } : r)));
      await revealItemInDir(path);
    } catch (e) {
      s.setError(String(e));
    }
  }

  async function removeVoice(v: VoiceInfo) {
    if (confirmDelete !== v.id) return setConfirmDelete(v.id);
    setConfirmDelete(null);
    try {
      await deleteVoice(engineId, v.id);
      if (voiceId === v.id) s.setVoiceId(null);
      await s.refresh();
    } catch (e) {
      s.setError(String(e));
    }
  }

  const filtered = voices.filter(
    (v) =>
      (locale === "all" || v.locale === locale) &&
      (gender === "all" || v.gender === gender) &&
      (!query || `${v.name} ${v.description}`.toLowerCase().includes(query.toLowerCase())),
  );
  const locales = [...new Set(voices.map((v) => v.locale))].sort((a, b) => (a === "custom" ? -1 : b === "custom" ? 1 : 0));
  const genders = [...new Set(voices.map((v) => v.gender))];
  const last = runs[0]?.stats;

  return (
    <div className="page two-col">
      <div className="col">
        <div className="pills" role="tablist" aria-label="Model">
          {engines.map((e) => {
            const loaded = !!loadInfos[e.id];
            return (
              <button
                key={e.id}
                role="tab"
                aria-selected={e.id === engineId}
                className={`pill ${e.id === engineId ? "on" : ""}`}
                onClick={() => pickEngine(e.id)}
                title={e.description}
              >
                <span className={`dot ${loaded ? "loaded" : e.downloaded ? "ready" : ""}`} />
                {e.name}
              </button>
            );
          })}
        </div>

        {engine && <LicenseStrip engine={engine} />}
        {engine && <ModelFiles engine={engine} />}
        {engine && !engine.downloaded && <SetupBanner engine={engine} />}
        {phase.kind === "loading" && <div className="panel muted">Loading {engine?.name}…</div>}
        {engine?.downloaded && !loadInfo && phase.kind === "idle" && (
          <div className="panel row">
            <span className="muted">{engine.name} is installed but not loaded.</span>
            <button onClick={() => void s.ensureLoaded(engine.id)}>Load it</button>
          </div>
        )}

        <section className="panel">
          <TextBox />
          <div className="row wrap">
            {busy ? (
              <button className="danger" onClick={() => void stop()}>
                <StopIcon /> Stop
              </button>
            ) : (
              <button className="primary" disabled={!ready || !s.text.trim()} onClick={() => void generateOne()}>
                <PlayIcon /> Speak with {voice?.name ?? "…"}
              </button>
            )}
            <button
              disabled={!ready || !s.text.trim() || filtered.length === 0}
              onClick={() => void generateAll(filtered)}
              title="Make the same text with every voice shown below, silently. Listen from the history."
            >
              Run all {filtered.length} voices
            </button>
            {batch && (
              <span className="muted">
                {batch.done + 1} / {batch.total}
              </span>
            )}
            <span className="spacer" />
            {loadInfo && (
              <span className="muted small" title="Time to load the model, and the memory of the process it runs in">
                Loaded in {seconds(loadInfo.loadMs)} · {loadInfo.ramMb.toFixed(0)} MB
              </span>
            )}
          </div>
        </section>

        <section className="panel voices">
          <div className="row wrap">
            <h2>Voices</h2>
            {locales.length > 1 && (
              <div className="seg">
                {["all", ...locales].map((l) => (
                  <button key={l} className={locale === l ? "on" : ""} onClick={() => setLocale(l)}>
                    {l === "all" ? "All" : (LOCALES[l] ?? l)}
                  </button>
                ))}
              </div>
            )}
            {genders.length > 1 && (
              <div className="seg">
                {["all", ...genders].map((g) => (
                  <button key={g} className={gender === g ? "on" : ""} onClick={() => setGender(g)}>
                    {g === "all" ? "Any" : g[0].toUpperCase() + g.slice(1)}
                  </button>
                ))}
              </div>
            )}
            <input className="search" placeholder="Search voices…" value={query} onChange={(e) => setQuery(e.target.value)} />
            {engine?.clone && (
              <button disabled={!ready} onClick={() => setCloning(true)}>
                + Clone a voice
              </button>
            )}
          </div>
          <div className="grid">
            {filtered.map((v) => (
              <VoiceCard
                key={v.id}
                voice={v}
                selected={voice?.id === v.id}
                starred={!!engine && s.isFavorite(engine.id, v.id)}
                onSelect={() => s.setVoiceId(v.id)}
                onStar={() => engine && s.toggleFavorite(engine, v)}
                onDelete={v.custom ? () => void removeVoice(v) : undefined}
                confirmingDelete={confirmDelete === v.id}
              />
            ))}
            {filtered.length === 0 && <div className="muted">No voices match.</div>}
          </div>
        </section>
      </div>

      <div className="col">
        <section className="paper">
          <h2>Last run</h2>
          {last ? (
            <div className="metrics">
              <Metric label="Real-time factor" value={last.rtf.toFixed(2)} hint={last.rtf < 1 ? "faster than real time" : "slower than real time"} good={last.rtf < 1} />
              <Metric label="First audio" value={seconds(last.ttfaMs)} hint="until the first sound" />
              <Metric label="Generated in" value={seconds(last.totalMs)} hint={`${last.audioSec.toFixed(1)} s of audio`} />
              <Metric label="Memory" value={`${last.ramMb.toFixed(0)} MB`} hint="process the model runs in" />
            </div>
          ) : (
            <p className="paper-muted">Speak something to see how fast this model is on your machine.</p>
          )}
        </section>

        <section className="panel history">
          <div className="row">
            <h2>History</h2>
            <span className="spacer" />
            {runs.length > 0 && <button onClick={() => setRuns([])}>Clear</button>}
          </div>
          {runs.length === 0 && <div className="muted">Nothing yet.</div>}
          <ul>
            {runs.map((r) => (
              <li key={r.id} className={s.playing === r.id ? "playing" : ""}>
                <button className="round" onClick={() => (s.playing === r.id ? void s.stopAll() : s.playClip(r))} aria-label="Play">
                  {s.playing === r.id ? <StopIcon /> : <PlayIcon />}
                </button>
                <div className="info">
                  <div className="line">
                    <strong>{r.voice.name}</strong>
                    <span className="muted"> · {r.engineName}</span>
                  </div>
                  <div className="muted small">
                    RTF {r.stats.rtf.toFixed(2)} · first {seconds(r.stats.ttfaMs)} · {r.stats.audioSec.toFixed(1)} s audio
                  </div>
                  <div className="snippet muted small">{r.text}</div>
                  {r.savedTo && <div className="muted small wrap-any">Saved: {r.savedTo}</div>}
                </div>
                <button
                  className={`icon-btn star ${s.isFavorite(r.engine, r.voice.id) ? "on" : ""}`}
                  title="Save this voice"
                  onClick={() => {
                    const e = engines.find((x) => x.id === r.engine);
                    if (e) s.toggleFavorite(e, r.voice);
                  }}
                >
                  <StarIcon filled={s.isFavorite(r.engine, r.voice.id)} />
                </button>
                <button className="icon-btn" title="Save as WAV" onClick={() => void save(r)}>
                  <SaveIcon />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {cloning && engine?.clone && (
        <CloneDialog
          engine={engine.id}
          engineName={engine.name}
          spec={engine.clone}
          onClose={() => setCloning(false)}
          onCreated={async (v) => {
            setCloning(false);
            await s.refresh();
            setLocale("custom");
            setGender("all");
            s.setVoiceId(v.id);
          }}
        />
      )}
    </div>
  );
}

function Metric(props: { label: string; value: string; hint: string; good?: boolean }) {
  return (
    <div className="metric">
      <div className="label">{props.label}</div>
      <div className={`value ${props.good ? "good" : ""}`}>{props.value}</div>
      <div className="hint">{props.hint}</div>
    </div>
  );
}
