import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { captureCodeEditBase } from "../../src/services/editor/codeDrafts";
import { useStore } from "../../src/stores/useAppStore";
import { selectPersistenceScope } from "../../src/services/persistence/projectStore";
import { loadSnapshots, loadFiles } from "../../src/services/persistence/db";
import { filesFor } from "../../src/lib/vfs/filesFor";
let serial = 0;
function seed() {
  useStore.getState().newProject();
  const snap = useStore
    .getState()
    .createSnapshot("manual", "source", "<main>original</main>");
  useStore.setState({
    liveId: snap.id,
    liveHtml: snap.html,
    viewing: null,
    vfs: { [snap.id]: filesFor(snap) },
  });
  return snap;
}
beforeEach(() => {
  serial++;
  selectPersistenceScope({ kind: "account", userId: "manual-" + serial });
  seed();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  selectPersistenceScope({ kind: "pilot" });
  useStore.getState().newProject();
});
describe("main manual commit contract", () => {
  it("reopens a persisted project in the workspace even when it has no conversation", async () => {
    const id = useStore.getState().projectId;
    expect(await useStore.getState().persistNow()).toBe(true);
    useStore.getState().newProject();
    useStore.getState().setMode("home");
    await useStore.getState().restoreFromDb();
    expect(useStore.getState().projectId).toBe(id);
    expect(useStore.getState().messages).toEqual([]);
    expect(useStore.getState().mode).toBe("work");
  });
  it("persists a child snapshot and leaves every original scalar/source unchanged", async () => {
    const old = structuredClone(useStore.getState().snapshots[0]),
      oldFiles = structuredClone(useStore.getState().vfs[old.id]);
    expect(
      await useStore.getState().applyStagedFiles(
        [
          {
            path: "index.html",
            content: "<main>changed</main>",
            action: "modify",
          },
        ],
        captureCodeEditBase(useStore.getState())!,
      ),
    ).toBe(true);
    const state = useStore.getState();
    expect(state.snapshots[0]).toEqual(old);
    expect(state.vfs[old.id]).toEqual(oldFiles);
    expect(state.snapshots[1]).toMatchObject({
      parentId: old.id,
      v: 2,
      kind: "manual",
    });
    const stored = await loadSnapshots(state.projectId);
    expect(stored).toHaveLength(2);
    expect(stored.find((s) => s.id === old.id)?.html).toBe(old.html);
    expect(
      (await loadFiles(state.projectId)).find((f) => f.path === "index.html")
        ?.content,
    ).toBe("<main>changed</main>");
  });
  it("rejects a stale source/epoch even if a later account has equal source IDs", async () => {
    const base = captureCodeEditBase(useStore.getState())!;
    selectPersistenceScope({ kind: "account", userId: "other-" + serial });
    expect(
      await useStore.getState().applyStagedFiles(
        [
          {
            path: "index.html",
            content: "old account edit",
            action: "modify",
          },
        ],
        base,
      ),
    ).toBe(false);
    expect(useStore.getState().snapshots).toHaveLength(1);
    useStore.getState().newProject();
    expect(
      await useStore.getState().applyStagedFiles(
        [
          {
            path: "index.html",
            content: "old account edit",
            action: "modify",
          },
        ],
        base,
      ),
    ).toBe(false);
  });
  it("rejects the complete batch when one path is unsafe", async () => {
    const files = structuredClone(useStore.getState().vfs),
      old = useStore.getState().liveId;
    expect(
      await useStore.getState().applyStagedFiles([
        {
          path: "index.html",
          content: "partial must not apply",
          action: "modify",
        },
        { path: "../escape.ts", content: "x", action: "create" },
      ]),
    ).toBe(false);
    expect(useStore.getState().liveId).toBe(old);
    expect(useStore.getState().vfs).toEqual(files);
  });
  it.each(["missing", "duplicate", "secret"])(
    "rejects %s edits without new versions",
    async (kind) => {
      const operations =
        kind === "missing"
          ? [
              {
                path: "src/missing.ts",
                content: "x",
                action: "modify" as const,
              },
            ]
          : kind === "secret"
            ? [
                {
                  path: "src/config.ts",
                  content: "ghp_" + "FAKE".repeat(5),
                  action: "create" as const,
                },
              ]
            : [
                { path: "index.html", content: "a", action: "modify" as const },
                { path: "index.html", content: "b", action: "modify" as const },
              ];
      expect(await useStore.getState().applyStagedFiles(operations)).toBe(
        false,
      );
      expect(useStore.getState().snapshots).toHaveLength(1);
    },
  );
  it("does not create no-op versions and refuses historical mutation", async () => {
    const state = useStore.getState(),
      file = state.vfs[state.liveId!][0];
    expect(
      await state.applyStagedFiles([
        { path: file.name, content: file.content, action: "modify" },
      ]),
    ).toBe(false);
    useStore.setState({ viewing: state.snapshots[0] });
    expect(
      await state.applyStagedFiles([
        { path: "index.html", content: "rewrite history", action: "modify" },
      ]),
    ).toBe(false);
    expect(useStore.getState().snapshots).toHaveLength(1);
  });
  it("keeps an in-memory child and reports failed persistence without overwriting its parent", async () => {
    const original = structuredClone(useStore.getState().snapshots[0]);
    vi.spyOn(useStore.getState(), "persistNow").mockResolvedValue(false);
    expect(
      await useStore.getState().applyStagedFiles([
        {
          path: "index.html",
          content: "recoverable memory edit",
          action: "modify",
        },
      ]),
    ).toBe(false);
    expect(useStore.getState().snapshots).toHaveLength(2);
    expect(useStore.getState().snapshots[0]).toEqual(original);
  });
  it("blocks paid AI/repair and competing legacy apply while a code draft is dirty", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    useStore.setState({ codeDraftDirty: true });
    await useStore
      .getState()
      .generateWithAi("Do not spend while draft is open", "auto");
    await useStore.getState().repairSandbox();
    await useStore.getState().exportToZip();
    await useStore.getState().exportToGitHub();
    useStore.getState().manualSnapshot();
    useStore.getState().setEdFile("index.html");
    useStore.getState().saveEdFile("competing dashboard edit");
    const live = useStore.getState().liveId;
    useStore.getState().restoreSnapshot(useStore.getState().snapshots[0].id);
    expect(useStore.getState().liveId).toBe(live);
    expect(
      await useStore
        .getState()
        .applyStagedFiles([
          { path: "index.html", content: "other apply", action: "modify" },
        ]),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(useStore.getState().snapshots).toHaveLength(1);
  });
});
