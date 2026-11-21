import { useEffect, useRef, useState } from "react";
import { createVoice, type CloneSpec, type VoiceInfo } from "./lib/api";
import { Player } from "./lib/audio";
import { decodeToMono, rms, startRecording, trimSilence, type Recording } from "./lib/capture";

const SCRIPT =
  "The quick brown fox jumps over the lazy dog. I'm reading this out loud in my normal voice, " +
  "at an easy pace, so the model can learn how I sound.";

interface Props {
  engine: string;
  engineName: string;
  spec: CloneSpec;
  onClose: () => void;
  onCreated: (voice: VoiceInfo) => void;
}

export default function CloneDialog({ engine, engineName, spec, onClose, onCreated }: Props) {
  const player = useRef(new Player());
  const recording = useRef<Recording | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const [recSeconds, setRecSeconds] = useState<number | null>(null); // null = not recording
  const [clip, setClip] = useState<Float32Array | null>(null);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      window.clearInterval(timer.current);
      player.current.stop();
    },
    [],
  );

  const seconds = clip ? clip.length / spec.sampleRate : 0;
  const tooShort = clip !== null && seconds < spec.minSeconds;
  const quiet = clip !== null && rms(clip) < 0.01;

  async function accept(data: ArrayBuffer) {
    try {
      const pcm = await decodeToMono(data, spec.sampleRate);
      const trimmed = trimSilence(pcm, spec.sampleRate);
      const max = Math.round(spec.maxSeconds * spec.sampleRate);
      setClip(trimmed.length > max ? trimmed.slice(0, max) : trimmed);
      setError(null);
    } catch {
      setError("That audio could not be read. Try a WAV or MP3 file, or record again.");
    }
  }

  async function toggleRecord() {
    if (recSeconds !== null) {
      window.clearInterval(timer.current);
      const rec = recording.current;
      recording.current = null;
      setRecSeconds(null);
      if (rec) await accept(await rec.stop());
      return;
    }
    try {
      player.current.stop();
      recording.current = await startRecording();
    } catch {
      setError("The microphone could not be opened. Check that this app is allowed to use it.");
      return;
    }
    const started = Date.now();
    setRecSeconds(0);
    timer.current = window.setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setRecSeconds(s);
      if (s >= spec.maxSeconds + 2) void toggleRecord(); // stop by itself a little after the limit
    }, 200);
  }

  async function pickFile(file: File | undefined) {
    if (file) await accept(await file.arrayBuffer());
  }

  function preview() {
    if (!clip) return;
    player.current.stop();
    player.current.setRate(spec.sampleRate);
    player.current.push(clip);
  }

  async function create() {
    if (!clip) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createVoice(engine, name, clip));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog card" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong>Clone a voice · {engineName}</strong>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <p className="muted small">
          Record about {spec.maxSeconds.toFixed(0)} seconds of clear speech in a quiet room (at least{" "}
          {spec.minSeconds} s), or choose an audio file. Only the first {spec.maxSeconds.toFixed(0)} s are used. The
          recording stays on this computer.
        </p>
        <blockquote className="script">{SCRIPT}</blockquote>

        <div className="row wrap">
          <button className={recSeconds !== null ? "danger" : "primary"} disabled={busy} onClick={() => void toggleRecord()}>
            {recSeconds !== null ? `■ Stop (${recSeconds.toFixed(1)} s)` : "● Record"}
          </button>
          <span className="muted">or</span>
          <label className="button">
            Choose a file…
            <input
              type="file"
              accept="audio/*"
              hidden
              disabled={busy || recSeconds !== null}
              onChange={(e) => {
                void pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        {clip && (
          <div className="row wrap">
            <button onClick={preview}>▶ Play clip</button>
            <span className={tooShort ? "bad" : "muted"}>{seconds.toFixed(1)} s</span>
            {tooShort && <span className="bad">Too short: at least {spec.minSeconds} s of speech is needed.</span>}
            {quiet && !tooShort && <span className="warn">Very quiet. A closer microphone gives a better voice.</span>}
          </div>
        )}

        <div className="row">
          <input
            className="grow"
            placeholder="Name this voice"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            This is my own voice, or I have the speaker's permission to clone it. I won't use it to impersonate anyone
            or to mislead listeners.
          </span>
        </label>

        {error && <div className="error">{error}</div>}

        <div className="row">
          <span className="spacer" />
          <button
            className="primary"
            disabled={!clip || tooShort || !name.trim() || !consent || busy || recSeconds !== null}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create voice"}
          </button>
        </div>
      </div>
    </div>
  );
}
