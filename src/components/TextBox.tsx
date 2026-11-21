import { SAMPLES } from "../lib/samples";
import { useSession } from "../lib/session";

/** The text to speak, with a picker for the fixed test sentences. Shared by every page. */
export default function TextBox({ rows = 5 }: { rows?: number }) {
  const { text, setText } = useSession();
  return (
    <div className="textbox">
      <div className="row">
        <div className="chips">
          {SAMPLES.map((s) => (
            <button key={s.label} className={`chip ${text === s.text ? "on" : ""}`} onClick={() => setText(s.text)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted small">{text.length} chars</span>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={rows} spellCheck={false} />
    </div>
  );
}
