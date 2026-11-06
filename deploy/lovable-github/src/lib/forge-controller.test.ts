import { describe, expect, it, vi } from "vitest";
import { ForgeController } from "./forge-controller";
import { WorkspaceSchema } from "./forge-workspace";
import type { DraftStorage, Draft } from "./forge-drafts";
import type { ForgeTransport } from "./forge-agent";
const models = {
  defaultId: "mistral",
  models: [
    {
      id: "mistral",
      label: "AI (Mistral)",
      provider: "mistral",
      model: "fixture",
      fallbackIds: ["openai"],
    },
    { id: "openai", label: "AI (OpenAI)", provider: "openai", model: "backup", fallbackIds: [] },
  ],
};
const original = WorkspaceSchema.parse({
  title: "Original",
  isPublic: false,
  liveId: "v1",
  snapshots: [
    {
      id: "v1",
      v: 1,
      prompt: "Original",
      kind: "ai",
      time: "test",
      html: "",
      sourceFiles: JSON.stringify([
        { name: "src/index.css", content: ".primary{color:blue}" },
        { name: "src/main.tsx", content: "export {};" },
      ]),
    },
  ],
  files: [
    { name: "src/index.css", content: ".primary{color:blue}" },
    { name: "src/main.tsx", content: "export {};" },
  ],
  conversation: [],
});
const events = (mode = "iterate", ending = "done") => [
  { type: "run_started", runId: "run1", model: "fixture" },
  { type: "intent_selected", intent: mode },
  { type: "validation", result: { ok: true, errors: [] } },
  {
    type: "stage",
    editMode: "patch",
    summary: "One colour",
    files: [{ path: "src/index.css", content: ".primary{color:red}", action: "modify" }],
  },
  ending === "done"
    ? { type: "done", runId: "run1", summary: "Ready" }
    : { type: "error", code: "failed", message: "RAW_PRIVATE_MODEL_DETAIL", retriable: false },
];
const sse = (values: unknown[]) =>
  new Response(values.map((value) => "data: " + JSON.stringify(value) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
function drafts(
  initial: Draft | null = { id: "p1", revision: 1, workspace: original, dirty: false },
) {
  const owners = new Map<string, Draft>();
  if (initial) owners.set("alice", structuredClone(initial));
  return {
    owners,
    storage: {
      read: async (owner: string) => structuredClone(owners.get(owner) ?? null),
      write: async (owner: string, value: Draft) => {
        owners.set(owner, structuredClone(value));
      },
    } satisfies DraftStorage,
  };
}
async function setup(run: () => Response = () => sse(events())) {
  const cache = drafts(),
    transport = vi.fn<ForgeTransport>(async (path, init) =>
      path === "ai-models"
        ? Response.json(models)
        : path === "agent/generate"
          ? run()
          : path === "sandbox/build"
            ? Response.json({ ok: true, html: "<main>compiled</main>", errors: [] })
            : init?.method === "POST"
              ? Response.json({ id: "p1", revision: 2 })
              : Response.json({ id: "p1", revision: 1, workspace: original }),
    );
  const controller = new ForgeController("alice", transport, cache.storage);
  await controller.start();
  return { controller, transport, cache };
}
describe("Lovable real AI workspace controller", () => {
  it("binds full code/model/backup choice, keeps proposal separate, and applies an immutable child once", async () => {
    const { controller, transport } = await setup();
    controller.allowFallback(true);
    await controller.generate("Change only primary colour");
    expect(controller.get().workspace.files).toEqual(original.files);
    expect(controller.get().pending?.files).toHaveLength(1);
    const body = transport.mock.calls.find(([path]) => path === "agent/generate")?.[1]?.body as {
      context: { files: unknown[] };
      modelId: string;
      fallbackIds: string[];
    };
    expect(body).toMatchObject({
      modelId: "mistral",
      fallbackIds: ["openai"],
      context: {
        files: original.files.map((file) => ({ path: file.name, content: file.content })),
      },
    });
    controller.approve();
    controller.approve();
    expect(controller.get().workspace.snapshots).toHaveLength(2);
    expect(controller.get().workspace.snapshots[0]).toEqual(original.snapshots[0]);
    expect(controller.get().workspace.files[0]?.content).toContain("red");
    expect(controller.get().workspace.files[1]?.content).toBe(original.files[1]?.content);
    await controller.compile();
    expect(controller.get().preview).toBe("<main>compiled</main>");
    controller.dispose();
  });
  it("uses streamed text for a question without files, snapshots or a compiler call", async () => {
    const { controller, transport } = await setup(() =>
      sse([
        { type: "run_started", runId: "q", model: "fixture" },
        { type: "intent_selected", intent: "explain" },
        { type: "text_delta", delta: "Jednoduché " },
        { type: "text_delta", delta: "vysvetlenie." },
        { type: "done", runId: "q", summary: "Answer" },
      ]),
    );
    await controller.generate("Len vysvetli");
    expect(controller.get().workspace.files).toEqual(original.files);
    expect(controller.get().workspace.snapshots).toEqual(original.snapshots);
    expect(controller.get().workspace.conversation?.at(-1)?.content).toBe(
      "Jednoduché vysvetlenie.",
    );
    expect(controller.get().pending).toBeNull();
    expect(transport.mock.calls.map(([path]) => path)).not.toContain("sandbox/build");
    controller.dispose();
  });
  it.each(["error", "truncated", "mismatch"])("never stages files after %s", async (failure) => {
    const values = events("iterate", failure === "error" ? "error" : "done");
    if (failure === "truncated") values.pop();
    if (failure === "mismatch")
      values[values.length - 1] = { type: "done", runId: "other", summary: "Ready" };
    const { controller } = await setup(() => sse(values));
    await controller.generate("Update");
    expect(controller.get().pending).toBeNull();
    expect(controller.get().workspace.files).toEqual(original.files);
    expect(JSON.stringify(controller.get())).not.toContain("RAW_PRIVATE_MODEL_DETAIL");
    controller.dispose();
  });
  it("persists the acknowledged CAS revision and keeps conflicting local code recoverable", async () => {
    const { controller, transport, cache } = await setup();
    controller.rename("Renamed");
    await controller.save();
    expect(controller.get()).toMatchObject({ revision: 2, dirty: false });
    const save = transport.mock.calls.find(
      ([path, init]) => path === "projects/p1" && init?.method === "POST",
    );
    expect(save?.[1]?.body).toMatchObject({ expectedRevision: 1, workspace: { title: "Renamed" } });
    controller.rename("Unsaved");
    transport.mockImplementation(async () =>
      Response.json({ error: "project_conflict" }, { status: 409 }),
    );
    await controller.save();
    expect(controller.get()).toMatchObject({ revision: 2, dirty: true });
    expect(controller.get().workspace.title).toBe("Unsaved");
    expect(cache.owners.get("alice")?.workspace.title).toBe("Unsaved");
    controller.dispose();
  });
  it("does not retry an exhausted AI request and resets consent on model/catalog changes", async () => {
    const { controller, transport } = await setup();
    controller.allowFallback(true);
    controller.selectModel("openai");
    expect(controller.get().fallbackIds).toEqual([]);
    controller.selectModel("mistral");
    controller.allowFallback(true);
    await controller.loadModels();
    expect(controller.get().fallbackIds).toEqual([]);
    transport.mockImplementation(async () =>
      Response.json({ error: "quota_exceeded" }, { status: 429 }),
    );
    await controller.generate("Another");
    expect(controller.get().error).toContain("mesačný");
    expect(transport.mock.calls.filter(([path]) => path === "agent/generate")).toHaveLength(1);
    expect(controller.get().workspace.files).toEqual(original.files);
    controller.dispose();
  });
  it("ignores a late completed stream after cancellation and clears the pending gate", async () => {
    const cache = drafts();
    let finish!: (r: Response) => void;
    const transport: ForgeTransport = async (path) =>
      path === "ai-models"
        ? Response.json(models)
        : new Promise((resolve) => {
            finish = resolve;
          });
    const controller = new ForgeController("alice", transport, cache.storage);
    await controller.start();
    const work = controller.generate("Change");
    controller.cancel();
    finish(sse(events()));
    await work;
    expect(controller.get().pending).toBeNull();
    expect(controller.get().workspace.files).toEqual(original.files);
    expect(controller.get().busy).toBe(false);
    controller.dispose();
  });
  it("restores separate owner drafts and does not let a disposed Alice response affect Bob", async () => {
    const cache = drafts(),
      alice = new ForgeController("alice", async () => Response.json(models), cache.storage),
      bob = new ForgeController("bob", async () => Response.json(models), cache.storage);
    await alice.start();
    await bob.start();
    expect(alice.get().workspace.title).toBe("Original");
    expect(bob.get().workspace.files).toEqual([]);
    alice.dispose();
    bob.rename("Bob only");
    await bob.save();
    expect(alice.get().workspace.title).toBe("Original");
    expect(bob.get().workspace.title).toBe("Bob only");
    bob.dispose();
  });
  it("can create and approve the first multi-file project before any server save", async () => {
    const cache = drafts(null),
      transport: ForgeTransport = async (path) =>
        path === "ai-models"
          ? Response.json(models)
          : sse([
              { type: "run_started", runId: "new", model: "fixture" },
              { type: "intent_selected", intent: "create" },
              { type: "validation", result: { ok: true, errors: [] } },
              {
                type: "stage",
                files: [{ path: "src/main.tsx", content: "export {};", action: "create" }],
              },
              { type: "done", runId: "new", summary: "Ready" },
            ]);
    const controller = new ForgeController("alice", transport, cache.storage);
    await controller.start();
    await controller.generate("Create app");
    expect(controller.get().pending?.files).toHaveLength(1);
    expect(controller.get().workspace.files).toHaveLength(0);
    controller.approve();
    expect(controller.get().workspace.files).toHaveLength(1);
    expect(controller.get().workspace.snapshots[0]?.parentId).toBeNull();
    controller.dispose();
  });
});

describe("local recovery before replacing a server project", () => {
  it("keeps an unsaved same-ID workspace as a separate local copy before loading server data", async () => {
    const entries = new Map<string, Draft>();
    let pointer = "p1";
    entries.set("p1", {
      id: "p1",
      revision: 1,
      workspace: structuredClone(original),
      dirty: false,
    });
    const cache: DraftStorage = {
      read: async (_owner, id) => structuredClone(entries.get(id ?? pointer) ?? null),
      write: async (_owner, value) => {
        entries.set(value.id, structuredClone(value));
        pointer = value.id;
      },
    };
    const transport: ForgeTransport = async (path) =>
      Response.json(
        path === "ai-models"
          ? models
          : { id: "p1", revision: 2, workspace: { ...original, title: "Server version" } },
      );
    const controller = new ForgeController("alice", transport, cache);
    await controller.start();
    controller.rename("Unsaved local title");
    await controller.open("p1");
    expect(controller.get().workspace.title).toBe("Server version");
    const backup = [...entries.values()].find((draft) => draft.id !== "p1");
    expect(backup?.workspace.title).toContain("Unsaved local title");
    expect(backup?.workspace.files).toEqual(original.files);
    expect(backup?.revision).toBe(0);
    expect(backup?.dirty).toBe(true);
    controller.dispose();
  });
  it("does not discard dirty work when local backup storage fails", async () => {
    const { controller, transport, cache } = await setup();
    cache.storage.write = async () => {
      throw new Error("quota");
    };
    controller.rename("Must keep");
    await controller.newProject();
    expect(controller.get().workspace.title).toBe("Must keep");
    await controller.open("p1");
    expect(controller.get().workspace.title).toBe("Must keep");
    expect(transport.mock.calls.some(([path]) => path === "projects/p1")).toBe(false);
    controller.dispose();
  });
});
