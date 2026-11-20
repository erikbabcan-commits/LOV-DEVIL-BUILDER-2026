import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { CodePane } from "../../src/features/workspace/CodePane";
import { FileTabs } from "../../src/features/editor/FileTabs";
import { FuzzySearch } from "../../src/features/editor/FuzzySearch";
import { fuzzyFilter, fuzzyMatch } from "../../src/features/editor/fuzzy";
import { markersFor } from "../../src/features/editor/lintMarkers";
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
    markers,
  }: {
    path: string;
    value: string;
    onChange: (v: string) => void;
    readOnly: boolean;
    markers: { line: number; column: number; message: string }[];
  }) => (
    <textarea
      aria-label={"Úprava " + path}
      data-markers={JSON.stringify(markers.map((m) => [m.line, m.column]))}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const FILES = [
  { name: "index.html", content: "<div id=root></div>", modified: false },
  {
    name: "src/main.tsx",
    content: "import App from './App';",
    modified: false,
  },
  {
    name: "src/App.tsx",
    content: "export default function App() {\n  return <main/>;\n  oops(\n}",
    modified: false,
  },
  {
    name: "src/components/Button.tsx",
    content: "export const Button = () => null;",
    modified: false,
  },
];
let serial = 0;
function seed() {
  selectPersistenceScope({ kind: "account", userId: "editor-" + ++serial });
  useStore.getState().newProject();
  const snapshot = {
    id: "s1",
    v: 1,
    prompt: "fixture",
    kind: "manual",
    time: "test",
    html: "<main>fixture</main>",
  };
  useStore.setState({
    projectId: "p1",
    snapshots: [snapshot],
    liveId: "s1",
    liveHtml: snapshot.html,
    viewing: null,
    tab: "code",
    vfs: { s1: FILES.map((f) => ({ ...f })) },
  });
}
async function editorFor(path: string) {
  const box = await screen.findByRole("textbox", { name: "Úprava " + path });
  await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
  return box;
}
beforeEach(() => {
  seed();
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

describe("fuzzy file matching", () => {
  it("matches case-insensitive subsequences and rejects non-matches", () => {
    expect(fuzzyMatch("btn", "src/components/Button.tsx")?.indices).toEqual([
      15, 17, 20,
    ]);
    expect(fuzzyMatch("APP", "src/App.tsx")).not.toBeNull();
    expect(fuzzyMatch("xyz", "src/App.tsx")).toBeNull();
    expect(fuzzyMatch("  ", "src/App.tsx")?.score).toBe(0);
  });
  it("ranks file-name and word-boundary hits first and keeps order for an empty query", () => {
    const paths = [
      "src/lib/apparatus/main.ts",
      "src/App.tsx",
      "src/pages/about.tsx",
    ];
    expect(fuzzyFilter("app", paths)[0].path).toBe("src/App.tsx");
    expect(fuzzyFilter("main", paths).map((m) => m.path)).toEqual([
      "src/lib/apparatus/main.ts",
    ]);
    expect(fuzzyFilter("", paths).map((m) => m.path)).toEqual(paths);
    expect(fuzzyFilter("", paths, 2)).toHaveLength(2);
  });
});

describe("build errors as lint markers", () => {
  it("maps esbuild path:line:col to the right line and ignores other files", () => {
    const errors = [
      {
        file: "src/App.tsx",
        message:
          '✘ [ERROR] Expected ")" but found "}"\n\n    src/App.tsx:4:0:\n      4 │ }',
      },
      { file: "src/main.tsx", message: "src/main.tsx:1:7: ERROR: nope" },
      { file: "-", message: "/tmp/build/src/App.tsx:2:9: ERROR: second" },
    ];
    expect(markersFor("src/App.tsx", errors)).toEqual([
      { line: 4, column: 0, message: errors[0].message },
      { line: 2, column: 9, message: errors[2].message },
    ]);
  });
  it("falls back to line 1 for an unlocated error of the file and de-duplicates", () => {
    const error = { file: "src/App.tsx", message: "chýba export" };
    expect(markersFor("src/App.tsx", [error, error])).toEqual([
      { line: 1, column: 0, message: "chýba export" },
    ]);
    expect(markersFor("src/App.tsx", [{ file: "-", message: "x" }])).toEqual(
      [],
    );
  });
  it("draws a real CodeMirror lint range on the reported line", async () => {
    const { default: RealEditor } = await vi.importActual<
      typeof import("../../src/features/workspace/SourceEditor")
    >("../../src/features/workspace/SourceEditor");
    const { container } = render(
      <RealEditor
        path="src/App.tsx"
        value={"const a = 1;\nconst b = ;\nconst c = 3;"}
        onChange={() => {}}
        markers={[{ line: 2, column: 10, message: "Unexpected ;" }]}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-lintRange-error")).not.toBeNull(),
    );
    const range = container.querySelector(".cm-lintRange-error")!;
    expect(range.closest(".cm-line")?.textContent).toBe("const b = ;");
    expect(range.textContent).toBe(";");
  });
  it("passes markers for the active tab from the last build into the editor", async () => {
    useStore.setState({ edFile: "src/App.tsx" });
    render(<CodePane />);
    const box = await editorFor("src/App.tsx");
    act(() => {
      useStore.setState({
        sandboxErrors: [
          {
            file: "src/App.tsx",
            message: "src/App.tsx:3:2: ERROR: Unexpected",
          },
          { file: "src/main.tsx", message: "src/main.tsx:1:0: ERROR: other" },
        ],
      });
    });
    await waitFor(() =>
      expect(box.getAttribute("data-markers")).toBe("[[3,2]]"),
    );
  });
});

describe("FuzzySearch dialog", () => {
  it("is an accessible combobox: arrows move the active option and Enter opens it", () => {
    const onOpen = vi.fn(),
      onClose = vi.fn();
    render(
      <FuzzySearch
        files={FILES.map((f) => f.name)}
        onOpen={onOpen}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Rýchle otvorenie súboru",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const input = within(dialog).getByRole("combobox", {
      name: "Hľadať súbor",
    });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(input, { target: { value: "tsx" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(3);
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const now = screen.getAllByRole("option");
    expect(now[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", now[1].id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const expected = screen.getAllByRole("option")[2].textContent;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(expected);
  });
  it("closes on Escape, reports no results and never opens a missing file", () => {
    const onOpen = vi.fn(),
      onClose = vi.fn();
    render(
      <FuzzySearch files={["src/App.tsx"]} onOpen={onOpen} onClose={onClose} />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Žiadny súbor nezodpovedá",
    );
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FileTabs", () => {
  it("supports arrow/Home/End navigation, Delete to close and a labelled dirty indicator", () => {
    const onSelect = vi.fn(),
      onClose = vi.fn();
    const tabs = [
      { name: "a.ts", saved: "1", draft: "1" },
      { name: "b.ts", saved: "1", draft: "2" },
      { name: "c.ts", saved: "1", draft: "1" },
    ];
    render(
      <FileTabs
        tabs={tabs}
        active="a.ts"
        idPrefix="t"
        panelId="panel"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const list = screen.getAllByRole("tab");
    expect(list[0]).toHaveAttribute("aria-selected", "true");
    expect(list[0]).toHaveAttribute("aria-controls", "panel");
    expect(list[1]).toHaveAttribute("tabindex", "-1");
    expect(
      within(list[1]).getByRole("img", { name: "neuložené zmeny" }),
    ).toBeInTheDocument();
    expect(within(list[0]).queryByRole("img")).toBeNull();
    fireEvent.keyDown(list[0], { key: "ArrowRight" });
    fireEvent.keyDown(list[0], { key: "ArrowLeft" });
    fireEvent.keyDown(list[0], { key: "End" });
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([
      "b.ts",
      "c.ts",
      "c.ts",
    ]);
    fireEvent.keyDown(list[0], { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith("a.ts");
  });
});

describe("CodePane tabs and quick open", () => {
  it("opens a file with Ctrl+P, keyboard selection and Enter, then restores focus on Escape", async () => {
    render(<CodePane />);
    await editorFor("index.html");
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Hľadať súbor" });
    fireEvent.change(input, { target: { value: "button" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await editorFor("src/components/Button.tsx")).toHaveValue(
      "export const Button = () => null;",
    );
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "index.html",
      "src/components/Button.tsx",
    ]);
    expect(useStore.getState().edFile).toBe("src/components/Button.tsx");
    const opener = screen.getByRole("button", {
      name: "Rýchle otvorenie súboru",
    });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it("opens quick open with Cmd+P only on the code view and ignores Shift+Ctrl+P", async () => {
    render(<CodePane />);
    await editorFor("index.html");
    fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    act(() => useStore.setState({ tab: "preview" }));
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps unsaved drafts across tab switches and when a dirty tab close is cancelled", async () => {
    render(<CodePane />);
    fireEvent.change(await editorFor("index.html"), {
      target: { value: "<p>draft</p>" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Otvoriť src/App.tsx" }),
    );
    await editorFor("src/App.tsx");
    const [first] = screen.getAllByRole("tab");
    expect(
      within(first).getByRole("img", { name: "neuložené zmeny" }),
    ).toBeInTheDocument();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zavrieť index.html" }));
    expect(confirm).toHaveBeenCalled();
    fireEvent.click(first);
    expect(await editorFor("index.html")).toHaveValue("<p>draft</p>");
    // closing a clean tab never prompts and keeps the dirty one + its backup
    fireEvent.click(
      screen.getByRole("button", { name: "Zavrieť src/App.tsx" }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    await waitFor(async () =>
      expect(
        (
          await drafts.readCodeDraft(
            persistenceScope(),
            drafts.captureCodeEditBase(useStore.getState())!,
          )
        )?.tabs.map((t) => [t.name, t.draft]),
      ).toEqual([["index.html", "<p>draft</p>"]]),
    );
    expect(useStore.getState().codeDraftDirty).toBe(true);
  });
});
