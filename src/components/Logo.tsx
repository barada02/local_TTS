/** The app logo: the same five bars as app-icon.svg, for use inside the UI. */
export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label="tts-bench">
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#16271f" />
          <stop offset="1" stopColor="#060a08" />
        </linearGradient>
        <linearGradient id="logo-green" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6bf5a8" />
          <stop offset="1" stopColor="#1fb066" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" fill="url(#logo-bg)" />
      <rect x="14" y="14" width="996" height="996" rx="214" fill="none" stroke="#34d27b" strokeOpacity="0.35" strokeWidth="8" />
      <rect x="160" y="382" width="96" height="260" rx="48" fill="#fff" fillOpacity="0.92" />
      <rect x="312" y="252" width="96" height="520" rx="48" fill="#fff" />
      <rect x="464" y="162" width="96" height="700" rx="48" fill="url(#logo-green)" />
      <rect x="616" y="302" width="96" height="420" rx="48" fill="#fff" />
      <rect x="768" y="362" width="96" height="300" rx="48" fill="#fff" fillOpacity="0.92" />
    </svg>
  );
}
