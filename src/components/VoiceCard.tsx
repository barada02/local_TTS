import type { MouseEvent } from "react";
import type { VoiceInfo } from "../lib/api";
import { StarIcon } from "./Icons";

export const LOCALES: Record<string, string> = {
  custom: "My voices",
  "en-us": "US",
  "en-gb": "UK",
  en: "English",
  characters: "Characters",
};

/** "US · female · Adult" for a voice. */
export function voiceMeta(v: VoiceInfo): string {
  const parts = [LOCALES[v.locale] ?? v.locale];
  if (v.gender !== "unknown" && v.gender !== "custom") parts.push(v.gender);
  if (v.age) parts.push(v.age);
  return parts.join(" · ");
}

interface Props {
  voice: VoiceInfo;
  selected?: boolean;
  starred: boolean;
  onSelect: () => void;
  onStar: () => void;
  onDelete?: () => void;
  confirmingDelete?: boolean;
}

export default function VoiceCard({ voice, selected, starred, onSelect, onStar, onDelete, confirmingDelete }: Props) {
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className={`voice ${selected ? "on" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      title={voice.description}
    >
      <div className="voice-head">
        <span className="voice-name">{voice.name}</span>
        <button
          className={`star ${starred ? "on" : ""}`}
          onClick={stop(onStar)}
          title={starred ? "Remove from saved voices" : "Save this voice"}
          aria-pressed={starred}
        >
          <StarIcon filled={starred} />
        </button>
      </div>
      <div className="voice-meta">{voiceMeta(voice)}</div>
      <div className="voice-desc">{voice.description}</div>
      {onDelete && (
        <button className="mini-del" onClick={stop(onDelete)}>
          {confirmingDelete ? "Delete?" : "Delete"}
        </button>
      )}
    </div>
  );
}
