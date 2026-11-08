// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { newDb } from "pg-mem";
import { Hono } from "hono";
import { dbFromPool, type DbLike } from "../../../server/db/pool";
import { applyMigrations } from "../../../server/db/migrate";
import { registerProjectByteLength } from "../../helpers/projectMemoryDb";
import { makeAuthMiddleware } from "../../../server/auth/middleware";
import { signToken } from "../../../server/auth/tokens";
import { PublishService } from "../../../server/publish/service";
import { publishRouter } from "../../../server/publish/routes";
import { publicPublishApp } from "../../../server/publish/public";
import {
  readPublishConfig,
  validatePublishConfig,
  type PublishConfig,
} from "../../../server/publish/config";
import {
  HostExecutor,
  type SandboxExecutor,
} from "../../../server/sandbox/executor";
import { BLUEPRINT_REGISTRY } from "../../../src/templates/registry";
import type { PublishSelection } from "../../../shared/publish";
const secret = "publish-test-auth-secret-01234567890123456789";
describe("real static publication from owned saved snapshot", () => {
  let directory: string,
    db: DbLike,
    close: () => Promise<void>,
    service: PublishService,
    app: Hono,
    publicApp: Hono,
    selection: PublishSelection,
    token: string,
    config: PublishConfig,
    execute: ReturnType<typeof vi.fn<SandboxExecutor["execute"]>>;
  const request = (
    body: unknown = selection,
    headers: Record<string, string> = {},
  ) =>
    app.request("/api/publish", {
      method: "POST",
      headers: {
        Cookie: "lov_token=" + token + "; lov_csrf=publish-csrf",
        "X-CSRF-Token": "publish-csrf",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "lov-publish-unit-"));
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    db = dbFromPool(pool);
    close = () => pool.end();
    await applyMigrations(db);
    for (const id of ["alice", "bob"])
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
        [id, id + "@example.test", "not-a-login-hash"],
      );
    const files = BLUEPRINT_REGISTRY[1].files.map((f) => ({
        name: f.path,
        content: f.content,
      })),
      workspace = {
        title: "Actual publication",
        isPublic: false,
        liveId: "snapshot-one",
        files,
        snapshots: [
          {
            id: "snapshot-one",
            v: 1,
            prompt: "source",
            kind: "manual",
            time: "test",
            html: "<main>source</main>",
            sourceFiles: JSON.stringify(files),
          },
        ],
      };
    await db.query(
      "INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)",
      ["alice", "project-one", workspace.title, JSON.stringify(workspace)],
    );
    token = await signToken(
      { sub: "alice", email: "alice@example.test", plan: "free" },
      secret,
    );
    config = {
      baseUrl: "http://127.0.0.1:8791/",
      appUrl: "http://localhost:5176/",
      artifactDir: directory,
      bind: "127.0.0.1",
      port: 8791,
      maxArtifacts: 20,
      maxOwnerBytes: 30000000,
      maxArtifactBytes: 3000000,
      allowHostTest: true,
    };
    const host = new HostExecutor();
    execute = vi.fn(host.execute.bind(host));
    service = new PublishService(db, config, {
      ready: host.ready.bind(host),
      execute,
    });
    app = new Hono();
    app.use("/api/*", makeAuthMiddleware(secret, undefined, undefined, db));
    app.route(
      "/",
      publishRouter(service, () => true),
    );
    publicApp = publicPublishApp(config, db, service.artifacts);
    selection = {
      requestId: randomUUID(),
      projectId: "project-one",
      expectedRevision: 1,
      snapshotId: "snapshot-one",
      publicConsent: true,
    };
  });
  afterEach(async () => {
    await service?.settled();
    await close?.();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it("is default-off and rejects same-host cookie sharing, unsafe origins and artifact directories", () => {
    expect(readPublishConfig({})).toBeNull();
    expect(() =>
      validatePublishConfig({ ...config, baseUrl: "http://localhost:8791/" }),
    ).toThrow();
    expect(() =>
      validatePublishConfig({ ...config, artifactDir: process.cwd() }),
    ).toThrow();
    expect(() =>
      validatePublishConfig({
        ...config,
        baseUrl: "https://user:pass@publish.example.test/",
      }),
    ).toThrow();
  });
  it("uses the client contract for invalid IDs, unknown jobs and exhausted capacity", async () => {
    const invalid = await request({ ...selection, requestId: "11111111-1111-7111-8111-111111111111" });
    expect(invalid.status).toBe(400);
    const missing = await app.request("/api/publish/" + selection.requestId, {
      headers: { Cookie: "lov_token=" + token },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    smallService(1000, db, 1);
    app = new Hono();
    app.use("/api/*", makeAuthMiddleware(secret, undefined, undefined, db));
    app.route("/", publishRouter(service, () => true));
    execute.mockResolvedValue(failed);
    expect((await request()).status).toBe(201);
    await service.settled();
    const quota = await request({ ...selection, requestId: randomUUID() });
    expect(quota.status).toBe(413);
    expect(await quota.json()).toEqual({ error: "publish_quota_exceeded" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("compiles saved React sources, persists an immutable artifact and serves a real public HTML response", async () => {
    const response = await request();
    expect(response.status).toBe(201);
    const started = await response.json();
    expect(started).toMatchObject({
      state: "building",
      url: null,
      revision: 1,
      snapshotId: "snapshot-one",
    });
    await service.settled();
    const published = await service.status("alice", selection.requestId);
    expect(published.state).toBe("published");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(published.artifactBytes).toBeGreaterThan(1000);
    const served = await publicApp.request(published.url!, {
      headers: {
        Host: "127.0.0.1:8791",
        Cookie: "lov_token=must-never-be-used",
      },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("text/html");
    expect(served.headers.get("set-cookie")).toBeNull();
    expect(served.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(served.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(await served.text()).toContain('<div id="root">');
    const head = await publicApp.request(published.url!, {
      method: "HEAD",
      headers: { Host: "127.0.0.1:8791", Cookie: "lov_token=unused" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(published.artifactBytes),
    );
    expect(head.headers.get("set-cookie")).toBeNull();
    expect(head.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(await head.text()).toBe("");
    const row = (
      await db.query(
        "SELECT artifact_id,artifact_bytes FROM publish_jobs WHERE request_id=$1",
        [selection.requestId],
      )
    ).rows[0];
    expect(
      (await readFile(path.join(directory, row.artifact_id + ".html")))
        .byteLength,
    ).toBe(Number(row.artifact_bytes));
  });
  it("returns a published link only for the owner's current saved revision and snapshot", async () => {
    const path = "/api/publish/project/project-one/1/snapshot-one";
    const lookup = (url = path, session = token) =>
      app.request(url, { headers: { Cookie: "lov_token=" + session } });
    expect(await (await lookup()).json()).toBeNull();
    expect((await request()).status).toBe(201);
    await service.settled();
    const published = await lookup();
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toBe("no-store");
    expect(await published.json()).toMatchObject({
      requestId: selection.requestId,
      revision: 1,
      snapshotId: "snapshot-one",
      state: "published",
    });

    const bob = await signToken(
      { sub: "bob", email: "bob@example.test", plan: "free" },
      secret,
    );
    expect((await app.request(path)).status).toBe(401);
    expect(await (await lookup(path, bob)).json()).toBeNull();
    expect(await (await lookup(path.replace("snapshot-one", "other"))).json()).toBeNull();
    expect((await lookup(path.replace("/1/", "/2147483648/"))).status).toBe(400);
    expect((await lookup(path + "?owner=bob")).status).toBe(400);
    await db.query(
      "UPDATE builder_projects SET revision=2 WHERE owner_id=$1 AND project_id=$2",
      ["alice", "project-one"],
    );
    expect(await (await lookup()).json()).toBeNull();
    expect(await (await lookup(path.replace("/1/", "/2/"))).json()).toBeNull();
    await db.query(
      "UPDATE builder_projects SET revision=1, deleted_at=NOW() WHERE owner_id=$1 AND project_id=$2",
      ["alice", "project-one"],
    );
    expect(await (await lookup()).json()).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("never accepts client HTML, a client URL or missing public consent", async () => {
    for (const body of [
      { ...selection, publicConsent: false },
      { ...selection, html: "<h1>injected</h1>" },
      { ...selection, url: "https://evil.example/" },
    ])
      expect((await request(body)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects unowned, stale revision or missing snapshot selections before building", async () => {
    const { workspace } = (await db.query(
      "SELECT workspace FROM builder_projects WHERE owner_id=$1 AND project_id=$2",
      ["alice", selection.projectId],
    )).rows[0];
    const history = {
      ...workspace.snapshots[0],
      id: "snapshot-history",
      v: 2,
    };
    await db.query("UPDATE builder_projects SET workspace=$1::jsonb WHERE project_id=$2", [
      JSON.stringify({ ...workspace, snapshots: [...workspace.snapshots, history] }),
      selection.projectId,
    ]);
    for (const [fields, status, error] of [
      [{ projectId: "foreign" }, 404, "publish_project_not_found"],
      [{ expectedRevision: 2 }, 409, "publish_project_conflict"],
      [{ snapshotId: "missing" }, 409, "publish_snapshot_sources_required"],
      [{ snapshotId: history.id }, 409, "publish_snapshot_sources_required"],
    ] as const) {
      const response = await request({ ...selection, ...fields });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
    expect(execute).not.toHaveBeenCalled();
    const bob = await signToken(
      { sub: "bob", email: "bob@example.test", plan: "free" },
      secret,
    );
    expect(
      (
        await request(selection, {
          Cookie: "lov_token=" + bob + "; lov_csrf=publish-csrf",
        })
      ).status,
    ).toBe(404);
  });
  it("requires cookie CSRF and does not build or publish for anonymous callers", async () => {
    expect(
      (
        await app.request("/api/publish", {
          method: "POST",
          body: JSON.stringify(selection),
        })
      ).status,
    ).toBe(401);
    expect((await request(selection, { "X-CSRF-Token": "wrong" })).status).toBe(
      403,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  const smallHtml = "<main>retained publication</main>";
  const compiled = { ok: true, html: smallHtml, errors: [], durationMs: 1, moduleCount: 1 };
  const failed = { ok: false, html: null, errors: [], durationMs: 1, moduleCount: 0 };
  function smallService(maxOwnerBytes = 1000, database = db, maxArtifacts = 20) {
    service = new PublishService(database, { ...config, maxArtifacts, maxArtifactBytes: 1000, maxOwnerBytes, minFreeBytes: 0 }, {
      ready: async () => ({ ready: true, mode: "host" }), execute,
    });
    return service;
  }
  it("releases compiler failure bytes and preserves a configured attempt cap above twenty", async () => {
    smallService(1000, db, 21); execute.mockResolvedValue(failed);
    for (let index = 0; index < 20; index++) {
      await service.start("alice", { ...selection, requestId: randomUUID() });
      await service.settled();
    }
    expect((await db.query("SELECT state FROM publish_jobs WHERE owner_id='alice'")).rows).toHaveLength(20);
    expect((await db.query("SELECT state FROM publish_jobs WHERE owner_id='alice'")).rows.every(row => row.state === "failed")).toBe(true);
    execute.mockResolvedValue(compiled);
    const next = { ...selection, requestId: randomUUID() };
    await service.start("alice", next); await service.settled();
    expect((await service.status("alice", next.requestId)).state).toBe("published");
    await expect(service.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
    expect(execute).toHaveBeenCalledTimes(21);
  });
  it("keeps a full byte reservation for an in-flight build", async () => {
    smallService(); let release!: (value: typeof compiled) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    try {
      await service.start("alice", selection);
      await expect(service.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { release(compiled); await service.settled(); }
  });
  it("charges published bytes instead of another full artifact reservation", async () => {
    smallService(1000 + Buffer.byteLength(smallHtml)); execute.mockResolvedValue(compiled);
    for (let index = 0; index < 2; index++) {
      await service.start("alice", { ...selection, requestId: randomUUID() }); await service.settled();
    }
    await expect(service.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("keeps a successful put charged after the publication database update fails", async () => {
    let failPublication = true;
    const broken: DbLike = { query: db.query, transaction: work => db.transaction!(tx => work({ query: async (sql, params) => {
      if (failPublication && sql.startsWith("UPDATE publish_jobs SET state='published'")) { failPublication = false; throw new Error("private-db-failure"); }
      return tx.query(sql, params);
    } })) };
    smallService(1000 + Buffer.byteLength(smallHtml) - 1, broken); execute.mockResolvedValue(compiled);
    await service.start("alice", selection); await service.settled();
    const orphan = (await db.query("SELECT artifact_id,state,artifact_bytes FROM publish_jobs WHERE request_id=$1", [selection.requestId])).rows[0];
    expect(orphan).toMatchObject({ state: "failed", artifact_bytes: Buffer.byteLength(smallHtml) });
    expect(await readFile(path.join(directory, orphan.artifact_id + ".html"), "utf8")).toBe(smallHtml);
    expect(await service.status("alice", selection.requestId)).toMatchObject({ state: "failed", url: null });
    await expect(service.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
    smallService(1000 + Buffer.byteLength(smallHtml), broken);
    const next = { ...selection, requestId: randomUUID() };
    await service.start("alice", next); await service.settled();
    expect((await service.status("alice", next.requestId)).state).toBe("published");
  });
  it("keeps uncertain temp/final writes conservatively charged without admission inventory", async () => {
    smallService(1999); execute.mockResolvedValueOnce(failed);
    await service.start("alice", selection); await service.settled();
    const id = (await db.query("SELECT artifact_id FROM publish_jobs WHERE request_id=$1", [selection.requestId])).rows[0].artifact_id;
    const temporary = path.join(directory, "." + id + "." + randomUUID() + ".tmp");
    await writeFile(temporary, Buffer.alloc(80));
    await link(temporary, path.join(directory, id + ".html"));
    expect((await service.artifacts.retainedBytes([id])).get(id)).toBe(80);
    await db.query("UPDATE publish_jobs SET storage_phase='writing',artifact_bytes=1000 WHERE request_id=$1", [selection.requestId]);
    const inventory = vi.spyOn(service.artifacts, "retainedBytes");
    await expect(service.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
    expect(inventory).not.toHaveBeenCalled();
    smallService(2000); execute.mockResolvedValue(compiled);
    const next = { ...selection, requestId: randomUUID() };
    await service.start("alice", next); await service.settled();
    expect((await service.status("alice", next.requestId)).state).toBe("published");
    expect(await readFile(temporary)).toHaveLength(80); // No orphan cleanup/deletion.
  });
  it.each(["symlink", "directory"])("keeps diagnostics and legacy recovery fail-closed for an owned %s", async kind => {
    smallService(); execute.mockResolvedValueOnce(failed);
    await service.start("alice", selection); await service.settled();
    const id = (await db.query("SELECT artifact_id FROM publish_jobs WHERE request_id=$1", [selection.requestId])).rows[0].artifact_id;
    const target = path.join(directory, id + ".html");
    if (kind === "directory") await mkdir(target);
    else { const file = path.join(directory, "unrelated"); await writeFile(file, "private"); await symlink(file, target); }
    await expect(service.artifacts.retainedBytes([id])).rejects.toMatchObject({ code: "publish_storage_unavailable" });
    await db.query("UPDATE publish_jobs SET storage_phase='legacy_unknown' WHERE request_id=$1", [selection.requestId]);
    await expect(service.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_storage_recovery_required" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not inspect a different owner's unknown or symlinked UUID", async () => {
    smallService(); execute.mockResolvedValueOnce(failed);
    await service.start("alice", selection); await service.settled();
    await symlink("/does-not-exist", path.join(directory, randomUUID() + ".html"));
    execute.mockResolvedValue(compiled);
    const next = { ...selection, requestId: randomUUID() };
    await service.start("alice", next); await service.settled();
    expect((await service.status("alice", next.requestId)).state).toBe("published");
  });
  it("reserves failed attempts against the same durable account cap", async () => {
    service = new PublishService(
      db,
      { ...config, maxArtifacts: 1 },
      { ready: async () => ({ ready: true, mode: "host" }), execute },
    );
    execute.mockResolvedValueOnce({
      ok: false,
      html: null,
      errors: [],
      durationMs: 1,
      moduleCount: 0,
    });
    await service.start("alice", selection);
    await service.settled();
    await expect(
      service.start("alice", { ...selection, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "publish_capacity" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("fails readiness before compiling when the configured free-space floor cannot be met", async () => {
    service = new PublishService(
      db,
      { ...config, minFreeBytes: Number.MAX_SAFE_INTEGER },
      { ready: async () => ({ ready: true, mode: "host" }), execute },
    );
    expect(await service.ready()).toMatchObject({
      ready: false,
      reason: "storage_unavailable",
    });
    await expect(service.start("alice", selection)).rejects.toMatchObject({
      code: "publish_storage_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("reuses the same request and refuses changed selection under its UUID", async () => {
    await request();
    await service.settled();
    const first = await service.status("alice", selection.requestId);
    expect((await request()).status).toBe(200);
    expect(await service.status("alice", selection.requestId)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await request({ ...selection, expectedRevision: 2 })).status).toBe(
      409,
    );
  });
  it("fails closed when the isolated compiler is not ready and never invokes a host fallback", async () => {
    service = new PublishService(
      db,
      {
        ...config,
        baseUrl: "https://public.example.test/",
        appUrl: "https://app.example.test/",
        allowHostTest: false,
      },
      { ready: async () => ({ ready: true, mode: "host" }), execute },
    );
    await expect(service.start("alice", selection)).rejects.toMatchObject({
      code: "publish_sandbox_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps build failures private and produces no successful public URL", async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      html: null,
      errors: [{ file: "src/main.tsx", message: "Syntax error" }],
      durationMs: 1,
      moduleCount: 1,
    });
    await request();
    await service.settled();
    expect(await service.status("alice", selection.requestId)).toMatchObject({
      state: "failed",
      url: null,
      error: "publish_build_failed",
      errors: [{ file: "src/main.tsx", message: "Syntax error" }],
    });
  });
  it("does not expose artifacts on an application Host, an API path or a mutating public request", async () => {
    await request();
    await service.settled();
    const job = await service.status("alice", selection.requestId);
    expect(
      (
        await publicApp.request(job.url!, {
          headers: { Host: "localhost:5176" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await publicApp.request("http://127.0.0.1:8791/api/auth/me", {
          headers: { Host: "127.0.0.1:8791" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await publicApp.request(job.url!, {
          method: "POST",
          headers: { Host: "127.0.0.1:8791" },
        })
      ).status,
    ).toBe(404);
  });
  it("checks immutable disk bytes against the durable published digest", async () => {
    await request();
    await service.settled();
    const published = await service.status("alice", selection.requestId),
      id = new URL(published.url!).pathname.split("/")[2];
    await writeFile(path.join(directory, id + ".html"), "changed disk");
    expect(
      (
        await publicApp.request(published.url!, {
          headers: { Host: "127.0.0.1:8791" },
        })
      ).status,
    ).toBe(404);
  });
  it("refuses symlinked artifacts instead of reading an arbitrary server file", async () => {
    await request();
    await service.settled();
    const published = await service.status("alice", selection.requestId),
      id = new URL(published.url!).pathname.split("/")[2],
      target = path.join(directory, id + ".html");
    await rm(target);
    await symlink("/etc/passwd", target);
    expect(
      (
        await publicApp.request(published.url!, {
          headers: { Host: "127.0.0.1:8791" },
        })
      ).status,
    ).toBe(404);
  });
});
