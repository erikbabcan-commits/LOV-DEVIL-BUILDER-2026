import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { ForgeController } from "@/lib/forge-controller";
import { ForgeContext } from "@/lib/forge-context";
import { ForgeZipExport } from "./ForgeZipExport";
import type { ProjectZip } from "@/lib/forge-zip";
const mock = vi.hoisted(() => ({ create: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/forge-zip", async (original) => {
  const real = await original<typeof import("@/lib/forge-zip")>();
  mock.create.mockImplementation(real.createProjectZip);
  return { ...real, createProjectZip: mock.create, downloadProjectZip: mock.download };
});
const original = [{ name: "index.html", content: "<h1>Pôvodné</h1>" }];
const current = [
  ...original,
  { name: "README.md", content: "# Vlastný README" },
  { name: ".gitignore", content: "node_modules\n.env" },
];
let controller: ForgeController;
beforeEach(async () => {
  controller = new ForgeController(
    "alice",
    async () => Response.json({ defaultId: null, models: [] }),
    {
      read: async () => ({
        id: "p",
        revision: 2,
        dirty: true,
        workspace: {
          title: "Môj export",
          isPublic: false,
          liveId: "v2",
          files: structuredClone(current),
          snapshots: [1, 2].map((v) => ({
            id: "v" + v,
            v,
            prompt: "Verzia " + v,
            kind: "ai",
            time: "test",
            html: "",
            sourceFiles: JSON.stringify(v === 1 ? original : current),
          })),
          conversation: [{ role: "user", content: "PRIVATE CHAT NEVER EXPORT" }],
        },
      }),
      write: async () => {},
    },
  );
  await controller.start();
  mock.download.mockClear();
});
afterEach(() => {
  cleanup();
  controller.dispose();
  mock.create.mockClear();
});
function show() {
  return render(
    <ForgeContext.Provider value={controller}>
      <ForgeZipExport />
    </ForgeContext.Provider>,
  );
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Export ZIP" }));
  await screen.findByRole("dialog");
}
describe("actual ZIP dialog", () => {
  it("downloads the actual current source files, excluding conversation, with no backend write", async () => {
    show();
    await open();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stiahnuť ZIP" }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
    const archive = mock.download.mock.calls[0]![0] as ProjectZip;
    const zip = await JSZip.loadAsync(archive.bytes, { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual(current.map((f) => f.name).sort());
    expect(await zip.file("README.md")!.async("string")).toBe("# Vlastný README");
    expect(await screen.findByRole("status")).toHaveTextContent("moj-export-v2.zip");
    expect(controller.get().revision).toBe(2);
  });
  it("exports historical sources without restoring or changing the live workspace", async () => {
    show();
    await open();
    fireEvent.change(screen.getByRole("combobox", { name: "Verzia na export" }), {
      target: { value: "v1" },
    });
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stiahnuť ZIP" }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
    const archive = mock.download.mock.calls[0]![0] as ProjectZip;
    expect(archive.filename).toBe("moj-export-v1.zip");
    expect(Object.keys((await JSZip.loadAsync(archive.bytes)).files)).toEqual(["index.html"]);
    expect(controller.get().workspace.liveId).toBe("v2");
    expect(controller.get().workspace.files).toEqual(current);
  });
  it.each(["close", "unmount", "source-change"])(
    "discards a delayed archive after %s",
    async (change) => {
      let finish!: (value: ProjectZip) => void;
      mock.create.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = show();
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Stiahnuť ZIP" }));
      expect(screen.getByRole("button", { name: "Pripravujem ZIP…" })).toBeDisabled();
      if (change === "close") fireEvent.click(screen.getByRole("button", { name: "Zavrieť" }));
      else if (change === "unmount") view.unmount();
      else act(() => controller.rename("Changed project"));
      await act(async () =>
        finish({ bytes: new Uint8Array([1]), filename: "old.zip", fileCount: 1 }),
      );
      expect(mock.download).not.toHaveBeenCalled();
      if (change === "source-change")
        expect(screen.getByRole("alert")).toHaveTextContent("Projekt sa zmenil");
    },
  );
  it("reports a generation error and supports a fresh explicit retry", async () => {
    mock.create.mockRejectedValueOnce(new Error("synthetic failure"));
    show();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Stiahnuť ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ZIP sa nepodarilo");
    expect(mock.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stiahnuť ZIP" }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledOnce());
  });
});
