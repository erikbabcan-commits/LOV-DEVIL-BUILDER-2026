// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFromPool, type DbLike } from "../../server/db/pool";
import { applyMigrations } from "../../server/db/migrate";
import { makeAuthMiddleware } from "../../server/auth/middleware";
import { signToken } from "../../server/auth/tokens";
import { PublishService } from "../../server/publish/service";
import { publishRouter } from "../../server/publish/routes";
import { publicPublishApp } from "../../server/publish/public";
import type { PublishConfig } from "../../server/publish/config";
import { HostExecutor, type SandboxExecutor } from "../../server/sandbox/executor";
import type { BuildResult } from "../../server/sandbox/policy";
import { BLUEPRINT_REGISTRY } from "../../src/templates/registry";
import type { PublishSelection } from "../../shared/publish";

const secret = "native-publish-test-secret-01234567890123456789";
const output: BuildResult = {
  ok: true, html: "<!doctype html><main>Native publish recovery</main>",
  errors: [], durationMs: 1, moduleCount: 1,
};

describe.skipIf(process.env.PROJECTS_PG_E2E !== "1")("dedicated PostgreSQL publication", () => {
  let db: DbLike, pool: Pool, admin: Pool, schema: string, directory: string;
  let config: PublishConfig, selection: PublishSelection, alice: string, bob: string;
  let services: PublishService[], releases: Array<() => void>;

  beforeEach(async () => {
    services = []; releases = [];
    const connectionString = process.env.PROJECTS_TEST_DATABASE_URL;
    if (!connectionString || !["127.0.0.1", "localhost"].includes(new URL(connectionString).hostname))
      throw new Error("Dedicated loopback test database required");
    schema = "lov_publish_" + randomUUID().replaceAll("-", "");
    admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({ connectionString, options: "-c search_path=" + schema, max: 5, statement_timeout: 10000, connectionTimeoutMillis: 5000 });
    db = dbFromPool(pool);
    await applyMigrations(db);
    for (const id of ["alice", "bob"])
      await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [id, id + "@publish-native.example.test", "not-a-password"]);
    const files = BLUEPRINT_REGISTRY[1].files.map(({ path, content }) => ({ name: path, content }));
    const workspace = {
      title: "Native publication", isPublic: false, liveId: "snapshot-one", files,
      snapshots: [{ id: "snapshot-one", v: 1, prompt: "saved source", kind: "manual", time: "test", html: "<main>saved</main>", sourceFiles: JSON.stringify(files) }],
    };
    await db.query("INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)", ["alice", "project-one", workspace.title, JSON.stringify(workspace)]);
    alice = await signToken({ sub: "alice", email: "alice@publish-native.example.test", plan: "free" }, secret);
    bob = await signToken({ sub: "bob", email: "bob@publish-native.example.test", plan: "free" }, secret);
    directory = await mkdtemp(path.join(tmpdir(), "lov-publish-native-"));
    config = { baseUrl: "http://127.0.0.1:8791/", appUrl: "http://localhost:5176/", artifactDir: directory, bind: "127.0.0.1", port: 8791, maxArtifacts: 20, maxOwnerBytes: 30000000, maxArtifactBytes: 3000000, minFreeBytes: 0, allowHostTest: true };
    selection = { requestId: randomUUID(), projectId: "project-one", expectedRevision: 1, snapshotId: "snapshot-one", publicConsent: true };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External HTTP forbidden in native publish tests"); }));
  }, 60000);

  afterEach(async () => {
    for (const release of releases ?? []) release();
    try {
      await Promise.all((services ?? []).map(service => service.settled()));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals(); vi.restoreAllMocks();
      await pool?.end();
      if (admin) {
        try { if (schema) await admin.query("DROP SCHEMA " + schema + " CASCADE"); }
        finally { await admin.end(); }
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60000);

  function service(compiler: SandboxExecutor, overrides: Partial<PublishConfig> = {}) {
    const value = new PublishService(db, { ...config, ...overrides }, compiler);
    services.push(value);
    return value;
  }
  function deferredCompiler() {
    let resolve!: (result: BuildResult) => void;
    const promise = new Promise<BuildResult>(done => { resolve = done; });
    const release = () => resolve(output);
    releases.push(release);
    return {
      ready: async () => ({ ready: true, mode: "isolated" as const }),
      execute: vi.fn<SandboxExecutor["execute"]>(() => promise), release,
    };
  }
  function api(value: PublishService) {
    const app = new Hono();
    app.use("/api/*", makeAuthMiddleware(secret, undefined, undefined, db));
    app.route("/", publishRouter(value, () => true));
    return app;
  }
  const headers = (token: string) => ({ Cookie: "lov_token=" + token + "; lov_csrf=publish-native-csrf", "X-CSRF-Token": "publish-native-csrf", "Content-Type": "application/json" });

  it("builds real saved React sources and serves the verified artifact from the separate public listener", async () => {
    const host = new HostExecutor(), value = service(host), app = api(value);
    const started = await app.request("/api/publish", { method: "POST", headers: headers(alice), body: JSON.stringify(selection) });
    expect(started.status).toBe(202);
    await value.settled();
    const published = await value.status("alice", selection.requestId);
    expect(published.state).toBe("published");
    expect(published.artifactBytes).toBeGreaterThan(1000);
    const publicApp = publicPublishApp(config, db, value.artifacts);
    const response = await publicApp.request(published.url!, { headers: { Host: "127.0.0.1:8791", Cookie: "lov_token=must-not-be-used" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(await response.text()).toContain('<div id="root">');
    expect((await publicApp.request(published.url!, { headers: { Host: "localhost:5176" } })).status).toBe(404);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs")).rows[0].n).toBe(1);
  });

  it("serializes the same UUID across independent service instances into one durable job and one build", async () => {
    const compiler = deferredCompiler(), first = service(compiler), second = service(compiler);
    const result = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).start("alice", selection)));
    expect(result.every(job => job.state === "building" && job.requestId === selection.requestId)).toBe(true);
    expect(compiler.execute).toHaveBeenCalledTimes(1);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs")).rows[0].n).toBe(1);
    compiler.release();
    await Promise.all([first.settled(), second.settled()]);
    expect((await first.status("alice", selection.requestId)).state).toBe("published");
  });

  it("keeps status and source selection owner-bound despite a known request UUID", async () => {
    const compiler = deferredCompiler(), value = service(compiler), app = api(value);
    await value.start("alice", selection);
    expect((await app.request("/api/publish/" + selection.requestId, { headers: headers(bob) })).status).toBe(404);
    expect((await app.request("/api/publish", { method: "POST", headers: headers(bob), body: JSON.stringify(selection) })).status).toBe(404);
    expect((await app.request("/api/publish", { method: "POST", body: JSON.stringify(selection) })).status).toBe(401);
    expect((await app.request("/api/publish", { method: "POST", headers: { ...headers(alice), "X-CSRF-Token": "wrong" }, body: JSON.stringify(selection) })).status).toBe(403);
    expect(compiler.execute).toHaveBeenCalledTimes(1);
    expect((await db.query("SELECT DISTINCT owner_id FROM publish_jobs")).rows).toEqual([{ owner_id: "alice" }]);
  });

  it("reclaims a stale build only once and fences the original worker before exposing any artifact", async () => {
    const originalCompiler = deferredCompiler(), replacementCompiler = deferredCompiler();
    const original = service(originalCompiler), replacement = service(replacementCompiler), competitor = service(replacementCompiler);
    const staleWrite = vi.spyOn(original.artifacts, "put");
    await original.start("alice", selection);
    const previous = (await db.query("SELECT claim_id,artifact_id FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId])).rows[0];
    await db.query("UPDATE publish_jobs SET updated_at=$3 WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId, new Date(Date.now() - 180000).toISOString()]);
    await Promise.all([replacement.start("alice", selection), competitor.start("alice", selection)]);
    const claimed = (await db.query("SELECT claim_id,state FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId])).rows[0];
    expect(claimed.claim_id).not.toBe(previous.claim_id);
    expect(replacementCompiler.execute).toHaveBeenCalledTimes(1);
    originalCompiler.release();
    await original.settled();
    expect(staleWrite).not.toHaveBeenCalled();
    await expect(readFile(path.join(directory, previous.artifact_id + ".html"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await db.query("SELECT claim_id,state FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId])).rows[0]).toEqual({ claim_id: claimed.claim_id, state: "building" });
    const publicApp = publicPublishApp(config, db, original.artifacts);
    expect((await publicApp.request(config.baseUrl + "p/" + previous.artifact_id + "/", { headers: { Host: "127.0.0.1:8791" } })).status).toBe(404);
    replacementCompiler.release();
    await Promise.all([replacement.settled(), competitor.settled()]);
    expect((await replacement.status("alice", selection.requestId)).state).toBe("published");
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs")).rows[0].n).toBe(1);
  });

  it("releases failed compiler byte reservations but keeps the durable attempt cap", async () => {
    const compiler: SandboxExecutor = { ready: async () => ({ ready: true, mode: "isolated" }), execute: vi.fn(async () => ({ ok: false, html: null, errors: [], durationMs: 1, moduleCount: 0 })) };
    const value = service(compiler, { maxArtifacts: 3, maxArtifactBytes: 1000, maxOwnerBytes: 1000 });
    for (let index = 0; index < 3; index++) {
      await value.start("alice", { ...selection, requestId: randomUUID() }); await value.settled();
    }
    expect(compiler.execute).toHaveBeenCalledTimes(3);
    await expect(value.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs WHERE state='failed'")).rows[0].n).toBe(3);
  });
  it("retains orphan bytes after a real publication transaction rolls back", async () => {
    let fail = true;
    const interrupted: DbLike = { query: db.query, transaction: work => db.transaction!(tx => work({ query: async (sql, params) => {
      if (fail && sql.startsWith("UPDATE publish_jobs SET state='published'")) { fail = false; throw new Error("injected-local-db-failure"); }
      return tx.query(sql, params);
    } })) };
    const compiler: SandboxExecutor = { ready: async () => ({ ready: true, mode: "isolated" }), execute: vi.fn(async () => output) };
    const value = new PublishService(interrupted, { ...config, maxArtifactBytes: 1000, maxOwnerBytes: 1000 + Buffer.byteLength(output.html!) - 1 }, compiler);
    services.push(value);
    await value.start("alice", selection); await value.settled();
    const row = (await db.query("SELECT artifact_id,artifact_bytes,state FROM publish_jobs WHERE request_id=$1", [selection.requestId])).rows[0];
    expect(row).toMatchObject({ state: "failed", artifact_bytes: null });
    expect(await readFile(path.join(directory, row.artifact_id + ".html"), "utf8")).toBe(output.html);
    await expect(value.start("alice", { ...selection, requestId: randomUUID() })).rejects.toMatchObject({ code: "publish_capacity" });
    expect(compiler.execute).toHaveBeenCalledTimes(1);
  });
  it("reserves the owner capacity atomically for concurrent distinct UUIDs across service instances", async () => {
    const compiler = deferredCompiler(), first = service(compiler, { maxArtifacts: 1 }), second = service(compiler, { maxArtifacts: 1 });
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).start("alice", { ...selection, requestId: randomUUID() })));
    expect(attempts.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const denied = attempts.filter(value => value.status === "rejected");
    expect(denied).toHaveLength(7);
    for (const value of denied) {
      if (value.status === "rejected") expect(value.reason).toMatchObject({ code: "publish_capacity", status: 413 });
    }
    expect(compiler.execute).toHaveBeenCalledTimes(1);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs WHERE owner_id='alice'")).rows[0].n).toBe(1);
  });
});
