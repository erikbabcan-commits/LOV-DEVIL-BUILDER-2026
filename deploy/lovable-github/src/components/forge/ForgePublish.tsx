import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { useForge } from "@/lib/forge-context";
import { honoFetch } from "@/lib/hono-client";
import {
  PublishReady,
  PublishJob,
  publicationUrl,
  readPendingPublish,
  type PublishedJob,
  type PublishSelection,
} from "@/lib/forge-publish";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Btn } from "./ui";
function PublishDialog() {
  const { state, controller } = useForge(),
    [ready, setReady] = useState<ReturnType<typeof PublishReady.parse> | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [job, setJob] = useState<PublishedJob | null>(null);
  const lifetime = useRef(new AbortController()),
    running = useRef(false),
    workspace = state.workspace,
    jobWorkspace = useRef<typeof workspace | null>(null),
    owner = controller.owner,
    key = "forge-publish:v1:" + encodeURIComponent(owner) + ":" + encodeURIComponent(state.id);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    void honoFetch("publish", { signal: abort.signal, expectedUserId: owner })
      .then(async (r) => {
        if (!r.ok) throw new Error("Prepojenie publikačnej služby nie je dostupné.");
        const value = PublishReady.parse(await r.json());
        if (!abort.signal.aborted) setReady(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Publikovanie sa nepodarilo overiť.");
      });
    return () => abort.abort();
  }, [owner]);
  const snapshot = workspace.snapshots.find((s) => s.id === workspace.liveId),
    supported = !!snapshot?.sourceFiles && workspace.files.some((f) => f.name === "src/main.tsx");
  async function call(path: string, body?: unknown) {
    const response = await honoFetch(path, {
      signal: AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15000)]),
      expectedUserId: owner,
      ...(body === undefined ? {} : { method: "POST", body }),
    });
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "Serverová verzia sa zmenila alebo publikovanie vyžaduje opätovnú kontrolu."
          : response.status === 413
            ? "Kapacita publikácií je vyčerpaná."
            : "Publikovanie teraz nie je dostupné. Rozpracovaný projekt zostal zachovaný.",
      );
    return PublishJob.parse(await response.json());
  }
  function current() {
    return (
      !lifetime.current.signal.aborted &&
      controller.owner === owner &&
      controller.get().id === state.id
    );
  }
  function selectionCurrent(selection: PublishSelection, captured: typeof workspace) {
    const live = controller.get();
    return (
      current() &&
      live.id === selection.projectId &&
      live.revision === selection.expectedRevision &&
      live.workspace === captured &&
      live.workspace.liveId === selection.snapshotId &&
      !live.dirty &&
      !live.editor &&
      !live.pending
    );
  }
  async function observe(selection: PublishSelection, create: boolean, retryBuilding = false) {
    const captured = controller.get().workspace;
    function requireSelection() {
      if (!selectionCurrent(selection, captured))
        throw new Error("Pracovná verzia sa zmenila. Publikácia patrí pôvodnej uloženej verzii.");
    }
    requireSelection();
    let value = await call(
      create ? "publish" : "publish/" + selection.requestId,
      create ? selection : undefined,
    );
    const start = Date.now();
    while (current()) {
      requireSelection();
      if (
        value.requestId !== selection.requestId ||
        value.projectId !== selection.projectId ||
        value.snapshotId !== selection.snapshotId ||
        value.revision !== selection.expectedRevision
      )
        throw new Error("Výsledok patrí inej verzii projektu.");
      if (retryBuilding && value.state === "building") {
        // A confirmed existing job may need to reclaim an expired server build lease.
        // The stored selection and UUID remain unchanged; never create a replacement job here.
        retryBuilding = false;
        value = await call("publish", selection);
        continue;
      }
      if (value.state === "published") publicationUrl(value, ready!.publicOrigin!);
      // A verified terminal failure is safe to replace. Keep uncertain/building attempts recoverable.
      if (value.state === "failed" && readPendingPublish(key)?.requestId === selection.requestId)
        sessionStorage.removeItem(key);
      jobWorkspace.current = captured;
      setJob(value);
      if (value.state !== "building") break;
      if (Date.now() - start > 120000)
        throw new Error("Publikovanie pokračuje na serveri. Výsledok over tlačidlom Overiť stav.");
      await new Promise<void>((resolve, reject) => {
        const signal = lifetime.current.signal;
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 10000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      value = await call("publish/" + selection.requestId);
    }
  }
  async function publish() {
    if (
      running.current ||
      !consent ||
      !ready?.ready ||
      !supported ||
      state.busy ||
      state.editor ||
      state.pending
    )
      return;
    running.current = true;
    setBusy(true);
    setError("");
    const initial = controller.get(),
      selected = initial.workspace;
    try {
      const needsSave = initial.dirty || !initial.revision;
      if (needsSave) await controller.save();
      if (!current()) return;
      const saved = controller.get();
      if (
        saved.id !== initial.id ||
        saved.workspace !== selected ||
        saved.dirty ||
        saved.busy ||
        (needsSave && saved.error) ||
        !saved.revision
      )
        throw new Error("Najprv úspešne ulož schválené zdroje na server a skontroluj verziu.");
      const stored = readPendingPublish(key),
        selection: PublishSelection =
          stored &&
          stored.projectId === saved.id &&
          stored.expectedRevision === saved.revision &&
          stored.snapshotId === saved.workspace.liveId &&
          job?.state !== "failed"
            ? stored
            : {
                requestId: crypto.randomUUID(),
                projectId: saved.id,
                expectedRevision: saved.revision,
                snapshotId: saved.workspace.liveId!,
                publicConsent: true,
              };
      sessionStorage.setItem(key, JSON.stringify(selection));
      await observe(selection, true);
    } catch (e) {
      if (current())
        setError(e instanceof Error ? e.message : "Publikovanie sa nepodarilo dokončiť.");
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  }
  async function recover() {
    if (running.current || !ready?.enabled) return;
    const stored = readPendingPublish(key);
    if (!stored) {
      setError("V tomto prehliadači nie je uložená čakajúca publikácia.");
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await observe(stored, false, true);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "Stav sa nepodarilo načítať.");
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  }
  let url: string | null = null;
  try {
    if (
      job &&
      ready?.publicOrigin &&
      jobWorkspace.current &&
      selectionCurrent(
        {
          requestId: job.requestId,
          projectId: job.projectId,
          expectedRevision: job.revision,
          snapshotId: job.snapshotId,
          publicConsent: true,
        },
        jobWorkspace.current,
      )
    )
      url = publicationUrl(job, ready.publicOrigin);
  } catch {
    /* Invalid destinations never become links. */
  }
  return (
    <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] overflow-y-auto rounded-xl p-5">
      <DialogTitle>Publikovať aplikáciu</DialogTitle>
      <DialogDescription>
        Zverejní sa obsah aplikácie vrátane klientského kódu z uloženej verzie. Účet a konverzácia
        sa nezverejňujú.
      </DialogDescription>
      <p className="break-all text-sm">
        <b>{workspace.title}</b> · verzia v{snapshot?.v ?? "—"} ·{" "}
        {state.revision && !state.dirty
          ? "serverová revízia " + state.revision
          : "pred publikovaním sa uloží na server"}
      </p>
      <p className="text-xs text-muted-foreground">
        Statický React náhľad má vlastnú verejnú adresu. Externé API, formuláre, prihlásenie a
        databázy generovanej aplikácie sa týmto krokom nenasadzujú. Po spustení publikovanie
        pokračuje aj po zavretí okna.
      </p>
      {!ready && !error && <p role="status">Overujem publikačnú službu…</p>}
      {ready && !ready.ready && (
        <p role="status">
          {ready.reason === "storage_unavailable"
            ? "Publikačné úložisko teraz nie je pripravené alebo nemá dostatok voľného miesta."
            : ready.enabled
              ? "Izolovaný build teraz nie je pripravený. Skús to neskôr."
              : "Publikovanie ešte nie je nakonfigurované. Tvoj projekt zostáva uložený."}
        </p>
      )}
      {!supported && (
        <p role="alert">
          Publikovanie potrebuje schválenú React verziu s úplnými zdrojmi. Najprv vytvor alebo otvor
          projekt.
        </p>
      )}
      {ready?.publicOrigin && (
        <p className="break-all text-xs">Verejný hosting: {ready.publicOrigin}</p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => setConsent(e.target.checked)}
        />
        Súhlasím so zverejnením tejto verzie aplikácie na verejnej URL.
      </label>
      {busy && (
        <p role="status">
          {job?.state === "building"
            ? "Kompilujem a ukladám verejnú verziu…"
            : "Ukladám a pripravujem publikáciu…"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {job?.state === "failed" && (
        <div role="alert" className="text-sm text-destructive">
          Publikovanie zlyhalo.{" "}
          {job.errors.map((e, i) => (
            <pre className="whitespace-pre-wrap break-words" key={i}>
              {e.file}: {e.message}
            </pre>
          ))}
        </div>
      )}
      {url && job && (
        <div role="status" className="rounded-lg border border-border p-3 text-sm">
          <p>Verzia bola publikovaná · serverová revízia {job.revision}.</p>
          <a className="break-all underline" href={url} target="_blank" rel="noopener noreferrer">
            Otvoriť publikovanú aplikáciu
          </a>
          <p className="break-all text-xs">{url}</p>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Btn disabled={busy || !ready?.enabled} onClick={() => void recover()}>
          Overiť stav
        </Btn>
        <Btn
          variant="primary"
          disabled={
            busy ||
            state.busy ||
            !!state.editor ||
            !!state.pending ||
            !ready?.ready ||
            !consent ||
            !supported
          }
          onClick={() => void publish()}
        >
          Publikovať verejne
        </Btn>
      </div>
    </DialogContent>
  );
}
export function ForgePublish() {
  const { state, authenticated } = useForge(),
    [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Btn
          size="sm"
          variant="primary"
          disabled={
            !authenticated || !state.ready || state.busy || !!state.editor || !!state.pending
          }
          aria-label="Publikovať"
        >
          <Globe className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Publikovať</span>
        </Btn>
      </DialogTrigger>
      {open && <PublishDialog />}
    </Dialog>
  );
}
