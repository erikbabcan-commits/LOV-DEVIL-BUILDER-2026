import { useEffect, useRef, useState } from "react";
import { Globe, RefreshCw } from "lucide-react";
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
const rejectedInput: Record<string, number> = {
  publish_project_conflict: 409,
  publish_project_not_found: 404,
  publish_project_invalid: 409,
  publish_snapshot_sources_required: 409,
  publish_sources_unsupported: 400,
  publish_invalid_request: 400,
  publish_input_limit: 413,
};
const unavailableMessages = {
  storage_unavailable:
    "Publikačné úložisko teraz nie je pripravené alebo nemá dostatok voľného miesta.",
  sandbox_unavailable: "Izolovaný build teraz nie je pripravený.",
  disabled: "Publikovanie ešte nie je nakonfigurované. Tvoj projekt zostáva uložený.",
};
class PublishCallError extends Error {
  constructor(
    readonly status: number,
    readonly noJobCreated: boolean,
    message: string,
  ) {
    super(message);
  }
}
function sameSelection(left: PublishSelection | null, right: PublishSelection) {
  return (
    left?.requestId === right.requestId &&
    left.projectId === right.projectId &&
    left.expectedRevision === right.expectedRevision &&
    left.snapshotId === right.snapshotId &&
    left.publicConsent === right.publicConsent
  );
}
type PublishAvailability =
  | { status: "checking" | "error" }
  | { status: "checked"; value: ReturnType<typeof PublishReady.parse> };

