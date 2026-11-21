// A horizontal bar chart in plain HTML/CSS: one bar per voice, best (lowest) first.

export interface BarItem {
  key: string;
  label: string;
  sub: string;
  value: number;
}

interface Props {
  title: string;
  hint: string;
  items: BarItem[];
  format: (value: number) => string;
  /** A marker line, such as "real time" at 1.0. */
  reference?: { value: number; label: string };
  /** Bars above this value are drawn in the warning colour. */
  warnAbove?: number;
}

export default function BarChart({ title, hint, items, format, reference, warnAbove }: Props) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const max = Math.max(...sorted.map((i) => i.value), reference ? reference.value * 1.15 : 0, 1e-9);
  const refAt = reference ? (reference.value / max) * 100 : null;

  return (
    <figure className="chart">
      <figcaption>
        <strong>{title}</strong>
        <span className="muted small">{hint}</span>
      </figcaption>
      <div className="bars">
        {refAt !== null && (
          <div className="ref" style={{ left: `calc(var(--label-w) + 10px + (100% - var(--label-w) - var(--value-w) - 20px) * ${refAt / 100})` }}>
            <span>{reference!.label}</span>
          </div>
        )}
        {sorted.map((item, i) => {
          const warn = warnAbove !== undefined && item.value > warnAbove;
          return (
            <div className="bar-row" key={item.key}>
              <div className="bar-label" title={`${item.label} · ${item.sub}`}>
                <span>{item.label}</span>
                <span className="muted small">{item.sub}</span>
              </div>
              <div className="bar-track">
                <div
                  className={`bar-fill ${i === 0 ? "best" : ""} ${warn ? "warn" : ""}`}
                  style={{ width: `${Math.max(1.5, (item.value / max) * 100)}%` }}
                />
              </div>
              <div className="bar-value">{format(item.value)}</div>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
