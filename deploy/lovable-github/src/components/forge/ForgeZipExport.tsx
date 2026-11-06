import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useForge } from "@/lib/forge-context";
import { Files } from "@/lib/forge-workspace";
import { createProjectZip, downloadProjectZip, inspectProjectSources } from "@/lib/forge-zip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Btn } from "./ui";

function ExportDialog({ close }: { close: () => void }) {
  const { state, controller } = useForge();
  const [selection, setSelection] = useState("current"),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [result, setResult] = useState("");
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
  const snapshot = state.workspace.snapshots.find((s) => s.id === selection);
  const selected = useMemo(() => {
    if (selection === "current") return { files: state.workspace.files, error: "" };
    try {
      return { files: Files.parse(JSON.parse(snapshot?.sourceFiles ?? "null")), error: "" };
    } catch {
      return { files: [], error: "Táto verzia nemá dostupné zdrojové súbory." };
    }
  }, [selection, snapshot?.sourceFiles, state.workspace.files]);
  const inspection = useMemo(() => inspectProjectSources(selected.files), [selected.files]);
  const errors = selected.error ? [selected.error] : inspection.errors;
  const version =
    snapshot?.v ?? state.workspace.snapshots.find((s) => s.id === state.workspace.liveId)?.v;
  async function download() {
    const attempt = ++run.current,
      workspace = state.workspace;
    setBusy(true);
    setError("");
    setResult("");
    try {
      const archive = await createProjectZip(selected.files, workspace.title, version);
      if (attempt !== run.current) return;
      if (controller.get().workspace !== workspace) {
        setError("Projekt sa zmenil. Skontroluj verziu a spusti export znova.");
        return;
      }
      downloadProjectZip(archive);
      setResult("Stiahnutie bolo spustené: " + archive.filename);
    } catch {
      if (attempt === run.current) setError("ZIP sa nepodarilo vytvoriť. Skús export znova.");
    } finally {
      if (attempt === run.current) setBusy(false);
    }
  }
  return (
    <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] overflow-y-auto rounded-xl p-5">
      <DialogTitle>Exportovať projekt</DialogTitle>
      <DialogDescription>
        Stiahni zdrojové súbory vybranej verzie. Konverzácia ani prihlásenie nie sú súčasťou ZIP.
      </DialogDescription>
      <label className="text-sm">
        Verzia na export
        <select
          aria-label="Verzia na export"
          className="mt-2 w-full rounded-lg border border-border bg-card p-2"
          disabled={busy}
          value={selection}
          onChange={(e) => {
            setSelection(e.target.value);
            setError("");
            setResult("");
          }}
        >
          <option value="current">Aktuálne súbory{state.dirty ? " · lokálne zmeny" : ""}</option>
          {[...state.workspace.snapshots].reverse().map((s) => (
            <option key={s.id} value={s.id} disabled={!s.sourceFiles}>
              v{s.v} · {s.prompt.slice(0, 60)}
              {!s.sourceFiles ? " · bez zdrojov" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        {selected.files.length} súborov ·{" "}
        {new Intl.NumberFormat("sk-SK").format(inspection.totalBytes)} B
      </p>
      {state.pending && (
        <p className="text-xs text-muted-foreground">Čakajúci AI návrh sa do ZIP nezahrnie.</p>
      )}
      <ul
        aria-label="Súbory archívu"
        className="max-h-40 overflow-auto rounded-lg border border-border bg-card p-3 text-xs"
      >
        {selected.files.map((file) => (
          <li key={file.name} className="break-all py-0.5">
            {file.name}
          </li>
        ))}
      </ul>
      {!!errors.length && (
        <div role="alert" className="text-sm text-destructive">
          {errors.join(" ")}
        </div>
      )}
      {!errors.length &&
        inspection.warnings.map((warning) => (
          <p key={warning} className="text-xs text-muted-foreground">
            {warning}
          </p>
        ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="break-all text-sm text-success">
          {result}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Btn onClick={close}>Zavrieť</Btn>
        <Btn
          variant="primary"
          disabled={busy || state.busy || !!errors.length}
          onClick={() => void download()}
        >
          <Download className="h-4 w-4" aria-hidden /> {busy ? "Pripravujem ZIP…" : "Stiahnuť ZIP"}
        </Btn>
      </div>
    </DialogContent>
  );
}
export function ForgeZipExport({ className }: { className?: string }) {
  const { state, authenticated } = useForge(),
    [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Btn
          size="sm"
          variant="ghost"
          className={className}
          disabled={
            !authenticated ||
            !state.ready ||
            state.busy ||
            !!state.editor ||
            !state.workspace.files.length
          }
          aria-label="Export ZIP"
        >
          <Download className="h-3.5 w-3.5" aria-hidden /> Export ZIP
        </Btn>
      </DialogTrigger>
      {open && <ExportDialog close={() => setOpen(false)} />}
    </Dialog>
  );
}