function PublishDialog() {
  const { state, controller } = useForge(),
    [availability, setAvailability] = useState<PublishAvailability>({ status: "checking" }),
    [availabilityCheck, setAvailabilityCheck] = useState(0),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [job, setJob] = useState<PublishedJob | null>(null),
    [savedPublication, setSavedPublication] = useState<{
      key: string;
      path: string;
      url: string;
      controller: typeof controller;
    } | null>(null),
    [pendingSelection, setPendingSelection] = useState<PublishSelection | null>(null);
  const lifetime = useRef(new AbortController()),
    running = useRef(false),
    workspace = state.workspace,
    jobScope = useRef<{
      workspace: typeof workspace;
      revision: number;
      previousSources: boolean;
      controller: typeof controller;
    } | null>(null),
    owner = controller.owner,
    key = "forge-publish:v1:" + encodeURIComponent(owner) + ":" + encodeURIComponent(state.id);
  const activeController = useRef(controller);
  activeController.current = controller;
  const ready = availability.status === "checked" ? availability.value : null;
  useEffect(() => {
    setJob(null);
    setError("");
    setConsent(false);
    setBusy(false);
    running.current = false;
    setPendingSelection(readPendingPublish(key));
    const abort = new AbortController();
    lifetime.current = abort;
    return () => abort.abort();
  }, [owner, controller, key]);
  useEffect(() => {
    setAvailability({ status: "checking" });
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    void honoFetch("publish", { signal, expectedUserId: owner })
      .then(async (response) => {
        if (!response.ok) throw new Error("publish_readiness_unavailable");
        const value = PublishReady.parse(await response.json());
        signal.throwIfAborted();
        setAvailability({ status: "checked", value });
      })
      .catch(() => {
        if (!abort.signal.aborted) setAvailability({ status: "error" });
      });
    return () => abort.abort();
  }, [owner, controller, key, availabilityCheck]);
  const snapshot = workspace.snapshots.find((s) => s.id === workspace.liveId),
    supported = !!snapshot?.sourceFiles && workspace.files.some((f) => f.name === "src/main.tsx");
  const publicOrigin = ready?.publicOrigin;
  const savedPath =
    ready?.enabled &&
    publicOrigin &&
    snapshot &&
    state.revision &&
    !state.dirty &&
    !state.busy &&
    !state.editor &&
    !state.pending &&
    !busy &&
    !job &&
    !pendingSelection
      ? `publish/project/${state.id}/${state.revision}/${snapshot.id}`
      : null;
  useEffect(() => {
    setSavedPublication(null);
    if (!savedPath || !publicOrigin) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    void honoFetch(savedPath, { signal, expectedUserId: owner })
      .then(async (response) => {
        if (!response.ok) return;
        const result = PublishJob.nullable().parse(await response.json());
        if (
          !result ||
          signal.aborted ||
          result.state !== "published" ||
          `publish/project/${result.projectId}/${result.revision}/${result.snapshotId}` !==
            savedPath
        )
          return;
        const url = publicationUrl(result, publicOrigin);
        if (url) setSavedPublication({ key, path: savedPath, url, controller });
      })
      .catch(() => {
        /* A failed lookup cannot establish a publication or block a new one. */
      });
    return () => abort.abort();
  }, [savedPath, publicOrigin, owner, key, controller]);
  async function call(path: string, body?: unknown, signal = lifetime.current.signal) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const response = await honoFetch(path, {
      signal: requestSignal,
      expectedUserId: owner,
      ...(body === undefined ? {} : { method: "POST", body }),
    });
    if (requestSignal.aborted || !current()) throw new Error("aborted");
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const code =
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : "";
      const noJobCreated =
        path === "publish" && body !== undefined && rejectedInput[code] === response.status;
      throw new PublishCallError(
        response.status,
        noJobCreated,
        noJobCreated
          ? "Uložená verzia sa zmenila alebo jej zdroje nie sú platné. Obnov a skontroluj projekt; novú publikáciu potvrď samostatne."
          : response.status === 409
            ? "Serverová verzia sa zmenila alebo publikovanie vyžaduje opätovnú kontrolu."
            : response.status === 413
              ? "Kapacita publikácií je vyčerpaná."
              : "Publikovanie teraz nie je dostupné. Rozpracovaná požiadavka zostala zachovaná.",
      );
    }
    const value = PublishJob.parse(await response.json());
    if (requestSignal.aborted || !current()) throw new Error("aborted");
    return value;
  }
  function current() {
    return (
      !lifetime.current.signal.aborted &&
      activeController.current === controller &&
      controller.owner === owner &&
      controller.get().id === state.id
    );
  }
  async function observe(selection: PublishSelection, recovery: boolean) {
    const captured = controller.get(),
      signal = lifetime.current.signal;
    const receiptText = sessionStorage.getItem(key);
    const previousSources =
      captured.dirty ||
      captured.revision !== selection.expectedRevision ||
      captured.workspace.liveId !== selection.snapshotId;
    function requireSelection() {
      const live = controller.get();
      if (
        signal.aborted ||
        !current() ||
        live.id !== selection.projectId ||
        live.workspace !== captured.workspace ||
        live.revision !== captured.revision ||
        live.busy ||
        live.editor ||
        live.pending ||
        (!recovery &&
          (live.dirty ||
            live.revision !== selection.expectedRevision ||
            live.workspace.liveId !== selection.snapshotId))
      )
        throw new Error("Pracovná verzia sa zmenila. Publikácia patrí pôvodnej uloženej verzii.");
    }
    function clearMatchingReceipt() {
      if (
        receiptText !== null &&
        sessionStorage.getItem(key) === receiptText &&
        sameSelection(readPendingPublish(key), selection)
      )
        sessionStorage.removeItem(key);
      setPendingSelection(readPendingPublish(key));
    }
    async function submitOriginal() {
      requireSelection();
      try {
        return await call("publish", selection, signal);
      } catch (error) {
        requireSelection();
        if (error instanceof PublishCallError && error.noJobCreated) {
          clearMatchingReceipt();
          setConsent(false);
        }
        throw error;
      }
    }
    requireSelection();
    let value: PublishedJob,
      resumeBuilding = recovery;
    if (recovery) {
      try {
        value = await call("publish/" + selection.requestId, undefined, signal);
      } catch (error) {
        requireSelection();
        // A missing GET is uncertain: only this explicit action can retry the original POST/UUID.
        if (!(error instanceof PublishCallError) || error.status !== 404) throw error;
        resumeBuilding = false;
        value = await submitOriginal();
      }
    } else value = await submitOriginal();
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
      if (resumeBuilding && value.state === "building") {
        resumeBuilding = false;
        value = await submitOriginal();
        continue;
      }
      if (value.state === "published") publicationUrl(value, ready!.publicOrigin!);
      if (value.state !== "building") {
        clearMatchingReceipt();
        setConsent(false);
      }
      jobScope.current = {
        workspace: captured.workspace,
        revision: captured.revision,
        previousSources,
        controller,
      };
      setJob(value);
      if (value.state !== "building") break;
      if (Date.now() - start > 120000)
        throw new Error("Publikovanie pokračuje na serveri. Výsledok over tlačidlom Overiť stav.");
      await new Promise<void>((resolve, reject) => {
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
      value = await call("publish/" + selection.requestId, undefined, signal);
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
    setJob(null);
    const initial = controller.get(),
      selected = initial.workspace,
      operation = lifetime.current;
    try {
      // Never save over or replace an earlier uncertain request, even for another local revision.
      const pending = readPendingPublish(key);
      if (pending) {
        setPendingSelection(pending);
        await observe(pending, true);
        return;
      }
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
      const raced = readPendingPublish(key);
      if (raced) {
        setPendingSelection(raced);
        await observe(raced, true);
        return;
      }
      const selection: PublishSelection = {
        requestId: crypto.randomUUID(),
        projectId: saved.id,
        expectedRevision: saved.revision,
        snapshotId: saved.workspace.liveId!,
        publicConsent: true,
      };
      sessionStorage.setItem(key, JSON.stringify(selection));
      setPendingSelection(selection);
      await observe(selection, false);
    } catch (e) {
      if (current())
        setError(e instanceof Error ? e.message : "Publikovanie sa nepodarilo dokončiť.");
    } finally {
      if (lifetime.current === operation) {
        running.current = false;
        if (current()) setBusy(false);
      }
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
    setJob(null);
    const operation = lifetime.current;
    try {
      await observe(stored, true);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : "Stav sa nepodarilo načítať.");
    } finally {
      if (lifetime.current === operation) {
        running.current = false;
        if (current()) setBusy(false);
      }
    }
  }
  let url: string | null = null;
  const context = jobScope.current,
    previousSources = context?.previousSources ?? false;
  try {
    if (
      job &&
      ready?.publicOrigin &&
      context &&
      current() &&
      context.controller === controller &&
      state.id === job.projectId &&
      state.workspace === context.workspace &&
      state.revision === context.revision &&
      !state.editor &&
      !state.pending &&
      (previousSources ||
        (!state.dirty && state.revision === job.revision && workspace.liveId === job.snapshotId))
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
      <section
        aria-label="Dostupnosť publikovania"
        className="rounded-lg border border-border bg-muted/30 p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Dostupnosť hostingu</p>
          <Btn
            variant="ghost"
            size="sm"
            disabled={busy || availability.status === "checking"}
            onClick={() => setAvailabilityCheck((check) => check + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Obnoviť dostupnosť
          </Btn>
        </div>
        {availability.status === "error" ? (
          <p role="alert" className="mt-1 text-sm text-destructive">
            Dostupnosť publikačnej služby sa nepodarilo overiť.
          </p>
        ) : (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {!ready
              ? "Overujem publikačnú službu…"
              : ready.ready
                ? "Publikačná služba je pripravená."
                : unavailableMessages[
                    ready.reason ?? (ready.enabled ? "sandbox_unavailable" : "disabled")
                  ]}
          </p>
        )}
        {ready?.publicOrigin && (
          <p className="mt-1 break-all text-xs text-muted-foreground">
            Verejný hosting: {ready.publicOrigin}
          </p>
        )}
      </section>
      {!supported && (
        <p role="alert">
          Publikovanie potrebuje schválenú React verziu s úplnými zdrojmi. Najprv vytvor alebo otvor
          projekt.
        </p>
      )}
      {pendingSelection && (
        <p role="status" className="text-xs">
          Najprv overíme pôvodnú uloženú požiadavku. Nové zdroje sa tým ešte nepublikujú.
        </p>
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
      {savedPublication?.key === key &&
        savedPublication.path === savedPath &&
        savedPublication.controller === controller && (
          <div role="status" className="rounded-lg border border-border p-3 text-sm">
            <p>Táto uložená verzia je publikovaná.</p>
            <a
              className="break-all underline"
              href={savedPublication.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Otvoriť publikovanú aplikáciu
            </a>
          </div>
        )}
      {url && job && (
        <div role="status" className="rounded-lg border border-border p-3 text-sm">
          <p>
            {previousSources
              ? "Publikovaná bola predchádzajúca uložená verzia. Aktuálne zdroje tým nie sú publikované."
              : "Verzia bola publikovaná"}{" "}
            · serverová revízia {job.revision}.
          </p>
          <a className="break-all underline" href={url} target="_blank" rel="noopener noreferrer">
            {previousSources
              ? "Otvoriť publikáciu predchádzajúcej verzie"
              : "Otvoriť publikovanú aplikáciu"}
          </a>
          <p className="break-all text-xs">{url}</p>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {pendingSelection && (
          <Btn disabled={busy || !ready?.enabled} onClick={() => void recover()}>
            Overiť stav
          </Btn>
        )}
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
