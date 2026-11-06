import { useMemo, useState } from "react";
import { useForge } from "@/lib/forge-context";
import { Btn, StateBlock, Tabs } from "./ui";
import { applyFileOperations } from "@/lib/forge-changes";
import { ForgeFiles } from "./ForgeFiles";
import { changedFiles, lineDiff } from "@/lib/forge-diff";
export function ForgeCode() {
  return <ForgeFiles />;
}
export function ForgePreview() {
  const { state, controller } = useForge();
  return state.preview ? (
    <iframe
      title="Náhľad projektu"
      sandbox="allow-scripts allow-forms"
      srcDoc={state.preview}
      className="h-full min-h-[360px] w-full rounded-xl border border-border bg-white"
    />
  ) : (
    <StateBlock
      state={state.busy ? "loading" : "empty"}
      title={
        state.busy
          ? "Pripravujem výsledok…"
          : state.workspace.files.length
            ? "Projekt je pripravený na náhľad."
            : "Tu uvidíš svoju aplikáciu."
      }
      text="Náhľad sa zostaví zo schválených súborov."
      action={
        state.workspace.files.length ? (
          <Btn
            disabled={state.busy || !!state.pending || !!state.editor}
            onClick={() => void controller.compile()}
          >
            Spustiť náhľad
          </Btn>
        ) : undefined
      }
    />
  );
}
export function ForgeHistory() {
  const { state, controller } = useForge();
  return (
    <div className="space-y-2">
      {!state.workspace.snapshots.length && (
        <StateBlock
          state="empty"
          title="Zatiaľ žiadna verzia"
          text="Prvá schválená zmena vytvorí verziu projektu."
        />
      )}
      {[...state.workspace.snapshots].reverse().map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">
            v{s.v} · {s.prompt}
          </span>
          <Btn
            size="sm"
            disabled={state.busy || !!state.pending || s.id === state.workspace.liveId}
            onClick={() => controller.restore(s.id)}
          >
            {s.id === state.workspace.liveId ? "Aktuálna" : "Obnoviť"}
          </Btn>
        </div>
      ))}
    </div>
  );
}
export function ForgeReview({ onApplied }: { onApplied?: () => void } = {}) {
  const { state, controller } = useForge(),
    [path, setPath] = useState(""),
    [visible, setVisible] = useState(400);
  const changes = useMemo(() => {
    const after = state.pending
      ? applyFileOperations(state.workspace.files, state.pending.files, state.pending.strict)
      : null;
    return after ? changedFiles(state.workspace.files, after) : [];
  }, [state.workspace.files, state.pending]);
  const selected = changes.find((f) => f.path === path) ?? changes[0],
    diff = useMemo(() => (selected ? lineDiff(selected.before, selected.after) : null), [selected]);
  if (!state.pending)
    return (
      <StateBlock
        state="empty"
        title="Žiadny čakajúci návrh"
        text="AI zmeny sa tu zobrazia pred tvojím schválením."
      />
    );
  return (
    <section
      aria-label="Kontrola AI návrhu"
      className="rounded-xl border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold">Navrhované zmeny</h3>
      <p className="my-2 text-xs text-secondary-foreground">
        {state.pending.summary} Súbory sa použijú až po schválení.
      </p>
      <p className="mb-3 text-xs">Zmenené súbory: {changes.length}</p>
      <label className="text-xs">
        Súbor návrhu
        <select
          aria-label="Súbor návrhu"
          className="my-2 w-full rounded-lg border border-border bg-background p-2"
          value={selected?.path ?? ""}
          onChange={(e) => {
            setPath(e.target.value);
            setVisible(400);
          }}
        >
          {changes.map((f) => (
            <option key={f.path}>{f.path}</option>
          ))}
        </select>
      </label>
      {selected && diff && (
        <>
          <p className="text-xs">
            +{diff.lines.filter((l) => l.kind === "add").length} / −
            {diff.lines.filter((l) => l.kind === "delete").length} riadkov
            {diff.coarse ? " · zobrazený zmenený blok" : ""}
          </p>
          <pre
            tabIndex={0}
            aria-label={"Rozdiel " + selected.path}
            className="my-3 max-h-80 overflow-auto rounded-lg border border-border bg-background p-2 text-xs"
          >
            {diff.lines.slice(0, visible).map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === "delete"
                    ? "text-destructive"
                    : line.kind === "add"
                      ? "text-success"
                      : "text-muted-foreground"
                }
              >
                {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "} {line.text || " "}
              </div>
            ))}
          </pre>
          {diff.lines.length > visible && (
            <Btn size="sm" onClick={() => setVisible((n) => n + 400)}>
              Ďalšie riadky
            </Btn>
          )}
        </>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Btn variant="danger" onClick={() => controller.reject()}>
          Odmietnuť
        </Btn>
        <Btn
          variant="primary"
          disabled={state.busy}
          onClick={() => {
            controller.approve();
            if (!controller.get().pending) onApplied?.();
          }}
        >
          Použiť zmeny
        </Btn>
      </div>
    </section>
  );
}
export function ForgeCanvas() {
  const { state, controller } = useForge(),
    [choice, setChoice] = useState<{ tab: string; review: string | null }>({
      tab: "Náhľad",
      review: null,
    }),
    [device, setDevice] = useState("100%");
  const selected = state.pending && choice.review !== state.pending.runId ? "Zmeny" : choice.tab;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <Tabs
          tabs={["Náhľad", "Kód", "Konzola", "Zmeny", "História"]}
          value={selected}
          onChange={(tab) => setChoice({ tab, review: state.pending?.runId ?? null })}
          label="Plátno"
        />
        <select
          aria-label="Veľkosť náhľadu"
          value={device}
          onChange={(e) => setDevice(e.target.value)}
          className="rounded-lg border border-border bg-card p-1 text-xs"
        >
          <option value="100%">Desktop</option>
          <option value="768px">Tablet</option>
          <option value="390px">Mobil</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
        <div className="mx-auto h-full max-w-full" style={{ width: device }}>
          {selected === "Náhľad" ? (
            <ForgePreview />
          ) : selected === "Kód" ? (
            <ForgeCode />
          ) : selected === "Zmeny" ? (
            <ForgeReview
              onApplied={() => {
                setChoice({ tab: "Náhľad", review: null });
                void controller.compile();
              }}
            />
          ) : selected === "História" ? (
            <ForgeHistory />
          ) : (
            <div
              role="log"
              className="space-y-2 rounded-xl border border-border bg-card p-4 text-xs"
            >
              {state.logs.length
                ? state.logs.map((line, i) => <p key={i}>{line}</p>)
                : "Zatiaľ žiadny výstup kompilácie."}
            </div>
          )}
        </div>
      </div>
      <footer className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        Verzie: {state.workspace.snapshots.length} ·{" "}
        {state.dirty ? "Lokálne zmeny" : "Uložený stav"}
        {state.revision ? " · server r" + state.revision : ""}
      </footer>
    </section>
  );
}
