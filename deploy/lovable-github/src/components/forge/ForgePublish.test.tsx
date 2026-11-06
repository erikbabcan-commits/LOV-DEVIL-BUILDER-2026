import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeController } from "@/lib/forge-controller";
import { ForgeContext } from "@/lib/forge-context";
import { ForgePublish } from "./ForgePublish";
const mock = vi.hoisted(() => ({ hono: vi.fn() }));
vi.mock("@/lib/hono-client", () => ({ honoFetch: mock.hono }));
let controller: ForgeController,
  save: ReturnType<typeof vi.fn<(path: string, init?: unknown) => Promise<Response>>>;
const ready = { enabled: true, ready: true, reason: null, publicOrigin: "http://127.0.0.1:8791" };
const artifact = "e57b6df2-9c92-478e-b40c-87d87dc42a42";
function job(body: Record<string, unknown>) {
  return {
    requestId: body["requestId"],
    projectId: body["projectId"],
    snapshotId: body["snapshotId"],
    revision: body["expectedRevision"],
    state: "published",
    url: "http://127.0.0.1:8791/p/" + artifact + "/",
    error: null,
    errors: [],
    artifactBytes: 1000,
    createdAt: new Date().toISOString(),
  };
}
function responseJob(body: Record<string, unknown>) {
  return Response.json(job(body));
}
beforeEach(async () => {
  sessionStorage.clear();
  save = vi.fn(async () => Response.json({ id: "p1", revision: 2 }));
  const files = [
    { name: "src/main.tsx", content: 'document.body.textContent="Published application"' },
  ];
  controller = new ForgeController(
    "alice",
    async (path, init) =>
      path === "ai-models" ? Response.json({ defaultId: null, models: [] }) : save(path, init),
    {
      read: async () => ({
        id: "p1",
        revision: 1,
        dirty: true,
        workspace: {
          title: "Actual project",
          isPublic: false,
          liveId: "v1",
          files,
          snapshots: [
            {
              id: "v1",
              v: 1,
              kind: "manual",
              prompt: "source",
              time: "now",
              html: "",
              sourceFiles: JSON.stringify(files),
            },
          ],
          conversation: [],
        },
      }),
      write: async () => {},
    },
  );
  await controller.start();
  mock.hono.mockImplementation(async (path, init) =>
    path === "publish" && !init?.body ? Response.json(ready) : responseJob(init.body),
  );
});
afterEach(() => {
  cleanup();
  controller.dispose();
  vi.resetAllMocks();
});
function show() {
  return render(
    <ForgeContext.Provider value={controller}>
      <ForgePublish />
    </ForgeContext.Provider>,
  );
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Publikovať" }));
  await screen.findByRole("dialog");
  await waitFor(() =>
    expect(screen.getByText("Verejný hosting: http://127.0.0.1:8791")).toBeInTheDocument(),
  );
}
function consent() {
  fireEvent.click(screen.getByRole("checkbox"));
}
describe("real publication dialog", () => {
  it("clears a verified failed job so the first retry after reopening uses a fresh UUID", async () => {
    let first = true;
    mock.hono.mockImplementation(async (path, init) => {
      if (path === "publish" && !init?.body) return Response.json(ready);
      if (first) {
        first = false;
        return Response.json({
          ...job(init.body),
          state: "failed",
          url: null,
          error: "publish_build_failed",
          errors: [{ file: "src/main.tsx", message: "Build failed" }],
          artifactBytes: null,
        });
      }
      return responseJob(init.body);
    });
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Build failed");
    const firstBody = mock.hono.mock.calls.find(([, init]) => init?.body)![1].body;
    expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    const bodies = mock.hono.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) => init.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].requestId).not.toBe(firstBody.requestId);
    expect(bodies[1]).toMatchObject({ projectId: "p1", expectedRevision: 2, snapshotId: "v1" });
    expect(save).toHaveBeenCalledOnce();
  });
  it("retains the failed selection when a delayed response belongs to a different revision", async () => {
    mock.hono.mockImplementation(async (path, init) =>
      !init?.body
        ? Response.json(ready)
        : Response.json({
            ...job(init.body),
            revision: 999,
            state: "failed",
            url: null,
            error: "publish_build_failed",
            artifactBytes: null,
          }),
    );
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("alert");
    const body = mock.hono.mock.calls.find(([, init]) => init?.body)![1].body;
    expect(JSON.parse(sessionStorage.getItem("forge-publish:v1:alice:p1")!)).toEqual(body);
  });
  it("keeps a newer receipt if a verified older failed response arrives", async () => {
    let finish!: (r: Response) => void;
    mock.hono.mockImplementation(async (path, init) =>
      !init?.body
        ? Response.json(ready)
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const body = mock.hono.mock.calls.find(([, init]) => init?.body)![1].body;
    const replacement = JSON.stringify({ ...body, requestId: crypto.randomUUID() });
    sessionStorage.setItem("forge-publish:v1:alice:p1", replacement);
    await act(async () =>
      finish(
        Response.json({
          ...job(body),
          state: "failed",
          url: null,
          error: "publish_build_failed",
          artifactBytes: null,
        }),
      ),
    );
    expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBe(replacement);
  });
  it("requires explicit public consent and sends the actual saved project revision and snapshot", async () => {
    show();
    await open();
    const submit = screen.getByRole("button", { name: "Publikovať verejne" });
    expect(submit).toBeDisabled();
    expect(mock.hono).toHaveBeenCalledTimes(1);
    consent();
    fireEvent.click(submit);
    const link = await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:8791/p/" + artifact + "/");
    expect(save).toHaveBeenCalledOnce();
    const call = mock.hono.mock.calls.find(([, init]) => init?.body);
    expect(call?.[1].body).toMatchObject({
      projectId: "p1",
      expectedRevision: 2,
      snapshotId: "v1",
      publicConsent: true,
    });
    expect(call?.[1].body).not.toHaveProperty("html");
    expect(call?.[1].body).not.toHaveProperty("url");
    expect(call?.[1].expectedUserId).toBe("alice");
  });
  it("shows disabled hosting honestly and never starts a publication", async () => {
    mock.hono.mockResolvedValue(
      Response.json({
        ...ready,
        enabled: false,
        ready: false,
        reason: "disabled",
        publicOrigin: null,
      }),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať" }));
    await screen.findByText(/Publikovanie ešte nie je nakonfigurované/);
    consent();
    expect(screen.getByRole("button", { name: "Publikovať verejne" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });
  it("reuses its owner/project request UUID after an uncertain network result", async () => {
    let count = 0;
    mock.hono.mockImplementation(async (path, init) => {
      if (!init?.body) return Response.json(ready);
      if (count++ === 0) throw new Error("Spojenie sa prerušilo.");
      return responseJob(init.body);
    });
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    const bodies = mock.hono.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) => init.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(save).toHaveBeenCalledOnce();
  });
  it("does not turn a response for another saved revision into a success link", async () => {
    mock.hono.mockImplementation(async (path, init) =>
      !init?.body ? Response.json(ready) : Response.json({ ...job(init.body), revision: 999 }),
    );
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("link", { name: "Otvoriť publikovanú aplikáciu" }),
    ).not.toBeInTheDocument();
  });
  it("checks a stored building job before retrying its exact selection and UUID", async () => {
    await controller.save();
    const selection = {
      requestId: crypto.randomUUID(),
      projectId: "p1",
      expectedRevision: 2,
      snapshotId: "v1",
      publicConsent: true,
    };
    sessionStorage.setItem("forge-publish:v1:alice:p1", JSON.stringify(selection));
    mock.hono.mockImplementation(async (path, init) => {
      if (path === "publish" && !init?.body) return Response.json(ready);
      if (path === "publish/" + selection.requestId)
        return Response.json({
          ...job(selection),
          state: "building",
          url: null,
          artifactBytes: null,
        });
      return responseJob(init.body);
    });
    show();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
    await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    expect(mock.hono.mock.calls.map(([path]) => path)).toEqual([
      "publish",
      "publish/" + selection.requestId,
      "publish",
    ]);
    expect(mock.hono.mock.calls[2]?.[1].body).toEqual(selection);
    expect(save).toHaveBeenCalledOnce();
  });
  it("ignores a delayed success when the actual workspace changes during the build", async () => {
    let finish!: (r: Response) => void;
    mock.hono.mockImplementation(async (path, init) =>
      !init?.body
        ? Response.json(ready)
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const call = mock.hono.mock.calls.find(([, init]) => init?.body)!;
    act(() => controller.rename("Changed workspace"));
    await act(async () => finish(responseJob(call[1].body)));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pracovná verzia sa zmenila");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("removes a completed publication link when the current workspace is edited", async () => {
    show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    act(() => controller.rename("New unsaved workspace"));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("aborts polling and ignores a delayed result after unmount", async () => {
    let finish!: (r: Response) => void;
    mock.hono.mockImplementation(async (path, init) =>
      !init?.body
        ? Response.json(ready)
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    const view = show();
    await open();
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const call = mock.hono.mock.calls.find(([, init]) => init?.body)!;
    view.unmount();
    expect(call[1].signal.aborted).toBe(true);
    await act(async () => finish(responseJob(call[1].body)));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
