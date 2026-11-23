import { useEffect, useState } from "react";
import type { EngineInfo } from "../lib/api";
import { useSession } from "../lib/session";

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;

/** How much disk an engine's files take, with a button to delete them. */
export default function ModelFiles({ engine }: { engine: EngineInfo }) {
  const s = useSession();
  const phase = s.phases[engine.id] ?? { kind: "idle" };
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);

  // A different engine starts fresh.
  useEffect(() => {
    setConfirming(false);
    setFreed(null);
  }, [engine.id]);

  if (freed !== null && engine.diskBytes === 0) {
    return <div className="files-row muted small">Deleted {engine.name}'s files and freed {mb(freed)}.</div>;
  }
  if (engine.diskBytes === 0 || phase.kind !== "idle") return null;

  const hasOwnVoices = engine.voices.some((v) => v.custom);

  async function remove() {
    setDeleting(true);
    s.setError(null);
    try {
      setFreed(await s.uninstall(engine.id));
    } catch (e) {
      s.setError(String(e));
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="files-row confirm small">
        <span>
          Delete {engine.name}'s files and free {mb(engine.diskBytes)}?
          {hasOwnVoices && " Voices you cloned with it are deleted too."} You can download it again later.
        </span>
        <span className="spacer" />
        <button className="danger" disabled={deleting} onClick={() => void remove()}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <button disabled={deleting} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="files-row muted small">
      <span title="The model, its voices and, for Python engines, the environment it runs in">
        {mb(engine.diskBytes)} on disk
      </span>
      <button
        className="link danger-link"
        disabled={!!s.busy}
        title={s.busy ? "Wait for the current run to finish" : "Delete this model's files to free disk space"}
        onClick={() => setConfirming(true)}
      >
        Delete model files
      </button>
    </div>
  );
}
