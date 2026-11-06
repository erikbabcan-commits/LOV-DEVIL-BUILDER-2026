import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { CodePane } from "../../src/features/workspace/CodePane";
import { useStore } from "../../src/stores/useAppStore";
import { selectPersistenceScope } from "../../src/services/persistence/projectStore";
import { persistenceScope } from "../../src/services/persistence/db";
import * as drafts from "../../src/services/editor/codeDrafts";
vi.mock("../../src/features/workspace/SourceEditor", () => ({
  default: ({
    path,
    value,
    onChange,
    readOnly,
  }: {
    path: string;
    value: string;
    onChange: (v: string) => void;
    readOnly: boolean;
  }) => (
    <textarea
      aria-label={"Úprava " + path}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
let serial = 0;
function seed(owner: string) {
  selectPersistenceScope({ kind: "account", userId: owner });
  useStore.getState().newProject();
  const snapshot = {
    id: "s1",
    v: 1,
    prompt: "source",
    kind: "manual",
    time: "test",
    html: "<main>original</main>",
  };
  useStore.setState({
    projectId: "p1",
    snapshots: [snapshot],
    liveId: "s1",
    liveHtml: snapshot.html,
    viewing: null,
    tab: "code",
    vfs: {
      s1: [
        { name: "index.html", content: owner + " approved", modified: false },
      ],
    },
  });
}
beforeEach(() => {
  serial++;
  seed("alice-" + serial);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  selectPersistenceScope({ kind: "pilot" });
  useStore.getState().newProject();
});
async function input() {
  const box = await screen.findByRole("textbox", { name: "Úprava index.html" });
  await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
  return box;
}
describe("main code editor isolation and immutable save", () => {
  it("keeps the simple editor read-only until private draft recovery finishes", async () => {
    let release!: (value: null) => void;
    vi.spyOn(drafts, "readCodeDraft").mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<CodePane />);
    fireEvent.click(screen.getByRole("button", { name: "Jednoduchý editor" }));
    const box = screen.getByRole("textbox", { name: "Úprava index.html" });
    expect(box).toHaveAttribute("readonly");
    fireEvent.change(box, { target: { value: "must wait for recovery" } });
    expect(box).toHaveValue("alice-" + serial + " approved");
    await act(async () => {
      release(null);
    });
    await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
    expect(useStore.getState().codeDraftDirty).toBe(false);
  });
  it("retains the current draft guard while inspecting historical source and on return", async () => {
    render(<CodePane />);
    fireEvent.change(await input(), {
      target: { value: "private current draft" },
    });
    await waitFor(() => expect(useStore.getState().codeDraftDirty).toBe(true));
    act(() => {
      useStore.getState().viewSnapshot("s1");
      useStore.setState({ tab: "code" });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Úprava index.html" }),
      ).toHaveAttribute("readonly"),
    );
    expect(useStore.getState().codeDraftDirty).toBe(true);
    act(() => {
      useStore.getState().backToLive();
    });
    expect(await input()).toHaveValue("private current draft");
    expect(useStore.getState().codeDraftDirty).toBe(true);
  });
  it("keeps the unsaved-code guard when leaving the code view until the project is explicitly reset", async () => {
    const view = render(<CodePane />);
    fireEvent.change(await input(), {
      target: { value: "pending across views" },
    });
    await waitFor(() => expect(useStore.getState().codeDraftDirty).toBe(true));
    view.unmount();
    expect(useStore.getState().codeDraftDirty).toBe(true);
    useStore.getState().newProject();
    expect(useStore.getState().codeDraftDirty).toBe(false);
  });
  it("restores the actual draft after unmount without applying it to the live source", async () => {
    const view = render(<CodePane />);
    const box = await input();
    fireEvent.change(box, { target: { value: "local draft" } });
    await waitFor(async () =>
      expect(
        (
          await drafts.readCodeDraft(
            persistenceScope(),
            drafts.captureCodeEditBase(useStore.getState())!,
          )
        )?.tabs[0].draft,
      ).toBe("local draft"),
    );
    view.unmount();
    render(<CodePane />);
    expect(await input()).toHaveValue("local draft");
    expect(useStore.getState().vfs.s1[0].content).toBe(
      "alice-" + serial + " approved",
    );
  });
  it("saves one child with Ctrl+S and retains the original snapshot and VFS", async () => {
    render(<CodePane />);
    const box = await input(),
      original = structuredClone(useStore.getState().snapshots[0]),
      oldFiles = structuredClone(useStore.getState().vfs.s1);
    fireEvent.change(box, { target: { value: "<h1>edited</h1>" } });
    fireEvent.keyDown(box, { key: "s", ctrlKey: true });
    await waitFor(() => expect(useStore.getState().snapshots).toHaveLength(2));
    expect(useStore.getState().snapshots[0]).toEqual(original);
    expect(useStore.getState().vfs.s1).toEqual(oldFiles);
    expect(useStore.getState().snapshots[1].parentId).toBe("s1");
    expect(
      useStore.getState().vfs[useStore.getState().liveId!][0].content,
    ).toBe("<h1>edited</h1>");
  });
  it("clears synchronously when scope changes, even before store hydration, and restores only the matching owner", async () => {
    const alice = "alice-" + serial;
    render(<CodePane />);
    const box = await input();
    fireEvent.change(box, { target: { value: "Alice private draft" } });
    await waitFor(async () =>
      expect(
        (
          await drafts.readCodeDraft(
            persistenceScope(),
            drafts.captureCodeEditBase(useStore.getState())!,
          )
        )?.tabs[0].draft,
      ).toBe("Alice private draft"),
    );
    act(() =>
      selectPersistenceScope({ kind: "account", userId: "bob-" + serial }),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    act(() => seed("bob-" + serial));
    expect(await input()).toHaveValue("bob-" + serial + " approved");
    act(() => seed(alice));
    expect(await input()).toHaveValue("Alice private draft");
  });
  it("asks before closing a dirty tab and keeps it when the user cancels", async () => {
    render(<CodePane />);
    fireEvent.change(await input(), { target: { value: "keep me" } });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zavrieť index.html" }));
    expect(await input()).toHaveValue("keep me");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zavrieť index.html" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("keeps a stale recovery draft visible but blocks applying it onto changed source", async () => {
    const view = render(<CodePane />);
    fireEvent.change(await input(), { target: { value: "old source draft" } });
    await waitFor(async () =>
      expect(
        (
          await drafts.readCodeDraft(
            persistenceScope(),
            drafts.captureCodeEditBase(useStore.getState())!,
          )
        )?.tabs[0].draft,
      ).toBe("old source draft"),
    );
    view.unmount();
    useStore.setState({
      vfs: {
        s1: [
          {
            name: "index.html",
            content: "new authoritative source",
            modified: false,
          },
        ],
      },
    });
    render(<CodePane />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Podklad sa zmenil",
    );
    expect(screen.getByRole("textbox")).toHaveValue("old source draft");
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Uložiť (1)" })).toBeDisabled();
    expect(useStore.getState().vfs.s1[0].content).toBe(
      "new authoritative source",
    );
  });
  it("does not mutate the project if its recovery backup cannot be saved", async () => {
    render(<CodePane />);
    const box = await input();
    vi.spyOn(drafts, "writeCodeDraft").mockRejectedValue(new Error("quota"));
    fireEvent.change(box, { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Uložiť (1)" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(useStore.getState().liveId).toBe("s1");
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(box).toHaveValue("unsaved");
  });
  it("never applies an old delayed save to a new account", async () => {
    render(<CodePane />);
    fireEvent.change(await input(), { target: { value: "Alice later" } });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(drafts, "writeCodeDraft").mockImplementationOnce(() => gate);
    fireEvent.click(screen.getByRole("button", { name: "Uložiť (1)" }));
    act(() => seed("bob-" + serial));
    finish();
    expect(await input()).toHaveValue("bob-" + serial + " approved");
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(useStore.getState().vfs.s1[0].content).toBe(
      "bob-" + serial + " approved",
    );
  });
  it("renders historical sources read-only and ignores a local mutable draft", async () => {
    render(<CodePane />);
    fireEvent.change(await input(), { target: { value: "draft" } });
    act(() => useStore.setState({ viewing: useStore.getState().snapshots[0] }));
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue(
        "alice-" + serial + " approved",
      ),
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
  });
});
