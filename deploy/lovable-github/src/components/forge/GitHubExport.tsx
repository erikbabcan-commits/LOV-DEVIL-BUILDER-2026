import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  listExportProjects,
  loadExportProject,
  prepareGitHubExport,
  reviewGitHubExport,
  updateGitHubExport,
  ExportRequestError,
  type ExportProject,
  type ExportReview,
  type ExportJob,
} from "@/lib/github-export";
import { Btn } from "./ui";

export function GitHubExport({
  token,
  accountId,
  username,
}: {
  token: string;
  accountId: string;
  username: string | null;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; title: string; revision: number }>>(
      [],
    ),
    [cursor, setCursor] = useState<string | null>(null);
  const [project, setProject] = useState<ExportProject | null>(null),
    [snapshot, setSnapshot] = useState(""),
    [repoName, setRepoName] = useState("");
  const [review, setReview] = useState<ExportReview | null>(null),
    [job, setJob] = useState<ExportJob | null>(null),
    [agreed, setAgreed] = useState(false);
  const [revision, reload] = useState(0);
  const storageKey = `forge:github-export:${accountId}`;
  const remember = useCallback(
    (id: string | null) => {
      try {
        if (id) sessionStorage.setItem(storageKey, id);
        else sessionStorage.removeItem(storageKey);
      } catch {
        /* Optional recovery cache. */
      }
    },
    [storageKey],
  );
  const current = useRef(token);
  current.current = token;
  const controller = useRef(new AbortController()),
    sequence = useRef(0),
    request = useRef<{ key: string; id: string } | null>(null);
  const signal = () => AbortSignal.any([controller.current.signal, AbortSignal.timeout(90_000)]);
  useEffect(() => {
    const next = new AbortController();
    controller.current = next;
    sequence.current++;
    setBusy(false);
    return () => {
      next.abort();
    };
  }, [token]);
  useEffect(() => {
    setOpen(false);
    setProjects([]);
    setProject(null);
    setReview(null);
    setJob(null);
    setError("");
    request.current = null;
  }, [accountId]);
  useEffect(() => {
    if (!open || job) return;
    let active = true;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(storageKey);
    } catch {
      /* Optional recovery cache. */
    }
    const pending =
      saved && /^[a-f0-9-]{36}$/i.test(saved)
        ? updateGitHubExport(
            token,
            "status",
            { requestId: saved },
            AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
          )
        : listExportProjects(
            token,
            "",
            AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
          );
    pending
      .then((data) => {
        if (active) {
          setBusy(false);
          if ("projects" in data) {
            setProjects(data.projects);
            setCursor(data.nextCursor);
          } else setJob(data);
        }
      })
      .catch((e) => {
        if (active) {
          if (e instanceof ExportRequestError && e.code === "export_not_found") remember(null);
          setError(e instanceof Error ? e.message : "Projekty sa nepodarilo načítať.");
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [open, token, job, revision, storageKey, remember]);
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      if (current.current === token) setError(e instanceof Error ? e.message : "Export zlyhal.");
    } finally {
      if (current.current === token) setBusy(false);
    }
  }
  async function select(projectId: string) {
    const run = ++sequence.current;
    setProject(null);
    setSnapshot("");
    await act(async () => {
      const data = await loadExportProject(token, projectId, signal());
      if (current.current !== token || sequence.current !== run) return;
      setProject(data);
      setSnapshot(data.workspace.snapshots.at(-1)?.id ?? "");
      setRepoName("forge-" + crypto.randomUUID().slice(0, 8));
    });
  }
  async function prepare() {
    if (!project || !snapshot || !repoName.trim()) return;
    await act(async () => {
      const selection = {
        projectId: project.id,
        snapshotId: snapshot,
        expectedRevision: project.revision,
      };
      const key = JSON.stringify({ selection, repoName: repoName.trim().toLowerCase() });
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const data = await prepareGitHubExport(
        token,
        { requestId: request.current.id, repoName: repoName.trim(), selection },
        signal(),
      );
      if (current.current !== token) return;
      remember(data.requestId);
      setReview(data);
      setJob(data);
      setAgreed(false);
    });
  }
  async function restoreReview() {
    if (!job || job.status !== "prepared") return;
    const saved = job;
    await act(async () => {
      const data = await reviewGitHubExport(token, saved.requestId, signal());
      if (current.current !== token) return;
      setReview(data);
      setJob(data);
      setAgreed(false);
    });
  }
  async function update(action: "confirm" | "status" | "cancel" | "reconcile") {
    if (!job || (action === "confirm" && !agreed)) return;
    const saved = job;
    await act(async () => {
      if (action === "confirm") setJob({ ...saved, status: "running", result: null });
      try {
        const data = await updateGitHubExport(
          token,
          action,
          action === "confirm"
            ? { requestId: saved.requestId, fingerprint: saved.fingerprint, publicConfirmed: true }
            : action === "cancel"
              ? { requestId: saved.requestId, fingerprint: saved.fingerprint }
              : { requestId: saved.requestId },
          signal(),
        );
        if (current.current === token) {
          setJob(data);
          if (data.status !== "prepared") setAgreed(false);
        }
      } catch (e) {
        if (
          current.current === token &&
          e instanceof ExportRequestError &&
          e.code === "export_already_started"
        )
          setJob({ ...saved, status: "running", result: null });
        throw e;
      }
    });
  }
  const terminal = job && ["succeeded", "failed", "cancelled", "expired"].includes(job.status);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Btn size="sm" hidden={!username}>
          Exportovať verziu
        </Btn>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogTitle>Export na GitHub</DialogTitle>
        <DialogDescription>
          Vyber uloženú verziu. Vytvoríš nový verejný repozitár so svojimi zdrojovými súbormi.
        </DialogDescription>
        {!job ? (
          <div className="space-y-4">
            <label className="block text-sm">
              Uložený projekt
              <select
                aria-label="Uložený projekt"
                disabled={busy}
                value={project?.id ?? ""}
                onChange={(e) => void select(e.target.value)}
                className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2"
              >
                <option value="">Vyber projekt</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            {!projects.length && !busy && (
              <p className="text-sm text-muted-foreground">
                Zatiaľ nemáš uložené projekty. Najprv ulož projekt na server.
              </p>
            )}
            {cursor && (
              <Btn
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const data = await listExportProjects(token, cursor, signal());
                    if (current.current === token) {
                      setProjects((old) => [
                        ...old,
                        ...data.projects.filter((p) => !old.some((item) => item.id === p.id)),
                      ]);
                      setCursor(data.nextCursor);
                    }
                  })
                }
              >
                Ďalšie projekty
              </Btn>
            )}
            {project && (
              <>
                <label className="block text-sm">
                  Verzia
                  <select
                    aria-label="Verzia"
                    value={snapshot}
                    onChange={(e) => setSnapshot(e.target.value)}
                    className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-2"
                  >
                    {project.workspace.snapshots.map((s) => (
                      <option key={s.id} value={s.id}>
                        Verzia {s.v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Názov nového repozitára
                  <input
                    aria-label="Názov nového repozitára"
                    maxLength={100}
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-3"
                  />
                </label>
                <Btn
                  variant="primary"
                  disabled={busy || !snapshot || !repoName.trim()}
                  onClick={() => void prepare()}
                >
                  {busy ? "Pripravujem…" : "Skontrolovať export"}
                </Btn>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="break-words text-sm font-medium">
              {job.username}/{job.repoName} · Verejné
            </p>
            {review && (
              <p className="break-words text-sm text-muted-foreground">
                {review.title} · Verzia {review.version}
              </p>
            )}
            {review && (
              <ul
                aria-label="Exportované súbory"
                className="max-h-36 overflow-y-auto rounded-lg border border-border p-3 text-xs text-muted-foreground"
              >
                {review.files.map((f) => (
                  <li key={f.path} className="flex gap-3">
                    <span className="min-w-0 flex-1 break-all">{f.path}</span>
                    <span>{f.bytes} B</span>
                  </li>
                ))}
              </ul>
            )}
            {job.status === "prepared" && review && (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-1"
                  />
                  Rozumiem, že repozitár a všetky exportované súbory budú verejné.
                </label>
                <Btn
                  variant="primary"
                  disabled={!agreed || busy}
                  onClick={() => void update("confirm")}
                >
                  Vytvoriť verejný repozitár
                </Btn>
              </>
            )}
            {job.status === "prepared" && !review && (
              <>
                <p className="text-sm text-muted-foreground">
                  Príprava ešte nebola potvrdená. Obnov kontrolu súborov a znova potvrď ich
                  zverejnenie.
                </p>
                <Btn size="sm" disabled={busy} onClick={() => void restoreReview()}>
                  Obnoviť kontrolu súborov
                </Btn>
              </>
            )}
            {job.status === "prepared" && (
              <Btn size="sm" disabled={busy} onClick={() => void update("cancel")}>
                Zrušiť prípravu
              </Btn>
            )}
            {job.status === "running" && (
              <>
                <p role="status" className="text-sm text-muted-foreground">
                  Export prebieha alebo čaká na overenie výsledku. Nespúšťaj nový pokus.
                </p>
                <Btn size="sm" disabled={busy} onClick={() => void update("status")}>
                  Overiť stav exportu
                </Btn>
              </>
            )}
            {job.status === "succeeded" && job.result?.ok && (
              <div role="status" className="space-y-2 text-sm">
                <p>Export je overený. Súbory: {job.result.filesUploaded}.</p>
                <a
                  className="text-primary underline"
                  href={job.result.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Otvoriť repozitár
                </a>
                <p className="break-all text-xs text-muted-foreground">
                  Commit: {job.result.commitSha}
                </p>
              </div>
            )}
            {job.status === "failed" && (
              <div className="space-y-2 text-sm">
                <p role="alert" className="text-muted-foreground">
                  Export sa nedokončil. Repozitár už mohol vzniknúť; pred novým pokusom over jeho
                  stav na GitHube.
                </p>
                {job.result && !job.result.ok && job.result.repository && (
                  <a
                    className="text-primary underline"
                    href={job.result.repository.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Skontrolovať vytvorený repozitár
                  </a>
                )}
              </div>
            )}
            {(job.status === "running" || job.status === "failed") && (
              <div className="space-y-2">
                <Btn size="sm" disabled={busy} onClick={() => void update("reconcile")}>
                  Overiť výsledok na GitHube
                </Btn>
                <p className="text-xs text-muted-foreground">
                  Skontrolujeme už vytvorený repozitár. Nový export sa nespustí.
                </p>
              </div>
            )}
            {(job.status === "cancelled" || job.status === "expired") && (
              <p role="status" className="text-sm text-muted-foreground">
                {job.status === "cancelled" ? "Príprava je zrušená." : "Príprava vypršala."}{" "}
                Repozitár sa nevytvoril. Jeho názov môžeš použiť pri novom exporte.
              </p>
            )}
            {terminal && (
              <Btn
                size="sm"
                disabled={busy}
                onClick={() => {
                  remember(null);
                  setJob(null);
                  setReview(null);
                  setAgreed(false);
                  request.current = null;
                  setRepoName("forge-" + crypto.randomUUID().slice(0, 8));
                }}
              >
                Nový export
              </Btn>
            )}
            <p className="text-xs text-muted-foreground">
              Zatvorenie okna nezastaví potvrdený export. Stav nájdeš po jeho opätovnom otvorení.
            </p>
          </div>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            Pracujem…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
        {error && !job && (
          <Btn size="sm" disabled={busy} onClick={() => reload((n) => n + 1)}>
            Skúsiť načítať znova
          </Btn>
        )}
      </DialogContent>
    </Dialog>
  );
}
