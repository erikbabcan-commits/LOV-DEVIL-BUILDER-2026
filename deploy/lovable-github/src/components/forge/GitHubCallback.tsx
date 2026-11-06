import { useEffect, useRef, useState } from "react";
import { useSession } from "@/hooks/use-session";
import { captureGitHubCallback, githubRequest } from "@/lib/github-client";
import { Btn } from "./ui";

export function GitHubCallback() {
  const session = useSession(),
    token = session.session?.access_token;
  const current = useRef(token);
  current.current = token;
  const captured = useRef<{ value: ReturnType<typeof captureGitHubCallback> } | null>(null);
  const [payload, setPayload] = useState<ReturnType<typeof captureGitHubCallback>>(null);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    captured.current ??= { value: captureGitHubCallback(window.location.href) };
    window.history.replaceState(window.history.state, "", window.location.pathname);
    setPayload(captured.current.value);
    setLoaded(true);
  }, []);
  useEffect(() => {
    setBusy(false);
    setDone(false);
    setError("");
  }, [token]);
  async function finish() {
    if (!token || !payload || busy) return;
    setBusy(true);
    setError("");
    try {
      await githubRequest("finish", token, payload);
      if (current.current === token) {
        setDone(true);
        setPayload(null);
      }
    } catch (e) {
      if (current.current === token)
        setError(e instanceof Error ? e.message : "Prepojenie zlyhalo.");
    } finally {
      if (current.current === token) setBusy(false);
    }
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4 text-foreground">
      <section
        className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-6"
        aria-labelledby="github-title"
      >
        <h1 id="github-title" className="text-lg font-semibold">
          {done ? "GitHub je pripojený" : "Dokonči prepojenie GitHub"}
        </h1>
        {done ? (
          <p role="status" className="text-sm text-muted-foreground">
            Účet je pripravený na prácu s verejnými repozitármi.
          </p>
        ) : !loaded || session.status === "loading" ? (
          <p role="status">Overujem prihlásenie…</p>
        ) : !payload ? (
          <p role="alert" className="text-sm text-muted-foreground">
            Súhlas bol zrušený alebo odkaz nie je platný. Začni nové prepojenie v editore.
          </p>
        ) : session.status === "signed-out" ? (
          <p className="text-sm text-muted-foreground">
            Najprv sa prihlás a potom začni nové prepojenie v editore.
          </p>
        ) : (
          <>
            <p className="break-words text-sm text-muted-foreground">
              Dokonči prepojenie pre {session.email ?? "aktuálny účet"}. Použi rovnaký účet, z
              ktorého si začal.
            </p>
            <Btn variant="primary" disabled={busy} onClick={() => void finish()}>
              {busy ? "Pripájam…" : "Dokončiť prepojenie"}
            </Btn>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
        <a href="/" className="block text-sm text-primary underline underline-offset-4">
          Späť do Forge
        </a>
      </section>
    </main>
  );
}
