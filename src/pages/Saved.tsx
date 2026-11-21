import { useState } from "react";
import { synthesize } from "../lib/clips";
import { favKey, useSession, type Favorite } from "../lib/session";
import { PlayIcon, StarIcon, StopIcon } from "../components/Icons";
import TextBox from "../components/TextBox";
import { voiceMeta } from "../components/VoiceCard";

export default function Saved() {
  const s = useSession();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [playingClip, setPlayingClip] = useState<{ key: string; id: number } | null>(null);

  // Group by engine, keeping the order voices were saved in.
  const groups = new Map<string, Favorite[]>();
  for (const f of s.favorites) groups.set(f.engine, [...(groups.get(f.engine) ?? []), f]);

  async function preview(f: Favorite) {
    const engine = s.engines.find((e) => e.id === f.engine);
    if (!engine?.downloaded || !s.text.trim()) return;
    const key = favKey(f.engine, f.voice.id);
    s.player.unlock();
    s.player.stop();
    await s.stopAll();
    s.setBusy("saved");
    setPreviewing(key);
    s.setError(null);
    try {
      const info = await s.ensureLoaded(engine.id);
      if (!info) return;
      s.player.setRate(info.sampleRate);
      const voice = engine.voices.find((v) => v.id === f.voice.id) ?? f.voice;
      const clip = await synthesize(engine, voice, s.text, (c) => s.player.push(c));
      if (clip) {
        s.setPlaying(clip.id);
        setPlayingClip({ key, id: clip.id });
      }
    } catch (e) {
      s.setError(String(e));
    } finally {
      setPreviewing(null);
      s.setBusy(null);
    }
  }

  if (s.favorites.length === 0) {
    return (
      <div className="page narrow">
        <div className="empty">
          <div className="empty-star">
            <StarIcon size={34} />
          </div>
          <h2>No saved voices yet</h2>
          <p className="muted">
            Click the star on any voice in the Studio to keep it here. Saved voices from every model live in this tab, and
            the Compare tab races them against each other.
          </p>
          <button className="primary" onClick={() => s.setTab("studio")}>
            Go to the Studio
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page narrow">
      <section className="panel">
        <h2>Text to preview</h2>
        <TextBox rows={3} />
      </section>

      {[...groups.entries()].map(([engineId, list]) => {
        const engine = s.engines.find((e) => e.id === engineId);
        return (
          <section key={engineId} className="panel">
            <div className="row">
              <h2>{list[0].engineName}</h2>
              <span className="count">{list.length}</span>
              {engine && !engine.downloaded && <span className="badge warn">Not installed</span>}
            </div>
            <ul className="saved-list">
              {list.map((f) => {
                const key = favKey(f.engine, f.voice.id);
                const isPlaying = playingClip?.key === key && s.playing === playingClip.id;
                const busyHere = previewing === key;
                return (
                  <li key={key}>
                    <button
                      className="round"
                      disabled={!engine?.downloaded || (!!s.busy && !busyHere && !isPlaying)}
                      aria-label={isPlaying ? "Stop" : "Preview"}
                      onClick={() => (isPlaying ? void s.stopAll() : void preview(f))}
                    >
                      {isPlaying || busyHere ? <StopIcon /> : <PlayIcon />}
                    </button>
                    <div className="info">
                      <div className="line">
                        <strong>{f.voice.name}</strong>
                      </div>
                      <div className="muted small">{voiceMeta(f.voice)}</div>
                    </div>
                    <button className="ghost" onClick={() => s.openInStudio(f.engine, f.voice.id)}>
                      Open in Studio
                    </button>
                    <button
                      className="icon-btn star on"
                      title="Remove from saved voices"
                      onClick={() => s.removeFavorite(f.engine, f.voice.id)}
                    >
                      <StarIcon filled />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
