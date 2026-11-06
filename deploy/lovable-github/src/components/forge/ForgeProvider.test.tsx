import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeProvider } from "./ForgeProvider";
import { useForge } from "@/lib/forge-context";
import { ForgeCanvas } from "./ForgeCanvas";
import { WorkspaceView } from "./WorkspaceView";
const mock = vi.hoisted(() => ({ owner: "alice", hono: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({
    status: mock.owner ? "signed-in" : "signed-out",
    session: mock.owner ? { user: { id: mock.owner } } : null,
  }),
}));
vi.mock("@/lib/hono-client", () => ({ honoFetch: mock.hono }));
vi.mock("@/lib/forge-drafts", async (original) => ({
  ...(await original<typeof import("@/lib/forge-drafts")>()),
  browserDrafts: { read: mock.read, write: mock.write },
}));
const models = {
  defaultId: "mistral",
  models: [
    {
      id: "mistral",
      label: "AI (Mistral)",
      provider: "mistral",
      model: "fixture",
      fallbackIds: [],
    },
  ],
};
const sse = (values: unknown[]) =>
  new Response(values.map((value) => "data: " + JSON.stringify(value) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const question = [
  { type: "run_started", runId: "q", model: "fixture" },
  { type: "intent_selected", intent: "explain" },
  { type: "text_delta", delta: "Alice answer" },
  { type: "done", runId: "q", summary: "Answer" },
];
function Probe() {
  const { state, controller } = useForge();
  return (
    <>
      <h1>{state.workspace.title}</h1>
      <output aria-label="Odpoveď">{state.workspace.conversation?.at(-1)?.content}</output>
      <button onClick={() => void controller.generate("Only explain")}>Spustiť úlohu</button>
    </>
  );
}
beforeEach(() => {
  mock.owner = "alice";
  mock.read.mockImplementation(async (owner) => ({
    id: "p1",
    revision: 1,
    dirty: false,
    workspace: {
      title: owner + " private project",
      isPublic: false,
      liveId: "v1",
      files: [{ name: "src/index.css", content: ".primary{color:blue}" }],
      snapshots: [
        {
          id: "v1",
          v: 1,
          prompt: "Original",
          time: "test",
          kind: "ai",
          html: "",
          sourceFiles: '[{"name":"src/index.css","content":".primary{color:blue}"}]',
        },
      ],
      conversation: [],
    },
  }));
  mock.write.mockResolvedValue(undefined);
  mock.hono.mockImplementation(async (path) =>
    path === "ai-models" ? Response.json(models) : sse(question),
  );
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.resetAllMocks();
});
describe("Lovable owner-scoped React workspace", () => {
  it("survives StrictMode effect replay without duplicating model requests or losing streaming", async () => {
    render(
      <StrictMode>
        <ForgeProvider>
          <Probe />
        </ForgeProvider>
      </StrictMode>,
    );
    expect(await screen.findByText("alice private project")).toBeInTheDocument();
    await waitFor(() => expect(mock.hono).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Spustiť úlohu" }));
    expect(await screen.findByText("Alice answer")).toBeInTheDocument();
    expect(mock.hono.mock.calls[0]?.[1]).toMatchObject({ expectedUserId: "alice" });
  });
  it("clears Alice synchronously on account change and discards her delayed response", async () => {
    let finish!: (r: Response) => void;
    mock.hono.mockImplementation(async (path) =>
      path === "ai-models"
        ? Response.json(models)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const ui = (
        <ForgeProvider>
          <Probe />
        </ForgeProvider>
      ),
      view = render(ui);
    await screen.findByText("alice private project");
    await waitFor(() => expect(mock.hono).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Spustiť úlohu" }));
    mock.owner = "bob";
    view.rerender(
      <ForgeProvider>
        <Probe />
      </ForgeProvider>,
    );
    expect(screen.queryByText("alice private project")).not.toBeInTheDocument();
    await screen.findByText("bob private project");
    await act(async () => finish(sse(question)));
    expect(screen.queryByText("Alice answer")).not.toBeInTheDocument();
  });
  it("shows actual proposal diff, permits inspecting original code and only compiles after approval", async () => {
    mock.hono.mockImplementation(async (path) =>
      path === "ai-models"
        ? Response.json(models)
        : path === "sandbox/build"
          ? Response.json({ ok: true, html: "<main>COMPILED</main>", errors: [] })
          : sse([
              { type: "run_started", runId: "edit", model: "fixture" },
              { type: "intent_selected", intent: "iterate" },
              { type: "validation", result: { ok: true, errors: [] } },
              {
                type: "stage",
                editMode: "patch",
                summary: "Only primary colour",
                files: [
                  { path: "src/index.css", content: ".primary{color:red}", action: "modify" },
                ],
              },
              { type: "done", runId: "edit", summary: "Ready" },
            ]),
    );
    render(
      <ForgeProvider>
        <Probe />
        <ForgeCanvas />
      </ForgeProvider>,
    );
    await screen.findByText("alice private project");
    await waitFor(() => expect(mock.hono).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Spustiť úlohu" }));
    await screen.findByRole("region", { name: "Kontrola AI návrhu" });
    expect(screen.getByLabelText("Rozdiel src/index.css")).toHaveTextContent("color:blue");
    expect(screen.getByLabelText("Rozdiel src/index.css")).toHaveTextContent("color:red");
    expect(mock.hono.mock.calls.some(([path]) => path === "sandbox/build")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Kód" }));
    expect(screen.getByText(".primary{color:blue}")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Zmeny" }));
    fireEvent.click(screen.getByRole("button", { name: "Použiť zmeny" }));
    const iframe = await screen.findByTitle("Náhľad projektu");
    expect(iframe).toHaveAttribute("srcdoc", "<main>COMPILED</main>");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });
  it("does not load drafts or call the backend for a signed-out visitor", async () => {
    mock.owner = "";
    render(
      <ForgeProvider>
        <WorkspaceView idea="Create app" />
      </ForgeProvider>,
    );
    expect(screen.getByRole("link", { name: "Prihlásiť sa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Odoslať" })).toBeDisabled();
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.hono).not.toHaveBeenCalled();
  });
});
