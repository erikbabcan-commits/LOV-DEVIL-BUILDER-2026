import { afterEach, expect, it, vi } from "vitest";
import {
  listExportProjects,
  prepareGitHubExport,
  reviewGitHubExport,
  updateGitHubExport,
} from "./github-export";
afterEach(() => vi.unstubAllGlobals());
it("loads owned projects through the fixed Hono proxy and strips extra fields", async () => {
  const api = vi.fn().mockResolvedValue(
    Response.json({
      projects: [{ id: "p1", title: "Own project", revision: 2, secret: "not-for-UI" }],
      nextCursor: null,
    }),
  );
  vi.stubGlobal("fetch", api);
  expect(await listExportProjects("cloud-token", "", AbortSignal.timeout(1000))).toEqual({
    projects: [{ id: "p1", title: "Own project", revision: 2 }],
    nextCursor: null,
  });
  expect(api.mock.calls[0]).toEqual([
    "/api/hono/projects",
    expect.objectContaining({
      credentials: "omit",
      headers: { Authorization: "Bearer cloud-token" },
    }),
  ]);
});
it("does not expose malformed response payloads or accept an external repository URL", async () => {
  const value = {
    requestId: "9553d200-294f-445e-94b8-c29f419da38a",
    username: "fixture",
    repoName: "export",
    fingerprint: "ab".repeat(32),
    status: "succeeded",
    result: {
      ok: true,
      repositoryId: 99,
      repoFullName: "fixture/export",
      repoUrl: "https://attacker.test/private-value",
      commitSha: "a".repeat(40),
      filesUploaded: 1,
    },
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
  await expect(
    updateGitHubExport(
      "cloud",
      "status",
      { requestId: value.requestId },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("Server vrátil neplatnú odpoveď");
});
it("returns a product message for provider failures rather than raw response details", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "sensitive-provider-error", debug: "private" }, { status: 503 }),
      ),
  );
  await expect(prepareGitHubExport("cloud", {}, AbortSignal.timeout(1000))).rejects.toThrow(
    "Export momentálne nie je dostupný",
  );
});
it("restores only public review metadata through the fixed same-origin BFF", async () => {
  const requestId = "9553d200-294f-445e-94b8-c29f419da38a";
  const value = {
    requestId,
    username: "fixture",
    repoName: "export",
    fingerprint: "ab".repeat(32),
    status: "prepared",
    result: null,
    visibility: "public",
    title: "Project",
    version: 1,
    selection: { projectId: "p1", snapshotId: "s1", expectedRevision: 2 },
    files: [{ path: "index.html", bytes: 42 }],
    token: "must-be-stripped",
  };
  const api = vi.fn().mockResolvedValue(Response.json(value));
  vi.stubGlobal("fetch", api);
  expect(
    await reviewGitHubExport("cloud", requestId, AbortSignal.timeout(1000)),
  ).not.toHaveProperty("token");
  expect(api.mock.calls[0]).toEqual([
    "/api/github-connect/export/review",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ requestId }),
    }),
  ]);
});
it("requests read-only result reconciliation with only the job UUID", async () => {
  const requestId = "9553d200-294f-445e-94b8-c29f419da38a";
  const api = vi.fn().mockResolvedValue(
    Response.json({
      requestId,
      username: "fixture",
      repoName: "export",
      fingerprint: "ab".repeat(32),
      status: "running",
      result: null,
      checkpoint: { private: "not-for-ui" },
    }),
  );
  vi.stubGlobal("fetch", api);
  expect(
    await updateGitHubExport("cloud", "reconcile", { requestId }, AbortSignal.timeout(1000)),
  ).not.toHaveProperty("checkpoint");
  expect(api.mock.calls[0]).toEqual([
    "/api/github-connect/export/reconcile",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ requestId }),
    }),
  ]);
});
