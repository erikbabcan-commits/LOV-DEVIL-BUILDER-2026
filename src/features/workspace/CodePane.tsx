import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore, type AppState } from "../../stores/useAppStore";
import { filesFor, type VfsFile } from "../../lib/vfs/filesFor";
import {
  persistenceScope,
  subscribePersistenceScope,
} from "../../services/persistence/db";
import {
  captureCodeEditBase,
  matchesCodeEditBase,
  readCodeDraft,
  writeCodeDraft,
  clearCodeDraft,
  type CodeEditBase,
  type CodeTab,
} from "../../services/editor/codeDrafts";
const SourceEditor = lazy(() => import("./SourceEditor"));
const noErrors: Array<{ file: string; message: string }> = [];
class SourceBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function CodePane() {
  const state = useStore(),
    epoch = useSyncExternalStore(
      subscribePersistenceScope,
      () => persistenceScope().epoch,
    );
  const databaseName = persistenceScope().databaseName;
  const scope = useMemo(() => ({ databaseName, epoch }), [databaseName, epoch]);
  const snapshot = state.edSnap();
  if (scope.databaseName === null || state.workspaceEpoch !== epoch)
    return (
      <div className="pane-empty" role="status">
        Načítavam súbory overeného účtu…
      </div>
    );
  if (!snapshot)
    return (
      <div className="pane-empty">
        Žiadne súbory — vygeneruj appku alebo otvor projekt.
      </div>
    );
  const base = captureCodeEditBase(state);
  if (!base) return null;
  return (
    <CodeSession
      key={JSON.stringify([
        scope.databaseName,
        epoch,
        state.projectId,
        snapshot.id,
        !!state.viewing,
      ])}
      state={state}
      scope={scope}
      initial={base}
      files={state.vfs[snapshot.id] ?? filesFor(snapshot)}
    />
  );
}
function CodeSession({
  state,
  scope,
  initial,
  files,
}: {
  state: AppState;
  scope: ReturnType<typeof persistenceScope>;
  initial: CodeEditBase;
  files: VfsFile[];
}) {
  const first = files.find((file) => file.name === state.edFile) ?? files[0];
  const [base, setBase] = useState(initial),
    [tabs, setTabs] = useState<CodeTab[]>(
      first
        ? [{ name: first.name, saved: first.content, draft: first.content }]
        : [],
    ),
    [active, setActive] = useState<string | null>(first?.name ?? null);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false),
    [simple, setSimple] = useState(false),
    [saving, setSaving] = useState(false);
  const mounted = useRef(false),
    savingRef = useRef(false),
    start = useRef(initial).current,
    prefix = useId();
  const readOnly = !!state.viewing,
    blocked =
      state.generating ||
      state.sandboxBuilding ||
      !!state.pendingReview ||
      state.edEditing;
  const matches = matchesCodeEditBase(state, base),
    dirty = tabs.filter((tab) => tab.draft !== tab.saved).length,
    tab = tabs.find((t) => t.name === active) ?? null;
  useEffect(() => {
    if (!ready || readOnly) return;
    const wanted = dirty > 0;
    if (
      persistenceScope().epoch === base.epoch &&
      useStore.getState().projectId === base.projectId &&
      useStore.getState().codeDraftDirty !== wanted
    )
      useStore.setState({ codeDraftDirty: wanted });
  }, [dirty, readOnly, ready, base.epoch, base.projectId]);
  useEffect(() => {
    mounted.current = true;
    let current = true;
    if (readOnly) {
      setReady(true);
      return () => {
        current = false;
        mounted.current = false;
      };
    }
    void readCodeDraft(scope, start)
      .then((record) => {
        if (!current || persistenceScope().epoch !== scope.epoch) return;
        if (record) {
          setTabs(record.tabs);
          const selected = record.tabs.some((t) => t.name === record.active)
            ? record.active
            : (record.tabs[0]?.name ?? null);
          setActive(selected);
          if (selected) useStore.getState().setEdFile(selected);
          setStale(record.stale);
        }
      })
      .catch(() => {
        if (current)
          setError(
            "Lokálny koncept sa nepodarilo obnoviť. Schválené zdroje zostali zachované.",
          );
      })
      .finally(() => {
        if (current) setReady(true);
      });
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [start, readOnly, scope]);
  const errors = useMemo(
    () =>
      tab && tab.draft === files.find((f) => f.name === tab.name)?.content
        ? state.sandboxErrors.filter(
            (e) => e.file === tab.name || e.message.includes(tab.name + ":"),
          )
        : noErrors,
    [files, state.sandboxErrors, tab],
  );
  function backup(next: CodeTab[], selected: string | null) {
    if (readOnly || !ready) return;
    void writeCodeDraft(scope, base, next, selected)
      .then(() => {
        if (mounted.current) setError("");
      })
      .catch(() => {
        if (mounted.current)
          setError(
            "Lokálny koncept sa nepodarilo zálohovať. Skontroluj veľkosť a možné kľúče; pred zatvorením si zachovaj kód.",
          );
      });
  }
  function open(file: VfsFile) {
    if (!ready || savingRef.current) return;
    const next = tabs.some((t) => t.name === file.name)
      ? tabs
      : [
          ...tabs,
          { name: file.name, saved: file.content, draft: file.content },
        ];
    setTabs(next);
    setActive(file.name);
    state.setEdFile(file.name);
    backup(next, file.name);
  }
  function edit(value: string) {
    if (
      !ready ||
      !tab ||
      readOnly ||
      blocked ||
      savingRef.current ||
      stale ||
      !matches
    )
      return;
    const next = tabs.map((t) =>
      t.name === tab.name ? { ...t, draft: value } : t,
    );
    setTabs(next);
    backup(next, tab.name);
  }
  function close(name: string) {
    if (savingRef.current) return;
    const closing = tabs.find((t) => t.name === name);
    if (
      closing &&
      closing.saved !== closing.draft &&
      !confirm("Zahodiť rozpracovaný koncept súboru " + name + "?")
    )
      return;
    const next = tabs.filter((t) => t.name !== name),
      selected = active === name ? (next.at(-1)?.name ?? null) : active;
    setTabs(next);
    setActive(selected);
    backup(next, selected);
  }
  async function reset() {
    if (savingRef.current) return;
    if (
      dirty &&
      !confirm("Zahodiť rozpracované koncepty a otvoriť aktuálne zdroje?")
    )
      return;
    savingRef.current = true;
    setSaving(true);
    try {
      await clearCodeDraft(scope, base);
      if (!mounted.current) return;
      const fresh = captureCodeEditBase(useStore.getState());
      if (
        !fresh ||
        fresh.projectId !== base.projectId ||
        fresh.snapshotId !== base.snapshotId
      )
        return;
      const current = useStore.getState();
      const snapshot = current.edSnap();
      const currentFiles = snapshot
        ? (current.vfs[snapshot.id] ?? filesFor(snapshot))
        : [];
      setBase(fresh);
      setTabs(
        currentFiles[0]
          ? [
              {
                name: currentFiles[0].name,
                draft: currentFiles[0].content,
                saved: currentFiles[0].content,
              },
            ]
          : [],
      );
      setActive(currentFiles[0]?.name ?? null);
      setStale(false);
      setError("");
    } catch {
      if (mounted.current)
        setError("Koncept sa nepodarilo zrušiť. Súbory sa nezmenili.");
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function saveAll() {
    if (
      savingRef.current ||
      !ready ||
      !dirty ||
      readOnly ||
      blocked ||
      stale ||
      !matches
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      // Persist the recovery copy before changing the live project. Bind every await to this session.
      await writeCodeDraft(scope, base, tabs, active);
      if (!mounted.current || !matchesCodeEditBase(useStore.getState(), base))
        return;
      const pending = useStore.getState().applyStagedFiles(
          tabs
            .filter((t) => t.draft !== t.saved)
            .map((t) => ({ path: t.name, content: t.draft, action: "modify" })),
          base,
        ),
        created = useStore.getState().liveId;
      const committed = await pending;
      if (committed) {
        await clearCodeDraft(scope, base);
        const now = useStore.getState();
        if (
          persistenceScope().epoch === base.epoch &&
          now.projectId === base.projectId &&
          now.liveId === created
        ) {
          const live = now.edSnap();
          if (live && now.vfs[live.id]?.some((f) => f.name === "src/main.tsx"))
            void now.runSandbox();
        }
      }
    } catch {
      if (mounted.current)
        setError(
          "Zmeny sa nepodarilo uložiť. Rozpracovaný koncept zostal zachovaný.",
        );
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const fallback = tab ? (
    <textarea
      className="cp-fallback"
      value={tab.draft}
      onChange={(e) => edit(e.target.value)}
      aria-label={"Úprava " + tab.name}
      readOnly={!ready || readOnly || blocked || saving || stale || !matches}
      spellCheck={false}
    />
  ) : null;
  return (
    <div
      className="code-pane"
      role="region"
      aria-label="Editor kódu"
      onKeyDownCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          void saveAll();
        }
      }}
    >
      <aside className="code-tree" aria-label="Súbory projektu">
        <div className="code-tree-head">
          <span>Súbory</span>
          <button
            id="codeSaveAll"
            className="cp-save"
            disabled={
              !ready ||
              !dirty ||
              readOnly ||
              blocked ||
              saving ||
              stale ||
              !matches
            }
            onClick={() => void saveAll()}
          >
            {saving ? "Ukladám…" : "Uložiť" + (dirty ? " (" + dirty + ")" : "")}
          </button>
        </div>
        <div className="code-tree-list">
          {files.map((file) => (
            <button
              key={file.name}
              className={"tree-item" + (file.name === active ? " active" : "")}
              disabled={!ready || saving}
              onClick={() => open(file)}
              title={file.name}
              aria-label={"Otvoriť " + file.name}
            >
              <span className="tree-name">{file.name}</span>
              {tabs.some(
                (t) => t.name === file.name && t.draft !== t.saved,
              ) && (
                <span className="dirty-dot" aria-label="Neuložený koncept" />
              )}
            </button>
          ))}
        </div>
      </aside>
      <div className="code-editor">
        {!ready && (
          <p role="status" className="cp-feedback">
            Načítavam lokálny koncept…
          </p>
        )}
        {error && (
          <p role="alert" className="cp-feedback">
            {error}
          </p>
        )}
        {(stale || !matches) && (
          <div role="alert" className="cp-feedback">
            Podklad sa zmenil. Koncept zostal na kontrolu/kopírovanie;
            neaplikuje sa na nové zdroje.
            <button onClick={() => void reset()}>
              Otvoriť aktuálne zdroje
            </button>
          </div>
        )}
        {readOnly && (
          <p className="cp-feedback">
            Historická verzia je iba na čítanie. Najprv ju obnov, ak ju chceš
            upraviť.
          </p>
        )}
        <div
          className="editor-tabs"
          role="tablist"
          aria-label="Otvorené súbory"
          onKeyDown={(event) => {
            if ((event.target as HTMLElement).getAttribute("role") !== "tab")
              return;
            const i = tabs.findIndex((t) => t.name === active);
            const next =
              event.key === "ArrowRight"
                ? (i + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (i - 1 + tabs.length) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : -1;
            if (next >= 0) {
              event.preventDefault();
              setActive(tabs[next].name);
              const buttons =
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[role=tab]",
                );
              buttons[next]?.focus();
            }
          }}
        >
          {tabs.map((item, i) => (
            <div
              key={item.name}
              className={"editor-tab" + (item.name === active ? " active" : "")}
            >
              <button
                role="tab"
                id={prefix + "-" + i}
                aria-selected={item.name === active}
                tabIndex={item.name === active ? 0 : -1}
                onClick={() => {
                  setActive(item.name);
                  backup(tabs, item.name);
                }}
              >
                {item.name}
                {item.draft !== item.saved && <span className="dirty-dot" />}
              </button>
              <button
                className="tab-close"
                aria-label={"Zavrieť " + item.name}
                disabled={saving}
                onClick={() => close(item.name)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {tab ? (
          <div className="editor-host">
            <div className="cp-tools">
              <span>
                {tab.name} ·{" "}
                {readOnly ? "história" : dirty ? "koncept" : "uložené zdroje"}
              </span>
              <button onClick={() => setSimple(!simple)}>
                {simple ? "Rozšírený editor" : "Jednoduchý editor"}
              </button>
            </div>
            {!!errors.length && (
              <div role="alert" className="cp-feedback">
                Chyby posledného náhľadu
                {errors.map((e, i) => (
                  <pre key={i}>{e.message}</pre>
                ))}
              </div>
            )}
            {state.tab === "code" &&
              (simple || stale || !matches ? (
                fallback
              ) : (
                <SourceBoundary key={tab.name} fallback={fallback}>
                  <Suspense
                    fallback={
                      <div className="cp-loading">
                        Načítavam editor…{" "}
                        <button onClick={() => setSimple(true)}>
                          Použiť jednoduchý editor
                        </button>
                      </div>
                    }
                  >
                    <SourceEditor
                      path={tab.name}
                      value={tab.draft}
                      onChange={edit}
                      errors={errors.length ? errors : noErrors}
                      readOnly={readOnly || blocked || saving || !ready}
                    />
                  </Suspense>
                </SourceBoundary>
              ))}
          </div>
        ) : (
          <div className="pane-empty">Vyber súbor vľavo.</div>
        )}
      </div>
    </div>
  );
}
