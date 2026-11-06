import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { useStore } from "../../src/stores/useAppStore";
import { selectPersistenceScope } from "../../src/services/persistence/projectStore";
import { persistenceScope } from "../../src/services/persistence/db";
import { BLUEPRINT_REGISTRY } from "../../src/templates/registry";
import {
  captureCodeEditBase,
  matchesCodeEditBase,
  readCodeDraft,
  writeCodeDraft,
} from "../../src/services/editor/codeDrafts";
let serial = 0;
function seed(owner: string, localId = "s", remote = false) {
  selectPersistenceScope({ kind: "account", userId: owner });
  useStore.getState().newProject();
  useStore.setState({
    projectId: "p",
    remoteSnapshotIds: remote ? { [localId]: "remote-s" } : {},
    snapshots: [
      {
        id: localId,
        v: 1,
        prompt: "fixture",
        kind: "manual",
        time: "test",
        html: "<main/>",
      },
    ],
    liveId: localId,
    vfs: {
      [localId]: [{ name: "index.html", content: "original", modified: false }],
    },
  });
  return captureCodeEditBase(useStore.getState())!;
}
const tabs = [
  { name: "index.html", saved: "original", draft: "private draft" },
];
beforeEach(() => {
  serial++;
});
afterEach(() => {
  selectPersistenceScope({ kind: "pilot" });
  useStore.getState().newProject();
});
describe("scoped editor metadata", () => {
  it("restores a draft after actual template persistence changes only the live file order", async () => {
    selectPersistenceScope({ kind: "account", userId: "order-" + serial });
    useStore.getState().newProject();
    useStore.getState().stageTemplate(BLUEPRINT_REGISTRY[1]);
    expect(useStore.getState().approveStagedRun()).toBe(true);
    const before = captureCodeEditBase(useStore.getState())!;
    const files = structuredClone(useStore.getState().vfs[before.snapshotId]);
    const css = files.find((file) => file.name === "src/index.css")!;
    expect(await useStore.getState().persistNow()).toBe(true);
    const pending = [
      {
        name: css.name,
        saved: css.content,
        draft: css.content + "\n/* unsaved colour adjustment */",
      },
    ];
    await writeCodeDraft(persistenceScope(), before, pending, css.name);
    useStore.getState().newProject();
    await useStore.getState().restoreFromDb();
    const after = captureCodeEditBase(useStore.getState())!;
    const restoredFiles = useStore.getState().vfs[after.snapshotId];
    expect(restoredFiles.map((file) => file.name)).not.toEqual(
      files.map((file) => file.name),
    );
    expect(after).toEqual(before);
    expect(matchesCodeEditBase(useStore.getState(), before)).toBe(true);
    expect(await readCodeDraft(persistenceScope(), after)).toMatchObject({
      stale: false,
      tabs: pending,
    });
    expect(restoredFiles.find((file) => file.name === css.name)?.content).toBe(
      css.content,
    );
  });
  it("keeps equal project/snapshot IDs isolated by owner", async () => {
    const a = seed("a" + serial);
    await writeCodeDraft(persistenceScope(), a, tabs, "index.html");
    const b = seed("b" + serial);
    expect(await readCodeDraft(persistenceScope(), b)).toBeNull();
    const restored = seed("a" + serial);
    expect((await readCodeDraft(persistenceScope(), restored))?.tabs).toEqual(
      tabs,
    );
    expect(matchesCodeEditBase(useStore.getState(), a)).toBe(false);
  });
  it("binds in-flight writes and reads to their captured database/epoch", async () => {
    const a = seed("write-a" + serial),
      scope = persistenceScope(),
      writing = writeCodeDraft(scope, a, tabs, "index.html");
    const b = seed("write-b" + serial);
    await writing;
    expect(await readCodeDraft(persistenceScope(), b)).toBeNull();
    seed("write-a" + serial);
    const reading = readCodeDraft(
      persistenceScope(),
      captureCodeEditBase(useStore.getState())!,
    );
    seed("write-b" + serial);
    expect(await reading).toBeNull();
  });
  it("restores remote draft identity across local snapshot ID remapping", async () => {
    const first = seed("remote" + serial, "local-one", true);
    await writeCodeDraft(persistenceScope(), first, tabs, "index.html");
    const second = seed("remote" + serial, "local-two", true);
    expect((await readCodeDraft(persistenceScope(), second))?.tabs).toEqual(
      tabs,
    );
  });
  it("flags changed source without deleting the recoverable draft", async () => {
    const base = seed("stale" + serial);
    await writeCodeDraft(persistenceScope(), base, tabs, "index.html");
    useStore.setState({
      vfs: {
        s: [{ name: "index.html", content: "new source", modified: false }],
      },
    });
    const result = await readCodeDraft(
      persistenceScope(),
      captureCodeEditBase(useStore.getState())!,
    );
    expect(result?.stale).toBe(true);
    expect(result?.tabs[0].draft).toBe("private draft");
  });
  it.each([
    { name: "../x", saved: "", draft: "x" },
    { name: "src/config.ts", saved: "", draft: "ghp_" + "FAKE".repeat(5) },
    { name: "src/a.ts", saved: "", draft: "x".repeat(200_001) },
  ])("does not persist invalid draft $name", async (tab) => {
    const base = seed("bad" + serial);
    await expect(
      writeCodeDraft(persistenceScope(), base, [tab], tab.name),
    ).rejects.toThrow();
    expect(await readCodeDraft(persistenceScope(), base)).toBeNull();
  });
  it("refuses locked persistence", async () => {
    const base = seed("lock" + serial);
    selectPersistenceScope({ kind: "locked" });
    await expect(
      writeCodeDraft(persistenceScope(), base, tabs, "index.html"),
    ).rejects.toThrow();
    expect(captureCodeEditBase(useStore.getState())).toBeNull();
  });
});
