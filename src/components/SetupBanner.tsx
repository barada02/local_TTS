import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cancelDownload, type EngineInfo } from "../lib/api";
import { useSession } from "../lib/session";

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(0)} MB`;
const ackKey = (engine: string) => `tts-bench-ack-${engine}`;

/** The license of an engine, as a compact strip. */
export function LicenseStrip({ engine }: { engine: EngineInfo }) {
  const { license } = engine;
  return (
    <div className={`license ${license.commercialOk ? "ok" : "restricted"}`}>
      <span className="badge">
        {license.name}
        {license.commercialOk ? " · commercial use OK" : " · not for commercial use"}
      </span>
      <span className="muted">{license.summary}</span>
      {license.credit && <span className="credit">{license.credit}</span>}
      <button className="link" onClick={() => void openUrl(license.url)}>
        Read the license
      </button>
    </div>
  );
}

/** Shown while an engine's files aren't downloaded yet (or are being). */
export default function SetupBanner({ engine }: { engine: EngineInfo }) {
  const { phases, install } = useSession();
  const phase = phases[engine.id] ?? { kind: "idle" };
  const [acked, setAcked] = useState(() => localStorage.getItem(ackKey(engine.id)) === "1");
  const needsAck = !engine.license.commercialOk;
  const canStart = !needsAck || acked;
  const setupOnly = engine.presentBytes >= engine.totalBytes;

  function acknowledge(on: boolean) {
    localStorage.setItem(ackKey(engine.id), on ? "1" : "0");
    setAcked(on);
  }

  return (
    <section className="panel setup">
      <div className="setup-title">
        {setupOnly ? (
          <>
            <strong>{engine.name}</strong> is downloaded and needs a one-time setup.
          </>
        ) : (
          <>
            <strong>{engine.name}</strong> isn't installed yet. It's a one-time download of {mb(engine.totalBytes)}.
          </>
        )}
      </div>

      {needsAck && (
        <label className="check">
          <input type="checkbox" checked={acked} onChange={(e) => acknowledge(e.target.checked)} />
          <span>I'll use this model only for non-commercial purposes and credit it as the license requires.</span>
        </label>
      )}

      {phase.kind === "downloading" || phase.kind === "verifying" ? (
        <div className="row">
          <div className="bar">
            <div style={{ width: `${phase.kind === "downloading" ? (phase.progress * 100).toFixed(1) : 100}%` }} />
          </div>
          <span className="muted">{phase.kind === "verifying" ? "Verifying…" : `${(phase.progress * 100).toFixed(0)}%`}</span>
          <button onClick={() => void cancelDownload()}>Cancel</button>
        </div>
      ) : phase.kind === "installing" ? (
        <div className="muted">{phase.message || "Setting up…"} This can take a minute.</div>
      ) : phase.kind === "loading" ? (
        <div className="muted">Loading the model…</div>
      ) : (
        <div className="row">
          <button className="primary" disabled={!canStart} onClick={() => void install(engine.id)}>
            {setupOnly ? "Finish setup" : engine.presentBytes > 0 ? "Resume download" : "Download"}
          </button>
          {!canStart && <span className="muted">Tick the box to continue.</span>}
        </div>
      )}
    </section>
  );
}
