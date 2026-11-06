import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ForgeProvider } from "../../src/components/forge/ForgeProvider";
import { EditorView } from "../../src/components/forge/EditorView";
import { GitHubCallback } from "../../src/components/forge/GitHubCallback";
import "../../src/styles.css";
const isCallback = new URL(window.location.href).searchParams.get("view") === "callback";
function Fixture() {
  const [drawer, setDrawer] = useState(false);
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-3 text-xs">
        <strong>Lokálna testovacia ukážka</strong>
        <nav className="flex flex-wrap gap-3" aria-label="Testovacie stavy">
          <a href="/qa/github/index.html">Nepripojené</a>
          <a href="/qa/github/index.html?scenario=connected">Pripojené</a>
          <a href="/qa/github/index.html?scenario=error">Chyba</a>
          <a
            href={`/qa/github/index.html?view=callback&state=${"ab".repeat(32)}&code=synthetic-code`}
          >
            Callback
          </a>
          <a href="/qa/github/index.html?scenario=connected&export=recovery">Obnova exportu</a>
        </nav>
      </header>
      {isCallback ? (
        <GitHubCallback />
      ) : (
        <ForgeProvider>
          <EditorView drawer={drawer} setDrawer={setDrawer} />
        </ForgeProvider>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
