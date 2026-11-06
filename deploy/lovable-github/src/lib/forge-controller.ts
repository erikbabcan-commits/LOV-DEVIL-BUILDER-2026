import { z } from "zod";
import { WorkspaceSchema, ProjectId, Files, type ServerWorkspace } from "./forge-workspace";
import { AiModelsSchema, type AiModels } from "./forge-models";
import { applyFileOperations, type FileOperation } from "./forge-changes";
import { agentEvents, checkedResponse, type ForgeTransport } from "./forge-agent";
import {
  browserDrafts,
  DraftSchema,
  type DraftStorage,
  type DraftInfo,
  type EditorDraft,
} from "./forge-drafts";
import { inspectProjectSources } from "./forge-zip";
const empty = (): ServerWorkspace => ({
  title: "Môj projekt",
  isPublic: false,
  liveId: null,
  snapshots: [],
  files: [],
  conversation: [],
});
const id = () => crypto.randomUUID();
const projectsSchema = z.object({
  projects: z
    .array(z.object({ id: ProjectId, title: z.string(), revision: z.number().int().positive() }))
    .max(50),
  nextCursor: ProjectId.nullable(),
});
const projectSchema = z.object({
  id: ProjectId,
  revision: z.number().int().positive(),
  workspace: WorkspaceSchema,
});
export interface ForgeState {
  id: string;
  revision: number;
  workspace: ServerWorkspace;
  dirty: boolean;
  busy: boolean;
  ready: boolean;
  notice: string;
  error: string;
  preview: string | null;
  logs: string[];
  buildErrors: { file: string; message: string }[];
  editor: EditorDraft | null;
  models: AiModels;
  modelId: string;
  fallbackIds: string[];
  projects: z.infer<typeof projectsSchema>["projects"];
  localDrafts: DraftInfo[];
  cursor: string | null;
  pending: {
    runId: string;
    base: string;
    files: FileOperation[];
    summary: string;
    prompt: string;
    strict: boolean;
  } | null;
}
const fingerprint = (state: ForgeState) =>
  JSON.stringify({
    id: state.id,
    title: state.workspace.title,
    files: state.workspace.files,
    snapshots: state.workspace.snapshots,
    liveId: state.workspace.liveId,
  });
const editorBase = (state: ForgeState) =>
  JSON.stringify({
    id: state.id,
    liveId: state.workspace.liveId,
    files: state.workspace.files.map(({ name, content }) => ({ name, content })),
  });
