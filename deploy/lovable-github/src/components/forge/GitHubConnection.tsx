import { useEffect, useRef, useState } from "react";
import { Github } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { githubRequest, type GitHubStatus } from "@/lib/github-client";
import { Btn } from "./ui";
import { GitHubExport } from "./GitHubExport";

export function GitHubConnection() {
  const session = useSession();
  const token = session.session?.access_token;
  const current = useRef(token);
  current.current = token;
  const [data, setData] = useState<{ token: string; value: GitHubStatus } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, reload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError("");
    setData(null);
    setBusy(false);
    if (session.status === "signed-in" && token) {
      githubRequest("status", token, undefined, controller.signal)
        .then((value) => {
          if (active && "connected" in value) setData({ token, value });
        })
        .catch(() => {
          if (active) setError("GitHub prepojenie momentálne nie je dostupné.");
        });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [session.status, token, revision]);

  async function change(disconnect: boolean) {
    if (!token || busy) return;
    if (
      disconnect &&
      !window.confirm("Odpojiť GitHub od tohto účtu? Repozitáre zostanú zachované.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await githubRequest(disconnect ? "disconnect" : "start", token, {});
      if (current.current !== token) return;
      if ("authorizationUrl" in result) window.location.assign(result.authorizationUrl);
      else reload((value) => value + 1);
    } catch (e) {
      if (current.current === token)
        setError(e instanceof Error ? e.message : "Prepojenie zlyhalo.");
    } finally {
      if (current.current === token) setBusy(false);
    }
  }
  if (session.status === "loading")
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Overujem účet…
      </p>
    );
  if (session.status === "signed-out")
    return (
      <a href="/auth" className="rounded-lg border border-border p-3 text-xs hover:bg-accent">
        Prihlás sa a pripoj GitHub
      </a>
    );
  const value = data && data.token === token ? data.value : null;
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Github className="h-4 w-4" aria-hidden="true" /> GitHub
      </div>
      {error ? (
        <>
          <p role="alert" className="text-xs text-muted-foreground">
            {error}
          </p>
          <Btn size="sm" onClick={() => reload((n) => n + 1)}>
            Skúsiť znova
          </Btn>
        </>
      ) : !value ? (
        <p role="status" className="text-xs text-muted-foreground">
          Overujem prepojenie…
        </p>
      ) : (
        <>
          <p className="break-words text-xs text-muted-foreground">
            {value.connected ? `Pripojené: ${value.username}` : "Ulož svoje projekty aj na GitHub."}
          </p>
          <p className="text-[11px] text-muted-foreground">Prístup iba k verejným repozitárom.</p>
          <Btn
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void change(value.connected)}
          >
            {busy ? "Pracujem…" : value.connected ? "Odpojiť GitHub" : "Pripojiť GitHub"}
          </Btn>
        </>
      )}
      <GitHubExport
        key={session.session?.user?.id ?? token}
        accountId={session.session?.user?.id ?? token ?? ""}
        token={token ?? ""}
        username={value?.connected ? value.username : null}
      />
    </div>
  );
}
