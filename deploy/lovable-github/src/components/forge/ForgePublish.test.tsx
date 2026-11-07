import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeController } from "@/lib/forge-controller";
import { ForgeContext } from "@/lib/forge-context";
import { ForgePublish } from "./ForgePublish";
const mock = vi.hoisted(() => ({ hono: vi.fn() }));
vi.mock("@/lib/hono-client", () => ({ honoFetch: mock.hono }));
let controller: ForgeController,
  save: ReturnType<typeof vi.fn<(path: string, init?: unknown) => Promise<Response>>>;
const ready = {
  enabled: true,
  ready: true,
  reason: null,
  publicOrigin: "http://127.0.0.1:8791",
};
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
    {
      name: "src/main.tsx",
      content: 'document.body.textContent="Published application"',
    },
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
  vi.restoreAllMocks();
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
async function newerSavedSources() {
  const previous = controller.get().workspace,
    files = [
      {
        name: "src/main.tsx",
        content: 'document.body.textContent="New saved source"',
      },
    ];
  const workspace = {
    ...previous,
    title: "New saved source",
    liveId: "v2",
    files,
    snapshots: [
      ...previous.snapshots,
      {
        ...previous.snapshots[0]!,
        id: "v2",
        v: 2,
        sourceFiles: JSON.stringify(files),
      },
    ],
  };
  save.mockResolvedValueOnce(Response.json({ id: "p1", revision: 7, workspace }));
  await act(async () => controller.open("p1"));
  expect(controller.get().revision).toBe(7);
  expect(controller.get().workspace.liveId).toBe("v2");
}
async function startUncertain() {
  let selection: Record<string, unknown> | undefined;
  mock.hono.mockImplementation(async (path, init) => {
    if (path === "publish" && !init?.body) return Response.json(ready);
    if (init?.body && !selection) {
      selection = init.body;
      throw new TypeError("Lost initial response");
    }
    return responseJob(init?.body ?? selection!);
  });
  const view = show();
  await open();
  consent();
  fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
  await screen.findByRole("alert");
  return { view, selection: selection! };
}
describe("real publication dialog", () => {
  it("recovers an old request before saving edited sources and requires a new explicit consent/action for the current publication", async () => {
    const { selection } = await startUncertain();
    act(() => controller.rename("Unsaved current workspace"));
    const captured = controller.get(),
      saveSpy = vi.spyOn(controller, "save"),
      uuid = vi.spyOn(crypto, "randomUUID"),
      transportCalls = save.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("link", {
      name: "Otvoriť publikáciu predchádzajúcej verzie",
    });
    expect(screen.getByText(/Aktuálne zdroje tým nie sú publikované/)).toBeInTheDocument();
    expect(controller.get()).toBe(captured);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(transportCalls);
    expect(uuid).not.toHaveBeenCalled();
    expect(mock.hono.mock.calls.filter(([, init]) => init?.body)).toHaveLength(1);
    expect(
      mock.hono.mock.calls.some(([path]) => path === "publish/" + selection["requestId"]),
    ).toBe(true);
    expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBeNull();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Publikovať verejne" })).toBeDisabled();
    save.mockResolvedValueOnce(Response.json({ id: "p1", revision: 3 }));
    consent();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať verejne" }));
    await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    const bodies = mock.hono.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) => init.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].requestId).not.toBe(selection["requestId"]);
    expect(bodies[1].expectedRevision).toBe(3);
    expect(saveSpy).toHaveBeenCalledOnce();
    expect(uuid).toHaveBeenCalledOnce();
  });
  it("recovers the original UUID after both saved revision and snapshot change without a new save", async () => {
    const { selection } = await startUncertain();
    await newerSavedSources();
    const captured = controller.get(),
      saveSpy = vi.spyOn(controller, "save"),
      uuid = vi.spyOn(crypto, "randomUUID"),
      calls = save.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
    const link = await screen.findByRole("link", {
      name: "Otvoriť publikáciu predchádzajúcej verzie",
    });
    expect(link).toHaveAttribute("href", job(selection).url);
    expect(controller.get()).toBe(captured);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(calls);
    expect(uuid).not.toHaveBeenCalled();
    expect(mock.hono.mock.calls.filter(([, init]) => init?.body)).toHaveLength(1);
    expect(mock.hono.mock.calls.at(-1)?.[0]).toBe("publish/" + selection["requestId"]);
  });
  it.each(["published", "network", "definitive-rejection"] as const)(
    "preserves a changed-source UUID through GET404 and exact original POST until %s",
    async (outcome) => {
      const { selection } = await startUncertain();
      await newerSavedSources();
      const receipt = sessionStorage.getItem("forge-publish:v1:alice:p1"),
        uuid = vi.spyOn(crypto, "randomUUID"),
        saveSpy = vi.spyOn(controller, "save");
      let observed: string | null = null;
      mock.hono.mockImplementation(async (path, init) => {
        if (path.startsWith("publish/"))
          return Response.json({ error: "publish_not_found" }, { status: 404 });
        if (!init?.body) return Response.json(ready);
        observed = sessionStorage.getItem("forge-publish:v1:alice:p1");
        if (outcome === "network") throw new TypeError("Lost retry");
        if (outcome === "definitive-rejection")
          return Response.json({ error: "publish_project_conflict" }, { status: 409 });
        return responseJob(init.body);
      });
      fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
      if (outcome === "published")
        await screen.findByRole("link", {
          name: "Otvoriť publikáciu predchádzajúcej verzie",
        });
      else await screen.findByRole("alert");
      await waitFor(() => expect(observed).not.toBeNull());
      expect(observed).toBe(receipt);
      const bodies = mock.hono.mock.calls
        .filter(([, init]) => init?.body)
        .map(([, init]) => init.body);
      expect(bodies).toEqual([selection, selection]);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(uuid).not.toHaveBeenCalled();
      if (outcome === "network")
        expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBe(receipt);
      else {
        expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBeNull();
        expect(screen.getByRole("checkbox")).not.toBeChecked();
      }
    },
  );
  it("rejects a bad server revision while recovering a different current revision", async () => {
    const { selection } = await startUncertain();
    await newerSavedSources();
    const receipt = sessionStorage.getItem("forge-publish:v1:alice:p1");
    mock.hono.mockImplementation(async () => Response.json({ ...job(selection), revision: 999 }));
    fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Výsledok patrí inej verzii"),
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBe(receipt);
  });
  it("keeps a newer receipt when an older recovered publication completes", async () => {
    const { selection } = await startUncertain();
    await newerSavedSources();
    let finish!: (response: Response) => void;
    mock.hono.mockImplementation(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const replacement = JSON.stringify({
      ...selection,
      requestId: crypto.randomUUID(),
    });
    sessionStorage.setItem("forge-publish:v1:alice:p1", replacement);
    await act(async () => finish(responseJob(selection)));
    await screen.findByRole("link", {
      name: "Otvoriť publikáciu predchádzajúcej verzie",
    });
    expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBe(replacement);
  });
  it.each(["workspace", "project", "account"] as const)(
    "does not clear or display old recovery after a further %s change",
    async (change) => {
      const { view, selection } = await startUncertain();
      await newerSavedSources();
      const receipt = sessionStorage.getItem("forge-publish:v1:alice:p1");
      let finish!: (response: Response) => void;
      mock.hono.mockImplementation(async (path) =>
        path === "publish"
          ? Response.json(ready)
          : new Promise<Response>((resolve) => {
              finish = resolve;
            }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      if (change === "workspace") act(() => controller.rename("Further change"));
      else if (change === "project") await act(async () => controller.newProject());
      else {
        const alice = controller,
          own = alice.get();
        controller = new ForgeController(
          "bob",
          async () => Response.json({ defaultId: null, models: [] }),
          {
            read: async () => ({
              id: "p1",
              revision: own.revision,
              workspace: own.workspace,
              dirty: false,
            }),
            write: async () => {},
          },
        );
        await controller.start();
        view.rerender(
          <ForgeContext.Provider value={controller}>
            <ForgePublish />
          </ForgeContext.Provider>,
        );
        alice.dispose();
        sessionStorage.setItem(
          "forge-publish:v1:bob:p1",
          JSON.stringify({ ...selection, requestId: crypto.randomUUID() }),
        );
      }
      const bobReceipt = sessionStorage.getItem("forge-publish:v1:bob:p1");
      await act(async () => finish(responseJob(selection)));
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBe(receipt);
      expect(sessionStorage.getItem("forge-publish:v1:bob:p1")).toBe(bobReceipt);
    },
  );
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
    expect(bodies[1]).toMatchObject({
      projectId: "p1",
      expectedRevision: 2,
      snapshotId: "v1",
    });
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
    const replacement = JSON.stringify({
      ...body,
      requestId: crypto.randomUUID(),
    });
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
    const link = await screen.findByRole("link", {
      name: "Otvoriť publikovanú aplikáciu",
    });
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
  it("reopens the current saved version with its verified public link and hides it after editing", async () => {
    await controller.save();
    save.mockClear();
    const storedJob = job({
      requestId: crypto.randomUUID(),
      projectId: "p1",
      snapshotId: "v1",
      expectedRevision: 2,
    });
    mock.hono.mockImplementation(async (path) =>
      path === "publish" ? Response.json(ready) : Response.json(storedJob),
    );
    show();
    await open();
    const restored = await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    expect(restored).toHaveAttribute("href", storedJob.url);
    expect(mock.hono.mock.calls.map(([path]) => path)).toEqual([
      "publish",
      "publish/project/p1/2/v1",
    ]);
    expect(mock.hono.mock.calls[1]?.[1]).toMatchObject({ expectedUserId: "alice" });
    expect(mock.hono.mock.calls.every(([, init]) => !init?.body)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    act(() => controller.rename("Edited current workspace"));
    expect(screen.queryByRole("link", { name: "Otvoriť publikovanú aplikáciu" })).toBeNull();
  });
  it("ignores a publication lookup that belongs to another saved version", async () => {
    await controller.save();
    mock.hono.mockImplementation(async (path) =>
      path === "publish"
        ? Response.json(ready)
        : responseJob({
            requestId: crypto.randomUUID(),
            projectId: "p1",
            snapshotId: "another-snapshot",
            expectedRevision: 2,
          }),
    );
    show();
    await open();
    await waitFor(() => expect(mock.hono).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "Otvoriť publikovanú aplikáciu" })).toBeNull();
    consent();
    expect(screen.getByRole("button", { name: "Publikovať verejne" })).toBeEnabled();
  });
  it("rechecks unavailable hosting in place without saving or submitting a publication", async () => {
    let resolveRetry!: (response: Response) => void;
    mock.hono.mockRejectedValueOnce(new Error("private upstream response")).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Publikovať" }));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Dostupnosť publikačnej služby sa nepodarilo overiť.");
    expect(error).not.toHaveTextContent("private upstream response");
    const refresh = screen.getByRole("button", { name: "Obnoviť dostupnosť" });
    fireEvent.click(refresh);
    expect(screen.getByText("Overujem publikačnú službu…")).toBeInTheDocument();
    expect(refresh).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publikovať verejne" })).toBeDisabled();

    await act(async () => resolveRetry(Response.json(ready)));
    expect(screen.getByText("Publikačná služba je pripravená.")).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Publikovať verejne" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("forge-publish:v1:alice:p1")).toBeNull();
    expect(mock.hono.mock.calls.map(([path, init]) => [path, init?.body])).toEqual([
      ["publish", undefined],
      ["publish", undefined],
    ]);
    expect(mock.hono.mock.calls[1]?.[1].expectedUserId).toBe("alice");
  });
  it("keeps an earlier receipt separate from hosting refresh and available during a build outage", async () => {
    const { selection } = await startUncertain();
    const key = "forge-publish:v1:alice:p1";
    const receipt = sessionStorage.getItem(key);
    const callsBeforeRefresh = mock.hono.mock.calls.length;
    mock.hono.mockImplementation(async (path, init) =>
      path === "publish" && !init?.body
        ? Response.json({ ...ready, ready: false, reason: "sandbox_unavailable" })
        : responseJob(selection),
    );

    fireEvent.click(screen.getByRole("button", { name: "Obnoviť dostupnosť" }));
    await screen.findByText("Izolovaný build teraz nie je pripravený.");
    expect(sessionStorage.getItem(key)).toBe(receipt);
    expect(mock.hono.mock.calls.slice(callsBeforeRefresh).map(([path]) => path)).toEqual([
      "publish",
    ]);
    expect(screen.getByRole("button", { name: "Publikovať verejne" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Overiť stav" }));
    await screen.findByRole("link", { name: "Otvoriť publikovanú aplikáciu" });
    expect(mock.hono.mock.calls.at(-1)?.[0]).toBe("publish/" + selection["requestId"]);
    expect(sessionStorage.getItem(key)).toBeNull();
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
      if (path.startsWith("publish/"))
        return Response.json({ error: "publish_not_found" }, { status: 404 });
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
      if (path === "publish/" + selection["requestId"])
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
      "publish/" + selection["requestId"],
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
