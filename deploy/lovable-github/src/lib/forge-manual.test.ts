import { describe, expect, it, vi } from "vitest";
import { ForgeController } from "./forge-controller";
import type { Draft } from "./forge-drafts";
import type { ForgeTransport } from "./forge-agent";
const sources = [{ name: "src/main.tsx", content: "export {};" }];
function draft(): Draft {
  return {
    id: "project",
    revision: 1,
    dirty: false,
    workspace: {
      title: "Files",
      isPublic: false,
      liveId: "v1",
      files: structuredClone(sources),
      snapshots: [
        {
          id: "v1",
          v: 1,
          prompt: "Original",
          kind: "ai",
          time: "test",
          html: "",
          sourceFiles: JSON.stringify(sources),
        },
      ],
      conversation: [],
    },
  };
}
async function setup(value = draft()) {
  let stored = structuredClone(value);
  const storage = {
    read: async () => structuredClone(stored),
    write: vi.fn(async (_: string, d: Draft) => {
      stored = structuredClone(d);
    }),
  };
  const transport = vi.fn<ForgeTransport>(async (path) =>
    path === "ai-models"
      ? Response.json({ defaultId: null, models: [] })
      : path === "sandbox/build"
        ? Response.json({ ok: true, html: "compiled", errors: [] })
        : Response.json({ id: "project", revision: 2 }),
  );
  const controller = new ForgeController("alice", transport, storage);
  await controller.start();
  return { controller, transport, storage, stored: () => stored };
}
describe("manual files and immutable project versions", () => {
  it("stages all file operations separately, creates one child version, compiles and saves without editor metadata", async () => {
    const { controller: c, transport, stored } = await setup(),
      original = structuredClone(c.get().workspace);
    c.beginEdit();
    c.editFiles([
      { name: "src/main.tsx", content: "export const green = true;" },
      { name: "src/new.ts", content: "" },
    ]);
    expect(c.get().workspace).toEqual(original);
    expect(c.applyEdit()).toBe(true);
    expect(c.applyEdit()).toBe(false);
    expect(c.get().workspace.snapshots[0]).toEqual(original.snapshots[0]);
    expect(c.get().workspace.snapshots[1]).toMatchObject({ v: 2, parentId: "v1", kind: "edit" });
    await c.compile();
    expect(c.get().preview).toBe("compiled");
    await c.save();
    const body = transport.mock.calls.find(([path]) => path.startsWith("projects/"))?.[1]
      ?.body as Record<string, unknown>;
    expect(body).toHaveProperty("expectedRevision", 1);
    expect(body).not.toHaveProperty("editor");
    expect(body["workspace"]).not.toHaveProperty("editor");
    expect(stored().editor).toBeNull();
    c.dispose();
  });
  it("restores private unapproved edits after reload and discards without changing original sources", async () => {
    const { controller: c, transport, storage } = await setup();
    c.beginEdit();
    c.editFiles([{ name: "src/main.tsx", content: "local draft" }]);
    await Promise.resolve();
    const restored = new ForgeController("alice", transport, storage);
    await restored.start();
    expect(restored.get().editor?.files[0]?.content).toBe("local draft");
    expect(restored.get().workspace.files).toEqual(sources);
    restored.discardEdit();
    expect(restored.get().editor).toBeNull();
    expect(restored.get().workspace.snapshots).toHaveLength(1);
    c.dispose();
    restored.dispose();
  });
  it("blocks AI, remote saves, new/open/restore and compilation until edits are resolved", async () => {
    const { controller: c, transport } = await setup();
    c.beginEdit();
    await c.save();
    await c.open("other");
    await c.newProject();
    await c.openLocal("other");
    await c.generate("do not spend");
    await c.compile();
    c.restore("v1");
    expect(transport).toHaveBeenCalledOnce();
    expect(c.get().editor).not.toBeNull();
    expect(c.get().id).toBe("project");
    c.dispose();
  });
  it.each(["../x.ts", "src/../x.ts", "src\\x.ts", ".env", "src/.env", "src/CON.ts"])(
    "refuses unsafe edit path %s without changing the draft",
    async (name) => {
      const { controller: c } = await setup();
      c.beginEdit();
      const before = structuredClone(c.get().editor);
      expect(c.editFiles([{ name, content: "x" }])).toBe(false);
      expect(c.get().editor).toEqual(before);
      c.dispose();
    },
  );
  it("rejects credential-shaped text, duplicate paths and UTF8 overflow atomically", async () => {
    const { controller: c } = await setup();
    c.beginEdit();
    expect(c.editFiles([{ name: "src/config.ts", content: "ghp_" + "FAKE".repeat(5) }])).toBe(
      false,
    );
    expect(c.editFiles([...sources, ...sources])).toBe(false);
    expect(c.editFiles([{ name: "src/large.ts", content: "ž".repeat(100_001) }])).toBe(false);
    expect(c.get().editor?.files).toEqual(sources);
    c.dispose();
  });
  it("refuses a stale persisted source base and keeps recovery data", async () => {
    const initial = draft();
    initial.editor = { base: "stale", files: [{ name: "src/main.tsx", content: "local" }] };
    const { controller: c } = await setup(initial);
    expect(c.applyEdit()).toBe(false);
    expect(c.get().editor?.files[0]?.content).toBe("local");
    expect(c.get().workspace.files).toEqual(sources);
    c.dispose();
  });
  it("allows deleting all files as a recoverable version and does not create no-op versions", async () => {
    const { controller: c } = await setup();
    c.beginEdit();
    expect(c.applyEdit()).toBe(false);
    expect(c.get().workspace.snapshots).toHaveLength(1);
    c.beginEdit();
    expect(c.editFiles([])).toBe(true);
    expect(c.applyEdit()).toBe(true);
    expect(c.get().workspace.files).toEqual([]);
    c.restore("v1");
    expect(c.get().workspace.files).toEqual(sources);
    c.dispose();
  });
  it("does not let a cancelled local open replace later manual edits", async () => {
    const { controller: c, storage } = await setup();
    let finish!: (value: Draft) => void;
    const read = vi.spyOn(storage, "read").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opening = c.openLocal("other");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    c.cancel();
    c.beginEdit();
    c.editFiles([{ name: "src/main.tsx", content: "keep later edit" }]);
    finish({ ...draft(), id: "other" });
    await opening;
    expect(c.get().id).toBe("project");
    expect(c.get().editor?.files[0]?.content).toBe("keep later edit");
    c.dispose();
  });
  it("cannot mutate, persist or apply old account data after controller disposal", async () => {
    const { controller: c, storage } = await setup();
    c.beginEdit();
    await Promise.resolve();
    c.dispose();
    storage.write.mockClear();
    expect(c.editFiles([])).toBe(false);
    expect(c.applyEdit()).toBe(false);
    expect(c.beginEdit()).toBe(false);
    expect(storage.write).not.toHaveBeenCalled();
  });
});
