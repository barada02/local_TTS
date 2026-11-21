import { useRef, useState } from "react";
import { seconds, synthesize, type Clip } from "../lib/clips";
import { favKey, useSession, type Favorite } from "../lib/session";
import BarChart from "../components/BarChart";
import { PlayIcon, StopIcon } from "../components/Icons";
import TextBox from "../components/TextBox";
import { voiceMeta } from "../components/VoiceCard";

interface Row {
  key: string;
  fav: Favorite;
  status: "ok" | "skipped" | "error";
  note?: string;
  runs: number;
  rtf: number;
  ttfaMs: number;
  totalMs: number;
  audioSec: number;
  ramMb: number;
  clip?: Clip;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export default function Compare() {
  const s = useSession();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [runsPer, setRunsPer] = useState(1);
  const [warmup, setWarmup] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [ranText, setRanText] = useState<string | null>(null);
  const cancel = useRef(false);
  const warmed = useRef(new Set<string>());

  const running = s.busy === "compare";
  const chosen = s.favorites.filter((f) => !excluded.has(favKey(f.engine, f.voice.id)));

  function toggle(f: Favorite) {
    const key = favKey(f.engine, f.voice.id);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function run() {
    if (!s.text.trim() || chosen.length === 0) return;
    s.player.unlock();
    s.player.stop();
    await s.stopAll();
    cancel.current = false;
    s.setBusy("compare");
    s.setError(null);
    setRows([]);
    setRanText(s.text);
    const text = s.text;
    const add = (row: Row) => setRows((prev) => [...prev, row]);

    try {
      const engines = await s.refresh();
      for (let i = 0; i < chosen.length; i++) {
        if (cancel.current) break;
        const fav = chosen[i];
        const key = favKey(fav.engine, fav.voice.id);
        const blank = { key, fav, runs: 0, rtf: 0, ttfaMs: 0, totalMs: 0, audioSec: 0, ramMb: 0 };
        setProgress({ done: i, total: chosen.length, label: `${fav.engineName} · ${fav.voice.name}` });

        const engine = engines.find((e) => e.id === fav.engine);
        if (!engine || !engine.downloaded) {
          add({ ...blank, status: "skipped", note: "Model not installed. Install it in the Studio." });
          continue;
        }
        const voice = engine.voices.find((v) => v.id === fav.voice.id);
        if (!voice) {
          add({ ...blank, status: "skipped", note: "This voice no longer exists." });
          continue;
        }
        try {
          if (!(await s.ensureLoaded(engine.id))) {
            add({ ...blank, status: "error", note: "The model could not be loaded." });
            continue;
          }
          // The first run on a model is often slower (caches, lazy setup), so do one nobody sees.
          if (warmup && !warmed.current.has(engine.id)) {
            await synthesize(engine, voice, "Warming up the voice.");
            warmed.current.add(engine.id);
          }
          const clips: Clip[] = [];
          for (let r = 0; r < runsPer && !cancel.current; r++) {
            const clip = await synthesize(engine, voice, text);
            if (clip) clips.push(clip);
          }
          if (clips.length === 0) {
            if (!cancel.current) add({ ...blank, status: "error", note: "No audio was produced." });
            continue;
          }
          const st = clips.map((c) => c.stats);
          add({
            ...blank,
            status: "ok",
            runs: clips.length,
            rtf: mean(st.map((x) => x.rtf)),
            ttfaMs: mean(st.map((x) => x.ttfaMs)),
            totalMs: mean(st.map((x) => x.totalMs)),
            audioSec: clips[clips.length - 1].stats.audioSec,
            ramMb: Math.max(...st.map((x) => x.ramMb)),
            clip: clips[clips.length - 1],
          });
        } catch (e) {
          add({ ...blank, status: "error", note: String(e) });
        }
      }
    } catch (e) {
      s.setError(String(e));
    } finally {
      setProgress(null);
      s.setBusy(null);
    }
  }

  async function stop() {
    cancel.current = true;
    await s.stopAll();
  }

  if (s.favorites.length === 0) {
    return (
      <div className="page narrow">
        <div className="empty">
          <div className="empty-star">⚖</div>
          <h2>Nothing to compare yet</h2>
          <p className="muted">
            Save two or more voices with the star in the Studio. This tab then speaks the same text with each of them and
            charts speed and memory side by side, even across different models.
          </p>
          <button className="primary" onClick={() => s.setTab("studio")}>
            Go to the Studio
          </button>
        </div>
      </div>
    );
  }

  const ok = rows.filter((r) => r.status === "ok");
  const label = (r: Row) => r.fav.voice.name;
  const sub = (r: Row) => r.fav.engineName;
  const items = (pick: (r: Row) => number) => ok.map((r) => ({ key: r.key, label: label(r), sub: sub(r), value: pick(r) }));
  const best = (pick: (r: Row) => number) => (ok.length ? ok.reduce((a, b) => (pick(b) < pick(a) ? b : a)) : null);
  const fastest = best((r) => r.rtf);
  const quickest = best((r) => r.ttfaMs);
  const lightest = best((r) => r.ramMb);
  const textChanged = ranText !== null && ranText !== s.text;

  return (
    <div className="page">
      <div className="compare-top">
        <section className="panel">
          <h2>Text</h2>
          <TextBox rows={4} />
        </section>

        <section className="panel">
          <div className="row">
            <h2>Voices to compare</h2>
            <span className="count">{chosen.length}</span>
          </div>
          <ul className="choose">
            {s.favorites.map((f) => {
              const key = favKey(f.engine, f.voice.id);
              const engine = s.engines.find((e) => e.id === f.engine);
              return (
                <li key={key}>
                  <label className="check">
                    <input type="checkbox" checked={!excluded.has(key)} disabled={running} onChange={() => toggle(f)} />
                    <span>
                      <strong>{f.voice.name}</strong> <span className="muted">· {f.engineName}</span>
                      <span className="muted small"> · {voiceMeta(f.voice)}</span>
                    </span>
                  </label>
                  {engine && !engine.downloaded && <span className="badge warn">Not installed</span>}
                </li>
              );
            })}
          </ul>
          <div className="row wrap">
            <label className="muted small">
              Runs per voice{" "}
              <select value={runsPer} disabled={running} onChange={(e) => setRunsPer(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={2}>2 (averaged)</option>
                <option value={3}>3 (averaged)</option>
              </select>
            </label>
            <label className="check small">
              <input type="checkbox" checked={warmup} disabled={running} onChange={(e) => setWarmup(e.target.checked)} />
              <span>Warm-up run first</span>
            </label>
            <span className="spacer" />
            {running ? (
              <button className="danger" onClick={() => void stop()}>
                <StopIcon /> Stop
              </button>
            ) : (
              <button
                className="primary"
                disabled={!!s.busy || chosen.length === 0 || !s.text.trim()}
                onClick={() => void run()}
              >
                <PlayIcon /> Compare {chosen.length} voice{chosen.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
          {progress && (
            <div className="progress">
              <div className="bar">
                <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
              <span className="muted small">
                {progress.done + 1} of {progress.total} · {progress.label}
              </span>
            </div>
          )}
        </section>
      </div>

      {rows.length === 0 && !running && (
        <p className="muted center">Press Compare to run the same text through every selected voice.</p>
      )}

      {ok.length > 0 && (
        <>
          {textChanged && <div className="note">The text has changed since this comparison. Run it again to update.</div>}

          <div className="winners">
            {fastest && <Winner title="Fastest overall" row={fastest} value={`RTF ${fastest.rtf.toFixed(2)}`} />}
            {quickest && <Winner title="Quickest to start" row={quickest} value={seconds(quickest.ttfaMs)} />}
            {lightest && <Winner title="Lightest on memory" row={lightest} value={`${lightest.ramMb.toFixed(0)} MB`} />}
          </div>

          <div className="charts">
            <BarChart
              title="Real-time factor"
              hint="generation time ÷ audio length · lower is faster"
              items={items((r) => r.rtf)}
              format={(v) => v.toFixed(2)}
              reference={{ value: 1, label: "real time" }}
              warnAbove={1}
            />
            <BarChart
              title="Time to first audio"
              hint="seconds until the first sound · lower is better"
              items={items((r) => r.ttfaMs / 1000)}
              format={(v) => `${v.toFixed(2)} s`}
            />
            <BarChart
              title="Generation time"
              hint="seconds to make the whole clip · lower is better"
              items={items((r) => r.totalMs / 1000)}
              format={(v) => `${v.toFixed(2)} s`}
            />
            <BarChart
              title="Memory"
              hint="MB used by the process the model runs in · lower is better"
              items={items((r) => r.ramMb)}
              format={(v) => `${v.toFixed(0)} MB`}
            />
          </div>
        </>
      )}

      {rows.length > 0 && (
        <section className="panel">
          <h2>Results</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Voice</th>
                  <th>Model</th>
                  <th className="num">RTF</th>
                  <th className="num">First audio</th>
                  <th className="num">Generated in</th>
                  <th className="num">Audio</th>
                  <th className="num">Memory</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={r.status === "ok" ? (s.playing === r.clip?.id ? "playing" : "") : "dim"}>
                    <td>
                      {r.clip && (
                        <button
                          className="round small-btn"
                          aria-label="Play"
                          onClick={() => (s.playing === r.clip!.id ? void s.stopAll() : s.playClip(r.clip!))}
                        >
                          {s.playing === r.clip.id ? <StopIcon size={14} /> : <PlayIcon size={14} />}
                        </button>
                      )}
                    </td>
                    <td>
                      <strong>{r.fav.voice.name}</strong>
                    </td>
                    <td className="muted">{r.fav.engineName}</td>
                    {r.status === "ok" ? (
                      <>
                        <td className={`num ${r.rtf < 1 ? "good" : "slow"}`}>{r.rtf.toFixed(2)}</td>
                        <td className="num">{seconds(r.ttfaMs)}</td>
                        <td className="num">{seconds(r.totalMs)}</td>
                        <td className="num">{r.audioSec.toFixed(1)} s</td>
                        <td className="num">{r.ramMb.toFixed(0)} MB</td>
                      </>
                    ) : (
                      <td colSpan={5} className="muted">
                        {r.note}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Numbers are from this machine, for this text. Runs are one at a time so they don't slow each other down.
            Speed varies with the text, so try a few of the test sentences.
          </p>
        </section>
      )}
    </div>
  );
}

function Winner({ title, row, value }: { title: string; row: Row; value: string }) {
  return (
    <div className="paper winner">
      <div className="paper-muted small">{title}</div>
      <div className="winner-value">{value}</div>
      <div>
        <strong>{row.fav.voice.name}</strong> <span className="paper-muted">· {row.fav.engineName}</span>
      </div>
    </div>
  );
}
