import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeContext } from "@/lib/forge-context";
import { ForgeController } from "@/lib/forge-controller";
import { ForgeFiles } from "./ForgeFiles";
vi.mock("./ForgeSourceEditor", () => ({
  default: ({
    path,
    value,
    onChange,
  }: {
    path: string;
    value: string;
    onChange: (s: string) => void;
  }) => (
    <textarea
      aria-label={"Obsah súboru " + path}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const files = [
  { name: "src/main.tsx", content: "export {};" },
  { name: "src/index.css", content: "body{color:blue}" },
];
let c: ForgeController;
beforeEach(async () => {
  c = new ForgeController(
    "alice",
    async (path) =>
      path === "ai-models"
        ? Response.json({ defaultId: null, models: [] })
        : Response.json({ ok: true, html: "compiled", errors: [] }),
    {
      read: async () => ({
        id: "p",
        revision: 1,
        dirty: false,
        workspace: {
          title: "Test",
          isPublic: false,
          liveId: "v1",
          files: structuredClone(files),
          snapshots: [
            {
              id: "v1",
              v: 1,
              prompt: "original",
              kind: "ai",
              time: "test",
              html: "",
              sourceFiles: JSON.stringify(files),
            },
          ],
        },
      }),
      write: async () => {},
    },
  );
  await c.start();
});
afterEach(() => {
  cleanup();
  c.dispose();
});
function show() {
  render(
    <ForgeContext.Provider value={c}>
      <ForgeFiles />
    </ForgeContext.Provider>,
  );
}
async function edit() {
  fireEvent.click(screen.getByRole("button", { name: "Upraviť súbory" }));
  await screen.findByRole("textbox", { name: "Obsah súboru src/main.tsx" });
}
describe("file workspace orchestration (CodeMirror is verified in the browser)", () => {
  it("applies edited code only explicitly and builds a new immutable version", async () => {
    show();
    await edit();
    fireEvent.change(screen.getByRole("textbox", { name: "Obsah súboru src/main.tsx" }), {
      target: { value: "export const x=1;" },
    });
    expect(c.get().workspace.files).toEqual(files);
    fireEvent.click(screen.getByRole("button", { name: "Použiť a spustiť náhľad" }));
    await waitFor(() => expect(c.get().preview).toBe("compiled"));
    expect(c.get().workspace.snapshots).toHaveLength(2);
    expect(c.get().workspace.files[0]?.content).toBe("export const x=1;");
  });
  it("adds, renames and removes a source in the draft; cancelling leaves original sources intact", async () => {
    show();
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Pridať súbor" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cesta súboru" }), {
      target: { value: "src/new.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Potvrdiť cestu" }));
    await screen.findByRole("textbox", { name: "Obsah súboru src/new.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Premenovať súbor" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cesta súboru" }), {
      target: { value: "src/renamed.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Potvrdiť cestu" }));
    await screen.findByRole("textbox", { name: "Obsah súboru src/renamed.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Odstrániť súbor" }));
    fireEvent.click(screen.getByRole("button", { name: "Potvrdiť odstránenie" }));
    expect(c.get().editor?.files).toEqual(files);
    fireEvent.click(screen.getByRole("button", { name: "Zrušiť úpravy" }));
    expect(c.get().workspace.files).toEqual(files);
    expect(c.get().workspace.snapshots).toHaveLength(1);
  });
  it("rejects an unsafe filename with a visible error and keeps the full previous draft", async () => {
    show();
    await edit();
    fireEvent.click(screen.getByRole("button", { name: "Pridať súbor" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cesta súboru" }), {
      target: { value: "../secret.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Potvrdiť cestu" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(c.get().editor?.files).toEqual(files);
  });
  it("imports UTF8 files to an explicit folder and never replaces existing paths", async () => {
    show();
    await edit();
    const upload = new File([""], "extra.ts");
    Object.defineProperty(upload, "arrayBuffer", {
      value: async () => new TextEncoder().encode("export const žltý = true;").buffer,
    });
    fireEvent.change(screen.getByLabelText("Importovať zdrojové súbory"), {
      target: { files: [upload] },
    });
    await screen.findByRole("textbox", { name: "Obsah súboru src/extra.ts" });
    expect(c.get().editor?.files.at(-1)?.content).toBe("export const žltý = true;");
    expect(c.get().workspace.files).toEqual(files);
    fireEvent.change(screen.getByLabelText("Importovať zdrojové súbory"), {
      target: { files: [upload] },
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(c.get().editor?.files).toHaveLength(3);
  });
  it("imports dropped UTF8 source files through the same atomic path", async () => {
    show();
    await edit();
    const upload = new File([""], "dropped.ts");
    Object.defineProperty(upload, "arrayBuffer", {
      value: async () => new TextEncoder().encode("export const dropped=true;").buffer,
    });
    const input = screen.getByLabelText("Importovať zdrojové súbory");
    fireEvent.drop(input.parentElement!.parentElement!, { dataTransfer: { files: [upload] } });
    await screen.findByRole("textbox", { name: "Obsah súboru src/dropped.ts" });
    expect(c.get().editor?.files).toHaveLength(3);
    expect(c.get().workspace.files).toEqual(files);
  });
  it("rejects the whole import when one selected file is not UTF8 text", async () => {
    show();
    await edit();
    const good = new File([""], "good.ts"),
      bad = new File([""], "binary.ts");
    Object.defineProperty(good, "arrayBuffer", {
      value: async () => new TextEncoder().encode("export {};").buffer,
    });
    Object.defineProperty(bad, "arrayBuffer", { value: async () => new Uint8Array([255]).buffer });
    fireEvent.change(screen.getByLabelText("Importovať zdrojové súbory"), {
      target: { files: [good, bad] },
    });
    await screen.findByRole("alert");
    expect(c.get().editor?.files).toEqual(files);
  });
  it("drops a delayed file read when the draft changes", async () => {
    show();
    await edit();
    let finish!: (b: ArrayBuffer) => void;
    const upload = new File([""], "late.ts");
    Object.defineProperty(upload, "arrayBuffer", {
      value: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    fireEvent.change(screen.getByLabelText("Importovať zdrojové súbory"), {
      target: { files: [upload] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Obsah súboru src/main.tsx" }), {
      target: { value: "changed" },
    });
    await act(async () => finish(new TextEncoder().encode("late").buffer));
    expect(screen.getByRole("alert")).toHaveTextContent("počas importu");
    expect(c.get().editor?.files).toHaveLength(2);
  });
});
