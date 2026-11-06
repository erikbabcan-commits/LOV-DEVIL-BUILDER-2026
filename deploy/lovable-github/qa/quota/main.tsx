import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ConnectionPanel } from "../../src/components/forge/ConnectionPanel";
import { setFixtureUser, useSession } from "./session";
import "../../src/styles.css";
function Fixture() {
  const [open, setOpen] = useState(true),
    session = useSession();
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b border-border p-4 text-xs">
        <strong>Lokálna ukážka · syntetické účty</strong>
        <button
          onClick={() => setFixtureUser("alice")}
          aria-pressed={session.session.user.id === "alice"}
        >
          Alice
        </button>
        <button
          onClick={() => setFixtureUser("bob")}
          aria-pressed={session.session.user.id === "bob"}
        >
          Bob
        </button>
        <a href="/qa/quota/index.html?full=1">Plný limit Alice</a>
        {!open && <button onClick={() => setOpen(true)}>Zobraziť spotrebu</button>}
      </header>
      <main className="relative min-h-[650px]">
        {open && <ConnectionPanel onClose={() => setOpen(false)} />}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
