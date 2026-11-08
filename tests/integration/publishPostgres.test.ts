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
import { PublishLiveAddress, type PublishSelection } from "../../shared/publish";

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
    const versionPath = "/api/publish/project/project-one/1/snapshot-one";
    const version = await app.request(versionPath, { headers: headers(alice) });
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual(published);
    expect(await (await app.request(versionPath, { headers: headers(bob) })).json()).toBeNull();
    expect(
      await (await app.request(versionPath.replace("/1/", "/2/"), { headers: headers(alice) })).json(),
    ).toBeNull();
    const publicApp = publicPublishApp(config, db, value.artifacts);
    const response = await publicApp.request(published.url!, { headers: { Host: "127.0.0.1:8791", Cookie: "lov_token=must-not-be-used" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(await response.text()).toContain('<div id="root">');
    expect((await publicApp.request(published.url!, { headers: { Host: "localhost:5176" } })).status).toBe(404);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs")).rows[0].n).toBe(1);
  });

  it("keeps the last active publication across newer revisions, failed attempts and withdrawal", async () => {
    const compiler = {
      ready: async () => ({ ready: true, mode: "isolated" as const }),
      execute: vi.fn<SandboxExecutor["execute"]>()
        .mockResolvedValueOnce(output)
        .mockResolvedValueOnce(output)
        .mockResolvedValueOnce({ ...output, ok: false, html: null })
        .mockResolvedValueOnce(output),
    };
    let clock = Date.now();
    const value = new PublishService(db, config, compiler, { now: () => clock });
    services.push(value);
    const app = api(value);
    const latestPath = "/api/publish/project/project-one/latest";
    const lookup = (token = alice) => app.request(latestPath, { headers: headers(token) });

    expect(await (await lookup()).json()).toBeNull();
    await value.start("alice", selection);
    await value.settled();
    const first = await value.status("alice", selection.requestId);
    expect(first.state).toBe("published");

    const other = { ...selection, projectId: "project-other", requestId: randomUUID() };
    await db.query(
      `INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace)
       SELECT owner_id,$3,title,revision,workspace FROM builder_projects WHERE owner_id=$1 AND project_id=$2`,
      ["alice", selection.projectId, other.projectId],
    );
    clock += 1000;
    await value.start("alice", other);
    await value.settled();
    expect(await value.latestPublished("alice", other.projectId)).toMatchObject({
      projectId: other.projectId, requestId: other.requestId,
    });

    await db.query("UPDATE builder_projects SET revision=2 WHERE owner_id=$1 AND project_id=$2", ["alice", "project-one"]);
    clock += 1000;
    const second = { ...selection, expectedRevision: 2, requestId: randomUUID() };
    await value.start("alice", second);
    await value.settled();
    expect((await value.status("alice", second.requestId)).state).toBe("failed");
    const response = await lookup();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(first);
    const publicApp = publicPublishApp(config, db, value.artifacts);
    expect((await publicApp.request(first.url!, {
      headers: { Host: "127.0.0.1:8791" },
    })).status).toBe(200);
    expect(await (await lookup(bob)).json()).toBeNull();
    const cloud = new Hono();
    cloud.use("/api/*", makeAuthMiddleware(secret, {
      resolve: async (token) => token === "fixture.cloud.jwt"
        ? { id: "alice", email: "alice@publish-native.example.test", plan: "free" }
        : null,
    }));
    cloud.route("/", publishRouter(value, () => true));
    expect(await (await cloud.request(latestPath, {
      headers: { Authorization: "Bearer fixture.cloud.jwt" },
    })).json()).toEqual(first);
    expect((await app.request(latestPath)).status).toBe(401);
    expect((await app.request(latestPath + "?owner=bob", { headers: headers(alice) })).status).toBe(400);

    clock += 1000;
    const third = { ...second, requestId: randomUUID() };
    await value.start("alice", third);
    await value.settled();
    expect(await (await lookup()).json()).toMatchObject({ requestId: third.requestId, revision: 2 });
    await value.withdraw("alice", third.requestId);
    expect(await (await lookup()).json()).toEqual(first);
    await db.query("UPDATE builder_projects SET deleted_at=now() WHERE owner_id=$1 AND project_id=$2", ["alice", "project-one"]);
    expect(await (await lookup()).json()).toBeNull();
    expect(compiler.execute).toHaveBeenCalledTimes(4);
  });

  it("lists at most two distinct active snapshots in release order for the owner", async () => {
    const value = service({ ready: async () => ({ ready: true, mode: "isolated" }), execute: async () => output });
    await value.start("alice", selection);
    await value.settled();
    const { workspace } = (await db.query("SELECT workspace FROM builder_projects WHERE owner_id=$1 AND project_id=$2", ["alice", selection.projectId])).rows[0];
    const snapshot = { ...workspace.snapshots[0], id: "snapshot-two", v: 2, parentId: selection.snapshotId };
    await db.query("UPDATE builder_projects SET revision=2,workspace=$3::jsonb WHERE owner_id=$1 AND project_id=$2", [
      "alice", selection.projectId, JSON.stringify({ ...workspace, liveId: snapshot.id, snapshots: [...workspace.snapshots, snapshot] }),
    ]);
    const second = { ...selection, expectedRevision: 2, snapshotId: snapshot.id, requestId: randomUUID() };
    await value.start("alice", second);
    await value.settled();
    await db.query("UPDATE builder_projects SET revision=3 WHERE owner_id=$1 AND project_id=$2", ["alice", selection.projectId]);
    const duplicate = { ...second, expectedRevision: 3, requestId: randomUUID() };
    await value.start("alice", duplicate);
    await value.settled();

    const path = "/api/publish/project/project-one/releases";
    const app = api(value);
    const lookup = async (token = alice) => {
      const response = await app.request(path, { headers: headers(token) });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return (await response.json()).map(({ requestId }: { requestId: string }) => requestId);
    };
    expect(await lookup()).toEqual([duplicate.requestId, selection.requestId]);
    const [newest, previous] = await value.recentPublications("alice", selection.projectId);
    const publicApp = publicPublishApp(config, db, value.artifacts);
    const open = (url: string) => publicApp.request(url, { headers: { Host: "127.0.0.1:8791" } });
    expect((await open(newest!.url!)).status).toBe(200);
    expect((await open(previous!.url!)).status).toBe(200);
    expect(await lookup(bob)).toEqual([]);
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path + "?owner=bob", { headers: headers(alice) })).status).toBe(400);
    const cloud = new Hono();
    cloud.use("/api/*", makeAuthMiddleware(secret, {
      resolve: async () => ({ id: "alice", email: "alice@publish-native.example.test", plan: "free" }),
    }));
    cloud.route("/", publishRouter(value, () => true));
    expect((await cloud.request(path, { headers: { Authorization: "Bearer fixture.cloud.jwt" } })).status).toBe(200);
    await value.withdraw("alice", duplicate.requestId);
    expect((await open(newest!.url!)).status).toBe(404);
    expect((await open(previous!.url!)).status).toBe(200);
    expect(await lookup()).toEqual([second.requestId, selection.requestId]);
    await value.withdraw("alice", second.requestId);
    expect(await lookup()).toEqual([selection.requestId]);
  });

  it("promotes and rolls back a stable address without rebuilding or replacing version URLs", async () => {
    const execute = vi.fn<SandboxExecutor["execute"]>()
      .mockResolvedValueOnce({ ...output, html: "<main>Release one</main>" })
      .mockResolvedValueOnce({ ...output, html: "<main>Release two</main>" });
    const value = service({ ready: async () => ({ ready: true, mode: "isolated" }), execute });
    await value.start("alice", selection);
    await value.settled();
    const firstJob = await value.status("alice", selection.requestId);
    const { workspace } = (await db.query("SELECT workspace FROM builder_projects WHERE owner_id='alice' AND project_id=$1", [selection.projectId])).rows[0];
    const snapshot = { ...workspace.snapshots[0], id: "snapshot-two", v: 2, parentId: selection.snapshotId };
    await db.query("UPDATE builder_projects SET revision=2,workspace=$2::jsonb WHERE owner_id='alice' AND project_id=$1", [
      selection.projectId, JSON.stringify({ ...workspace, liveId: snapshot.id, snapshots: [...workspace.snapshots, snapshot] }),
    ]);
    const second = { ...selection, expectedRevision: 2, snapshotId: snapshot.id, requestId: randomUUID() };
    await value.start("alice", second);
    await value.settled();
    const secondJob = await value.status("alice", second.requestId);
    const app = api(value);
    const route = "/api/publish/project/project-one/live";
    const get = (token = alice) => app.request(route, { headers: headers(token) });
    const promote = (requestId: string, expectedVersion: string | null, token = alice, confirmed = true) =>
      app.request(route, { method: "POST", headers: headers(token), body: JSON.stringify({ requestId, expectedVersion, confirmed }) });
    expect(await (await get()).json()).toBeNull();
    expect((await app.request(route)).status).toBe(401);
    expect((await app.request(route, { method: "POST" })).status).toBe(401);
    expect((await promote(selection.requestId, null, bob)).status).toBe(404);
    expect((await promote(selection.requestId, null, alice, false)).status).toBe(400);
    await db.query(
      "INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) SELECT owner_id,'other-project',title,revision,workspace FROM builder_projects WHERE owner_id='alice' AND project_id=$1",
      [selection.projectId],
    );
    expect((await app.request(route.replace("project-one", "other-project"), {
      method: "POST", headers: headers(alice),
      body: JSON.stringify({ requestId: selection.requestId, expectedVersion: null, confirmed: true }),
    })).status).toBe(404);
    const [create, conflict] = await Promise.all([promote(selection.requestId, null), promote(selection.requestId, null)]);
    expect([create.status, conflict.status].sort()).toEqual([200, 409]);
    const initial = PublishLiveAddress.parse(await (create.ok ? create : conflict).json());
    expect(initial).toMatchObject({ current: { requestId: selection.requestId, revision: 1 }, previous: null });
    expect(await (await get(bob)).json()).toBeNull();
    expect((await get()).headers.get("cache-control")).toBe("no-store");
    const publicApp = publicPublishApp(config, db, value.artifacts);
    const open = (url: string, method = "GET", host = "127.0.0.1:8791") =>
      publicApp.request(url, { method, headers: { Host: host } });
    const first = await open(initial.url);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await first.text()).toContain("Release one");
    expect((await open(initial.url, "GET", "localhost:5176")).status).toBe(404);
    expect((await open(initial.url + "?v=2")).status).toBe(404);
    expect((await open(initial.url, "POST")).status).toBe(404);
    const next = PublishLiveAddress.parse(await (await promote(second.requestId, initial.version)).json());
    expect(next).toMatchObject({ url: initial.url, current: { requestId: second.requestId, revision: 2 }, previous: initial.current });
    expect(await (await open(next.url)).text()).toContain("Release two");
    const head = await open(next.url, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await promote(selection.requestId, initial.version)).status).toBe(409);
    const reverted = PublishLiveAddress.parse(await (await promote(selection.requestId, next.version)).json());
    expect(reverted).toMatchObject({ url: next.url, current: initial.current, previous: next.current });
    expect(reverted.version).not.toBe(initial.version);
    expect(await (await open(reverted.url)).text()).toContain("Release one");
    expect(await (await open(firstJob.url!)).text()).toContain("Release one");
    expect(await (await open(secondJob.url!)).text()).toContain("Release two");
    expect(execute).toHaveBeenCalledTimes(2);
    await value.withdraw("alice", selection.requestId);
    expect((await open(reverted.url)).status).toBe(404);
    expect((await open(firstJob.url!)).status).toBe(404);
    expect(await (await get()).json()).toMatchObject({ current: null, previous: next.current });
    expect((await promote(selection.requestId, reverted.version)).status).toBe(404);
    expect((await promote(second.requestId, reverted.version)).status).toBe(200);
    await db.query("UPDATE builder_projects SET deleted_at=now() WHERE owner_id='alice' AND project_id=$1", [selection.projectId]);
    expect((await open(reverted.url)).status).toBe(404);
    expect(await (await get()).json()).toBeNull();
    expect((await open(secondJob.url!)).status).toBe(200);
  });

  it("prefers a newer revision when an older build finishes later", async () => {
    let clock = Date.now();
    const olderCompiler = deferredCompiler();
    const newerCompiler = deferredCompiler();
    const older = new PublishService(db, config, olderCompiler, { now: () => clock });
    const newer = new PublishService(db, config, newerCompiler, { now: () => clock });
    services.push(older, newer);

    expect((await older.start("alice", selection)).state).toBe("building");
    await db.query(
      "UPDATE builder_projects SET revision=2 WHERE owner_id=$1 AND project_id=$2",
      ["alice", selection.projectId],
    );
    clock += 1000;
    const newerSelection = { ...selection, expectedRevision: 2, requestId: randomUUID() };
    expect((await newer.start("alice", newerSelection)).state).toBe("building");
    newerCompiler.release();
    await newer.settled();
    expect(await newer.latestPublished("alice", selection.projectId)).toMatchObject({
      requestId: newerSelection.requestId, revision: 2,
    });

    clock += 1000;
    olderCompiler.release();
    await older.settled();
    expect((await older.status("alice", selection.requestId)).state).toBe("published");
    expect(await older.latestPublished("alice", selection.projectId)).toMatchObject({
      requestId: newerSelection.requestId, revision: 2,
    });

    await newer.withdraw("alice", newerSelection.requestId);
    expect(await older.latestPublished("alice", selection.projectId)).toMatchObject({
      requestId: selection.requestId, revision: 1,
    });
  });

  it("withdraws only an owned published URL without changing its artifact or publication history", async () => {
    const compiler = deferredCompiler(), value = service(compiler), app = api(value);
    const first = await value.start("alice", selection);
    const path = "/api/publish/" + first.requestId + "/withdraw";
    const post = (token: string, body: object) => app.request(path, {
      method: "POST", headers: headers(token), body: JSON.stringify(body),
    });
    expect((await post(alice, { confirmed: true })).status).toBe(409);
    compiler.release();
    await value.settled();
    const published = await value.status("alice", first.requestId);
    expect(published.state).toBe("published");
    const publicApp = publicPublishApp(config, db, value.artifacts);
    const request = (method: "GET" | "HEAD" = "GET") => publicApp.request(published.url!, {
      method, headers: { Host: "127.0.0.1:8791", "If-Modified-Since": new Date().toUTCString() },
    });
    expect((await request()).status).toBe(200);
    expect((await post(bob, { confirmed: true })).status).toBe(404);
    expect((await post(alice, { confirmed: false })).status).toBe(400);
    expect((await request("HEAD")).status).toBe(200);

    const result = await post(alice, { confirmed: true });
    expect(result.headers.get("cache-control")).toBe("no-store");
    const withdrawn = await result.json();
    expect(withdrawn).toMatchObject({ requestId: first.requestId, state: "withdrawn", url: null });
    expect(await (await post(alice, { confirmed: true })).json()).toEqual(withdrawn);
    expect(await value.start("alice", selection)).toEqual(withdrawn);
    expect(compiler.execute).toHaveBeenCalledTimes(1);
    expect(await value.publishedVersion("alice", selection)).toBeNull();
    for (const method of ["GET", "HEAD"] as const) {
      const revoked = await request(method);
      expect(revoked.status).toBe(404);
      expect(revoked.headers.get("cache-control")).toBe("no-store");
    }
    const receipt = (await db.query(`SELECT artifact_id, artifact_sha256, artifact_bytes, storage_phase, state, withdrawn_at
      FROM publish_jobs WHERE owner_id='alice' AND request_id=$1`, [first.requestId])).rows[0];
    expect(receipt).toMatchObject({ state: "published", storage_phase: "retained", withdrawn_at: expect.any(Date) });
    expect((await value.artifacts.read(receipt.artifact_id, receipt.artifact_sha256, receipt.artifact_bytes)).toString()).toContain("Native publish recovery");
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

  it("expires a lost-receipt compile before new admission and fences the original worker before disk I/O", async () => {
    const originalCompiler = deferredCompiler(), replacementCompiler = deferredCompiler();
    const original = service(originalCompiler), replacement = service(replacementCompiler), competitor = service(replacementCompiler);
    const staleWrite = vi.spyOn(Object.getPrototypeOf(original.artifacts), "physicalPut");
    await original.start("alice", selection);
    const previous = (await db.query("SELECT claim_id,artifact_id FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId])).rows[0];
    await db.query("UPDATE publish_jobs SET updated_at=$3 WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId, new Date(Date.now() - 180000).toISOString()]);
    const fresh = { ...selection, requestId: randomUUID() };
    await replacement.start("alice", fresh);
    await competitor.start("alice", fresh);
    const claimed = (await db.query("SELECT claim_id,state FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId])).rows[0];
    expect(claimed).toEqual({ claim_id: previous.claim_id, state: "failed" });
    expect(replacementCompiler.execute).toHaveBeenCalledTimes(1);
    originalCompiler.release();
    await original.settled();
    expect(staleWrite).not.toHaveBeenCalled();
    await expect(readFile(path.join(directory, previous.artifact_id + ".html"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await db.query("SELECT claim_id,state FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", ["alice", selection.requestId])).rows[0]).toEqual({ claim_id: claimed.claim_id, state: "failed" });
    const publicApp = publicPublishApp(config, db, original.artifacts);
    expect((await publicApp.request(config.baseUrl + "p/" + previous.artifact_id + "/", { headers: { Host: "127.0.0.1:8791" } })).status).toBe(404);
    replacementCompiler.release();
    await Promise.all([replacement.settled(), competitor.settled()]);
    expect((await replacement.status("alice", fresh.requestId)).state).toBe("published");
    expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs")).rows[0].n).toBe(2);
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
    expect(row).toMatchObject({ state: "failed", artifact_bytes: Buffer.byteLength(output.html!) });
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

// Shared real-pool contracts: filesystem deadlines must release every DB client.
import { publishStorageContract } from "../helpers/publishStorageContract";
describe.skipIf(process.env.PROJECTS_PG_E2E !== "1")("native publish storage deadlines",()=>{
 publishStorageContract("PostgreSQL max5 pool stays responsive",async()=>{
  const connectionString=process.env.PROJECTS_TEST_DATABASE_URL;
  if(!connectionString||!["127.0.0.1","localhost"].includes(new URL(connectionString).hostname))throw new Error("Dedicated loopback database required");
  const schema="lov_publish_storage_"+randomUUID().replaceAll("-","");
  const admin=new Pool({connectionString,max:1,connectionTimeoutMillis:5000});await admin.query("CREATE SCHEMA "+schema);
  const pool=new Pool({connectionString,max:5,options:"-c search_path="+schema,statement_timeout:10000,connectionTimeoutMillis:5000});
  return {db:dbFromPool(pool),poolState:()=>({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}),close:async()=>{await pool.end();try{await admin.query("DROP SCHEMA "+schema+" CASCADE");}finally{await admin.end();}}};
 },true);
});