function transcript(turns: NonNullable<ServerWorkspace["conversation"]>) {
  return turns.flatMap((turn) =>
    Array.from({ length: Math.ceil(turn.content.length / 4000) }, (_, i) => ({
      ...turn,
      content: turn.content.slice(i * 4000, (i + 1) * 4000),
    })),
  );
}
export class ForgeController {
  private state: ForgeState = {
    id: id(),
    revision: 0,
    workspace: empty(),
    dirty: false,
    busy: false,
    ready: false,
    notice: "",
    error: "",
    preview: null,
    logs: [],
    buildErrors: [],
    editor: null,
    models: { defaultId: null, models: [] },
    modelId: "",
    fallbackIds: [],
    projects: [],
    localDrafts: [],
    cursor: null,
    pending: null,
  };
  private listeners = new Set<() => void>();
  private work: AbortController | null = null;
  private lifetime = new AbortController();
  private started = false;
  private mounts = 0;
  constructor(
    readonly owner: string,
    private transport: ForgeTransport,
    private drafts: DraftStorage = browserDrafts,
  ) {}
  get = () => this.state;
  /** StrictMode effect replay retains the same owner; real unmount aborts after
   * the synchronous replay window. No stale-owner requests can use a new token. */
  retain() {
    this.mounts++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.mounts--;
      queueMicrotask(() => {
        if (this.mounts === 0) this.dispose();
      });
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<ForgeState>) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  private async stash() {
    try {
      await this.drafts.write(this.owner, {
        id: this.state.id,
        revision: this.state.revision,
        workspace: {
          ...this.state.workspace,
          conversation: transcript(this.state.workspace.conversation ?? []),
        },
        dirty: this.state.dirty,
        editor: this.state.editor,
      });
      if (this.drafts.list) this.set({ localDrafts: await this.drafts.list(this.owner) });
      return true;
    } catch {
      this.set({
        error: "Lokálnu zálohu sa nepodarilo uložiť. Pred zatvorením ulož projekt na server.",
      });
      return false;
    }
  }
  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const draft = await this.drafts.read(this.owner);
      if (draft) {
        const parsed = DraftSchema.parse(draft);
        this.set({ ...parsed, editor: parsed.editor ?? null });
      }
      if (this.drafts.list) this.set({ localDrafts: await this.drafts.list(this.owner) });
    } catch {
      this.set({ error: "Lokálna záloha nie je dostupná. Môžeš otvoriť projekt zo servera." });
    }
    this.set({ ready: true });
    await this.loadModels();
  }
  dispose() {
    this.lifetime.abort();
    this.work?.abort();
    this.listeners.clear();
  }
  cancel() {
    this.work?.abort();
    this.work = null;
    this.set({
      busy: false,
      pending: null,
      notice: "AI úloha bola zastavená. Súbory sa nemenili.",
    });
    void this.stash();
  }
  private async job(work: (signal: AbortSignal) => Promise<void>) {
    if (this.state.busy || !this.state.ready) return;
    const controller = new AbortController();
    this.work = controller;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await work(AbortSignal.any([controller.signal, this.lifetime.signal]));
    } catch (error) {
      if (!controller.signal.aborted && !this.lifetime.signal.aborted)
        this.set({ error: error instanceof Error ? error.message : "Požiadavka sa nepodarila." });
    } finally {
      if (this.work === controller) {
        this.work = null;
        this.set({ busy: false });
        await this.stash();
      }
    }
  }
  private async json(path: string, signal: AbortSignal, body?: unknown) {
    const response = await checkedResponse(
      await this.transport(path, {
        signal,
        ...(body === undefined ? {} : { method: "POST", body }),
      }),
    );
    signal.throwIfAborted();
    return response.json() as Promise<unknown>;
  }
  async loadModels() {
    try {
      const models = AiModelsSchema.parse(await this.json("ai-models", this.lifetime.signal));
      this.set({
        models,
        modelId: models.models.some((m) => m.id === this.state.modelId)
          ? this.state.modelId
          : (models.defaultId ?? ""),
        fallbackIds: [],
      });
    } catch {
      this.set({ error: "Modely sa nepodarilo načítať. Over pripojenie backendu a obnov ponuku." });
    }
  }
  selectModel(modelId: string) {
    if (this.state.busy) return;
    this.set({ modelId, fallbackIds: [] });
  }
  allowFallback(allow: boolean) {
    if (this.state.busy) return;
    this.set({
      fallbackIds: allow
        ? [
            ...(this.state.models.models.find((m) => m.id === this.state.modelId)?.fallbackIds ??
              []),
          ]
        : [],
    });
  }
  rename(title: string) {
    if (this.state.busy || this.state.pending) return;
    this.set({
      workspace: { ...this.state.workspace, title: title.trim().slice(0, 120) || "Môj projekt" },
      dirty: true,
    });
    void this.stash();
  }
  private editorGuard() {
    if (!this.state.editor) return false;
    this.set({ error: "Najprv použi alebo zruš rozpracované úpravy v záložke Súbory/Kód." });
    return true;
  }
  beginEdit() {
    if (
      !this.owner ||
      !this.state.ready ||
      this.state.busy ||
      this.state.pending ||
      this.lifetime.signal.aborted
    )
      return false;
    if (!this.state.editor)
      this.set({
        editor: {
          base: editorBase(this.state),
          files: structuredClone(this.state.workspace.files),
        },
        error: "",
      });
    void this.stash();
    return true;
  }
  editFiles(candidate: ServerWorkspace["files"]) {
    if (!this.state.editor || this.state.busy || this.state.pending || this.lifetime.signal.aborted)
      return false;
    const files = Files.safeParse(candidate);
    const errors = files.success && candidate.length ? inspectProjectSources(candidate).errors : [];
    if (!files.success || errors.length) {
      this.set({
        error: errors[0] ?? "Súbory prekračujú povolené cesty, počet alebo veľkosť projektu.",
      });
      return false;
    }
    this.set({ editor: { ...this.state.editor, files: files.data }, error: "" });
    void this.stash();
    return true;
  }
  discardEdit() {
    if (this.state.busy || this.lifetime.signal.aborted) return;
    this.set({
      editor: null,
      error: "",
      notice: "Ručné úpravy zrušené. Schválené súbory zostali zachované.",
    });
    void this.stash();
  }
  applyEdit() {
    const state = this.state,
      editor = state.editor;
    if (!editor || state.busy || state.pending || this.lifetime.signal.aborted) return false;
    if (editor.base !== editorBase(state)) {
      this.set({
        error:
          "Zdrojová verzia sa zmenila. Rozpracované úpravy zostali zachované; zruš ich a otvor aktuálne súbory.",
      });
      return false;
    }
    if (
      JSON.stringify(editor.files.map(({ name, content }) => ({ name, content }))) ===
      JSON.stringify(state.workspace.files.map(({ name, content }) => ({ name, content })))
    ) {
      this.discardEdit();
      return false;
    }
    try {
      const files = Files.parse(editor.files),
        errors = files.length ? inspectProjectSources(files).errors : [];
      if (errors.length) throw new Error("invalid_sources");
      const snapshot = {
        id: id(),
        v: Math.max(0, ...state.workspace.snapshots.map((s) => s.v)) + 1,
        parentId: state.workspace.liveId,
        prompt: "Ručná úprava súborov",
        kind: "edit",
        time: new Date().toISOString(),
        html: files.find((f) => f.name === "index.html")?.content ?? "",
        sourceFiles: JSON.stringify(files),
      };
      const workspace = WorkspaceSchema.parse({
        ...state.workspace,
        files,
        liveId: snapshot.id,
        snapshots: [...state.workspace.snapshots, snapshot],
      });
      this.set({
        workspace,
        editor: null,
        dirty: true,
        preview: null,
        logs: [],
        buildErrors: [],
        error: "",
        notice: "Ručné zmeny použité v novej verzii. Pôvodná zostáva v histórii.",
      });
      void this.stash();
      return true;
    } catch {
      this.set({
        error: "Úpravy neprešli kontrolou limitov alebo histórie. Zostali rozpracované.",
      });
      return false;
    }
  }
  async listProjects(more = false) {
    try {
      const query =
        more && this.state.cursor ? "?cursor=" + encodeURIComponent(this.state.cursor) : "";
      const result = projectsSchema.parse(
        await this.json("projects" + query, this.lifetime.signal),
      );
      this.set({
        projects: more ? [...this.state.projects, ...result.projects] : result.projects,
        cursor: result.nextCursor,
      });
    } catch {
      this.set({ error: "Projekty sa nepodarilo načítať. Over pripojenie a skús zoznam obnoviť." });
    }
  }
  async open(projectId: string) {
    if (this.editorGuard()) return;
    if (this.state.pending) {
      this.set({ error: "Najprv schváľ alebo odmietni návrh." });
      return;
    }
    await this.job(async (signal) => {
      ProjectId.parse(projectId);
      const previous = this.state;
      if (!(await this.stash()) && previous.dirty) return;
      const project = projectSchema.parse(
        await this.json("projects/" + encodeURIComponent(projectId), signal),
      );
      signal.throwIfAborted();
      if (previous.dirty && previous.id === project.id) {
        try {
          await this.drafts.write(this.owner, {
            id: id(),
            revision: 0,
            workspace: {
              ...previous.workspace,
              title: previous.workspace.title.slice(0, 100) + " (lokálna kópia)",
              conversation: transcript(previous.workspace.conversation ?? []),
            },
            dirty: true,
          });
        } catch {
          throw new Error(
            "Pracovnú kópiu sa nepodarilo zálohovať. Serverová verzia nenahradila tvoje zmeny.",
          );
        }
      }
      signal.throwIfAborted();
      this.set({
        ...project,
        dirty: false,
        preview: null,
        pending: null,
        logs: [],
        buildErrors: [],
        editor: null,
        notice: "Projekt načítaný zo servera.",
      });
    });
  }
  async newProject() {
    if (this.editorGuard()) return;
    if (this.state.pending) return;
    await this.job(async (signal) => {
      if (!(await this.stash()) && this.state.dirty) return;
      signal.throwIfAborted();
      this.set({
        id: id(),
        revision: 0,
        workspace: empty(),
        dirty: false,
        preview: null,
        pending: null,
        logs: [],
        buildErrors: [],
        editor: null,
        notice: "Nový projekt.",
      });
    });
  }
  async openLocal(projectId: string) {
    if (this.editorGuard()) return;
    if (this.state.pending) return;
    await this.job(async (signal) => {
      if (!(await this.stash()) && this.state.dirty) return;
      const draft = await this.drafts.read(this.owner, projectId);
      signal.throwIfAborted();
      if (!draft) throw new Error("Lokálna verzia nie je dostupná.");
      this.set({
        ...DraftSchema.parse(draft),
        editor: draft.editor ?? null,
        preview: null,
        pending: null,
        logs: [],
        buildErrors: [],
        notice: "Lokálna pracovná verzia obnovená.",
      });
    });
  }
  async save(copy = false) {
    if (this.editorGuard()) return;
    if (this.state.pending) {
      this.set({ error: "Najprv schváľ alebo odmietni návrh." });
      return;
    }
    await this.job(async (signal) => {
      const state = this.state,
        projectId = copy ? id() : state.id,
        workspace = WorkspaceSchema.parse({
          ...state.workspace,
          conversation: transcript(state.workspace.conversation ?? []),
        }),
        base = fingerprint(state);
      const result = z.object({ id: ProjectId, revision: z.number().int().positive() }).parse(
        await this.json("projects/" + projectId, signal, {
          expectedRevision: copy ? 0 : state.revision,
          workspace,
        }),
      );
      signal.throwIfAborted();
      if (fingerprint(this.state) !== base)
        throw new Error(
          "Projekt sa počas ukladania zmenil. Server má zachytenú verziu; lokálne zmeny ostali.",
        );
      this.set({
        id: result.id,
        revision: result.revision,
        dirty: false,
        notice: "Projekt uložený na server.",
      });
    });
  }
  private conversation(role: "user" | "assistant", content: string) {
    this.set({
      workspace: {
        ...this.state.workspace,
        conversation: [...(this.state.workspace.conversation ?? []), { role, content }],
      },
      dirty: true,
    });
  }
  private answer(content: string) {
    const turns = [...(this.state.workspace.conversation ?? [])];
    turns[turns.length - 1] = { role: "assistant", content };
    this.set({ workspace: { ...this.state.workspace, conversation: turns }, dirty: true });
  }
  async generate(prompt: string) {
    if (this.editorGuard()) return;
    if (this.state.pending) {
      this.set({ error: "Najprv schváľ alebo odmietni návrh." });
      return;
    }
    if (!prompt.trim() || prompt.length > 4000) return;
    if (!this.state.modelId) {
      this.set({ error: "Najprv vyber dostupný model." });
      return;
    }
    await this.job(async (signal) => {
      const source = this.state,
        base = fingerprint(source);
      this.conversation("user", prompt.trim());
      this.conversation("assistant", "Pripravujem odpoveď…");
      let runId = "",
        answer = "",
        done = false,
        valid = false,
        intent = "",
        stage: FileOperation[] | null = null,
        summary = "",
        strict = false;
      const body = {
        projectId: source.id,
        modelId: source.modelId,
        allowFallback: source.fallbackIds.length > 0,
        fallbackIds: source.fallbackIds,
        prompt: prompt.trim(),
        mode: "auto",
        context: {
          projectTitle: source.workspace.title,
          files: source.workspace.files.map((file) => ({ path: file.name, content: file.content })),
          history: source.workspace.snapshots
            .slice(-20)
            .map((s) => ({ v: s.v, prompt: s.prompt.slice(0, 300) })),
          conversation: transcript(source.workspace.conversation ?? []),
        },
      };
      try {
        for await (const event of agentEvents(this.transport, body, signal)) {
          signal.throwIfAborted();
          if (fingerprint(this.state) !== base)
            throw new Error("Projekt sa počas AI úlohy zmenil. Návrh bol zahodený.");
          if (event.type === "run_started") runId = event.runId;
          if (event.type === "intent_selected") intent = event.intent;
          if (event.type === "text_delta") {
            answer += event.delta;
            this.answer(answer);
          }
          if (event.type === "plan") this.set({ notice: event.plan.summary });
          if (event.type === "provider_update" || event.type === "context_update")
            this.set({
              notice:
                event.type === "provider_update"
                  ? event.message
                  : "Pripravujem úplný kontext projektu…",
            });
          if (event.type === "validation") valid = event.result.ok;
          if (event.type === "stage") {
            if (stage) throw new Error("AI poslala nejednoznačný návrh.");
            stage = event.files;
            summary = event.summary ?? "Skontroluj navrhované súbory.";
            strict = event.editMode === "patch";
          }
          if (event.type === "error")
            throw new Error(
              "AI úloha zlyhala. Súbory sa nemenili. " +
                (event.code === "context_limit" ? "Vyber model s väčším kontextom." : ""),
            );
          if (event.type === "cancelled")
            throw new Error("AI úloha sa zastavila. Súbory sa nemenili.");
          if (event.type === "done") {
            if (!runId || event.runId !== runId)
              throw new Error("AI úloha nemá platné dokončenie.");
            done = true;
          }
        }
        if (!done) throw new Error("AI úloha sa nedokončila.");
        if (intent === "explain") {
          if (stage || !answer.trim()) throw new Error("Neplatná odpoveď bez zmien.");
          this.set({ notice: "Odpoveď dokončená. Súbory sa nemenili." });
        } else {
          if (!valid || !stage) throw new Error("AI návrh neprešiel kontrolou.");
          const after = applyFileOperations(source.workspace.files, stage, strict);
          if (!after) throw new Error("Návrh obsahuje konfliktné súbory.");
          Files.parse(after);
          this.set({
            pending: { runId, base, files: stage, summary, prompt: prompt.trim(), strict },
            notice: "Návrh čaká na tvoje schválenie.",
          });
          this.answer("Návrh je pripravený na kontrolu. Súbory sa zatiaľ nepoužili.");
        }
      } catch (error) {
        if (!signal.aborted)
          this.answer((answer ? answer + "\n\n" : "") + "Úloha sa prerušila. Projekt sa nemenil.");
        throw error;
      }
    });
  }
  approve() {
    if (this.editorGuard()) return;
    const state = this.state,
      pending = state.pending;
    if (!pending || state.busy) return;
    if (fingerprint(state) !== pending.base) {
      this.set({ pending: null, error: "Návrh je zastaraný. Projekt sa zmenil." });
      return;
    }
    const files = applyFileOperations(state.workspace.files, pending.files, pending.strict);
    if (!files) return;
    const snapshot = {
      id: id(),
      v: Math.max(0, ...state.workspace.snapshots.map((s) => s.v)) + 1,
      parentId: state.workspace.liveId,
      prompt: pending.prompt,
      kind: "ai",
      time: new Date().toISOString(),
      html: files.find((f) => f.name === "index.html")?.content ?? "",
      sourceFiles: JSON.stringify(files),
    };
    try {
      const workspace = WorkspaceSchema.parse({
        ...state.workspace,
        files,
        liveId: snapshot.id,
        snapshots: [...state.workspace.snapshots, snapshot],
      });
      this.set({
        workspace,
        pending: null,
        preview: null,
        dirty: true,
        notice: "Zmeny použité. Pôvodná verzia zostáva v histórii.",
      });
      this.answer("Zmeny boli schválené a použité v novej verzii.");
      void this.stash();
    } catch {
      this.set({ error: "Návrh prekračuje limity projektu. Nič sa nepoužilo." });
    }
  }
  reject() {
    if (!this.state.pending) return;
    this.set({ pending: null, notice: "Návrh odmietnutý. Súbory sa nezmenili." });
    this.answer("Návrh odmietnutý; súbory sa nepoužili.");
    void this.stash();
  }
  restore(snapshotId: string) {
    if (this.editorGuard()) return;
    if (this.state.busy || this.state.pending) return;
    const snapshot = this.state.workspace.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) return;
    try {
      const files = snapshot.sourceFiles
        ? JSON.parse(snapshot.sourceFiles)
        : [{ name: "index.html", content: snapshot.html }];
      const workspace = WorkspaceSchema.parse({
        ...this.state.workspace,
        liveId: snapshot.id,
        files,
      });
      this.set({
        workspace,
        dirty: true,
        preview: null,
        buildErrors: [],
        logs: [],
        notice: "Obnovená verzia v" + snapshot.v,
      });
      void this.stash();
    } catch {
      this.set({ error: "Verziu sa nepodarilo obnoviť." });
    }
  }
  async compile() {
    if (this.editorGuard()) return;
    if (this.state.pending) return;
    await this.job(async (signal) => {
      const base = fingerprint(this.state),
        result = z
          .object({
            ok: z.boolean(),
            html: z.string().max(3_000_000).nullable(),
            errors: z.array(z.object({ file: z.string(), message: z.string() })).max(100),
          })
          .parse(
            await this.json("sandbox/build", signal, {
              files: this.state.workspace.files
                .filter((f) => !["styles.css", "app.js"].includes(f.name))
                .map((f) => ({ path: f.name, content: f.content })),
            }),
          );
      signal.throwIfAborted();
      if (fingerprint(this.state) !== base) return;
      this.set({
        preview: result.ok ? result.html : null,
        buildErrors: result.errors,
        logs: result.ok
          ? ["Náhľad bol úspešne skompilovaný."]
          : result.errors.map((error) => error.file + ": " + error.message),
        notice: result.ok ? "Náhľad pripravený." : "Build zlyhal. Podrobnosti sú v konzole.",
      });
    });
  }
}
