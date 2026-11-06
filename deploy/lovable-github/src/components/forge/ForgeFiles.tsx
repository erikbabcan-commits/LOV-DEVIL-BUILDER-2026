import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { useForge } from "@/lib/forge-context";
import type { ServerWorkspace } from "@/lib/forge-workspace";
import { Btn, StateBlock } from "./ui";
const SourceEditor = lazy(() => import("./ForgeSourceEditor"));
const noErrors: { file: string; message: string }[] = [];
class EditorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function FileTree({
  files,
  select,
  prefix = "",
}: {
  files: ServerWorkspace["files"];
  select: (path: string) => void;
  prefix?: string;
}) {
  const folders = [
    ...new Set(
      files
        .map((f) => f.name.slice(prefix.length).split("/"))
        .filter((p) => p.length > 1)
        .map((p) => p[0]!),
    ),
  ].sort();
  return (
    <ul className="space-y-1 text-xs">
      {folders.map((folder) => (
        <li key={folder}>
          <details open>
            <summary className="cursor-pointer py-1 text-muted-foreground">{folder}/</summary>
            <div className="ml-3 border-l border-border pl-2">
              <FileTree
                files={files.filter((f) => f.name.startsWith(prefix + folder + "/"))}
                prefix={prefix + folder + "/"}
                select={select}
              />
            </div>
          </details>
        </li>
      ))}
      {files
        .filter((f) => !f.name.slice(prefix.length).includes("/"))
        .map((f) => (
          <li key={f.name}>
            <button
              className="max-w-full break-all rounded px-2 py-1 text-left hover:bg-accent"
              onClick={() => select(f.name)}
              aria-label={"Otvoriť súbor " + f.name}
            >
              {f.name.slice(prefix.length)}
            </button>
          </li>
        ))}
    </ul>
  );
}
export function ForgeFiles() {
  const { state, controller, authenticated } = useForge();
  return (
    <FileWorkspace
      key={state.id}
      state={state}
      controller={controller}
      authenticated={authenticated}
    />
  );
}
function FileWorkspace({ state, controller, authenticated }: ReturnType<typeof useForge>) {
  const [path, setPath] = useState(""),
    [action, setAction] = useState(""),
    [name, setName] = useState(""),
    [folder, setFolder] = useState("src"),
    [uploadError, setUploadError] = useState("");
  const files = state.editor?.files ?? state.workspace.files;
  const file = files.find((f) => f.name === path) ?? files[0];
  const errors = file
    ? state.buildErrors.filter((e) => e.file === file.name || e.message.includes(file.name + ":"))
    : [];
  const matchesBuild =
    file?.content === state.workspace.files.find((f) => f.name === file?.name)?.content;
  const changed =
    !!state.editor && JSON.stringify(state.editor.files) !== JSON.stringify(state.workspace.files);
  function mutate(next: ServerWorkspace["files"], selected?: string) {
    if (controller.editFiles(next)) {
      if (selected !== undefined) setPath(selected);
      setAction("");
      setUploadError("");
    }
  }
  async function importFiles(input: File[]) {
    const draft = controller.get().editor;
    if (!draft) return;
    setUploadError("");
    try {
      if (input.length + draft.files.length > 40)
        throw new Error("Import prekračuje limit 40 súborov.");
      const imported = await Promise.all(
        input.map(async (item) => {
          if (item.size > 200_000) throw new Error("Súbor prekračuje limit 200 000 B.");
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(await item.arrayBuffer());
          } catch {
            throw new Error("Súbor sa nepodarilo prečítať ako UTF-8 zdrojový text.");
          }
          if (content.includes("\0"))
            throw new Error("Import podporuje iba UTF-8 zdrojové súbory.");
          return {
            name: (folder ? folder + "/" : "") + (item.webkitRelativePath || item.name),
            content,
          };
        }),
      );
      if (controller.get().editor !== draft)
        throw new Error("Súbory sa počas importu zmenili. Spusti import znova.");
      mutate([...draft.files, ...imported], imported[0]?.name);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Import sa nepodaril.");
    }
  }
  return (
    <section aria-label="Súbory a editor" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {files.length} súborov{state.editor ? " · rozpracované úpravy" : " · schválená verzia"}
        </span>
        {!state.editor ? (
          <Btn
            disabled={!authenticated || !state.ready || state.busy || !!state.pending}
            onClick={() => controller.beginEdit()}
          >
            Upraviť súbory
          </Btn>
        ) : (
          <>
            <Btn
              disabled={state.busy}
              onClick={() => {
                controller.discardEdit();
                setAction("");
              }}
            >
              Zrušiť úpravy
            </Btn>
            <Btn
              variant="primary"
              disabled={!changed || state.busy}
              onClick={() => {
                if (controller.applyEdit()) void controller.compile();
              }}
            >
              Použiť a spustiť náhľad
            </Btn>
          </>
        )}
      </div>
      {state.editor && (
        <p className="text-xs text-muted-foreground">
          Úpravy sa zálohujú v tomto prehliadači. Použitie vytvorí novú verziu; na server ju uložíš
          samostatne.
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      <details className="rounded-lg border border-border bg-card p-3">
        <summary className="cursor-pointer text-xs">Strom súborov · {files.length}</summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <FileTree files={files} select={setPath} />
        </div>
      </details>
      {state.editor && (
        <div className="flex flex-wrap items-center gap-2">
          <Btn
            size="sm"
            onClick={() => {
              setAction("add");
              setName("src/novy.ts");
            }}
          >
            Pridať súbor
          </Btn>
          <Btn
            size="sm"
            disabled={!file}
            onClick={() => {
              setAction("rename");
              setName(file?.name ?? "");
            }}
          >
            Premenovať súbor
          </Btn>
          <Btn size="sm" variant="danger" disabled={!file} onClick={() => setAction("delete")}>
            Odstrániť súbor
          </Btn>
        </div>
      )}
      {(action === "add" || action === "rename") && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutate(
              action === "add"
                ? [...files, { name, content: "" }]
                : files.map((f) => (f.name === file?.name ? { ...f, name } : f)),
              name,
            );
          }}
        >
          <label className="min-w-0 flex-1 text-xs">
            Cesta súboru
            <input
              aria-label="Cesta súboru"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-card p-2"
            />
          </label>
          <Btn type="submit">Potvrdiť cestu</Btn>
          <Btn type="button" onClick={() => setAction("")}>
            Zrušiť
          </Btn>
          {action === "rename" && (
            <p className="w-full text-xs text-muted-foreground">
              Po premenovaní uprav aj príslušné importy v kóde.
            </p>
          )}
        </form>
      )}
      {action === "delete" && (
        <div className="rounded-lg border border-border p-3 text-xs">
          <p className="break-all">
            Odstrániť {file?.name} z rozpracovaných súborov? Pôvodná verzia zostane v histórii.
          </p>
          <div className="mt-2 flex gap-2">
            <Btn
              variant="danger"
              onClick={() => mutate(files.filter((f) => f.name !== file?.name))}
            >
              Potvrdiť odstránenie
            </Btn>
            <Btn onClick={() => setAction("")}>Zrušiť</Btn>
          </div>
        </div>
      )}
      {state.editor && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void importFiles(Array.from(e.dataTransfer.files));
          }}
          className="rounded-lg border border-dashed border-border p-3 text-xs"
        >
          <label>
            Importovať do priečinka
            <input
              aria-label="Importovať do priečinka"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Prázdne = koreň projektu"
              className="mx-2 my-1 rounded border border-border bg-card p-2"
            />
          </label>
          <label className="mt-2 block">
            Pridať UTF-8 súbory alebo ich sem pretiahni
            <input
              type="file"
              multiple
              aria-label="Importovať zdrojové súbory"
              className="mt-2 block max-w-full"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []);
                e.target.value = "";
                void importFiles(selected);
              }}
            />
          </label>
          {uploadError && (
            <p role="alert" className="mt-2 text-destructive">
              {uploadError}
            </p>
          )}
        </div>
      )}
      {file ? (
        <>
          <label className="block text-xs">
            Súbor
            <select
              aria-label="Zdrojový súbor"
              value={file.name}
              onChange={(e) => {
                setPath(e.target.value);
                setAction("");
              }}
              className="ml-2 max-w-full rounded border border-border bg-card p-2"
            >
              {files.map((f) => (
                <option key={f.name}>{f.name}</option>
              ))}
            </select>
          </label>
          {errors.length > 0 && (
            <div
              role="alert"
              className="max-h-40 overflow-auto rounded-lg border border-destructive p-3 text-xs"
            >
              <p>Chyby posledného náhľadu{matchesBuild ? "" : " · zdroje už sú zmenené"}</p>
              {errors.map((error, i) => (
                <pre key={i} className="whitespace-pre-wrap break-all">
                  {error.message}
                </pre>
              ))}
            </div>
          )}
          {state.editor ? (
            <EditorBoundary
              key={file.name}
              fallback={
                <textarea
                  aria-label={"Obsah súboru " + file.name}
                  value={file.content}
                  onChange={(e) =>
                    mutate(
                      files.map((f) =>
                        f.name === file.name ? { ...f, content: e.target.value } : f,
                      ),
                    )
                  }
                  className="h-96 w-full rounded border border-border bg-card p-3 font-mono text-xs"
                />
              }
            >
              <Suspense
                fallback={
                  <p role="status" className="text-xs">
                    Načítavam editor…
                  </p>
                }
              >
                <SourceEditor
                  path={file.name}
                  value={file.content}
                  errors={matchesBuild && errors.length ? errors : noErrors}
                  onChange={(content) =>
                    mutate(files.map((f) => (f.name === file.name ? { ...f, content } : f)))
                  }
                />
              </Suspense>
            </EditorBoundary>
          ) : (
            <pre className="max-h-[480px] overflow-auto rounded-xl border border-border bg-card p-4 text-xs">
              <code>{file.content}</code>
            </pre>
          )}
        </>
      ) : (
        <StateBlock
          state="empty"
          title="Zatiaľ žiadne súbory"
          text="Pridaj zdrojové súbory, otvor projekt alebo popíš aplikáciu v chate."
        />
      )}
    </section>
  );
}
