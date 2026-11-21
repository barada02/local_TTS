import Logo from "./components/Logo";
import { SessionProvider, useSession, type Tab } from "./lib/session";
import Compare from "./pages/Compare";
import Saved from "./pages/Saved";
import Studio from "./pages/Studio";

const TABS: { id: Tab; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "saved", label: "Saved voices" },
  { id: "compare", label: "Compare" },
];

function Shell() {
  const s = useSession();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo size={30} />
          <span>tts-bench</span>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={s.tab === t.id}
              className={`tab ${s.tab === t.id ? "on" : ""}`}
              onClick={() => s.setTab(t.id)}
            >
              {t.label}
              {t.id === "saved" && s.favorites.length > 0 && <span className="tab-count">{s.favorites.length}</span>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {s.busy && <span className="working">Working…</span>}
      </header>

      {s.error && (
        <div className="error" role="alert" onClick={() => s.setError(null)} title="Click to dismiss">
          {s.error}
        </div>
      )}

      {/* Every page stays mounted, so results and filters survive switching tabs. */}
      <main>
        <div className="view" hidden={s.tab !== "studio"}>
          <Studio />
        </div>
        <div className="view" hidden={s.tab !== "saved"}>
          <Saved />
        </div>
        <div className="view" hidden={s.tab !== "compare"}>
          <Compare />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
