// @vitest-environment node
/* Regression tests for Bora's wave-2 verdict on bf600fb (P2-1, P2-2, P3-1, P3-7).
   Ported from wave2/bora-probes-bf600fb/bora-w2-probe-a7.test.ts (B4, B6, B8). pg-mem only. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { PublishConfig } from "../../../server/publish/config";
import { HostExecutor } from "../../../server/sandbox/executor";
import { BLUEPRINT_REGISTRY } from "../../../src/templates/registry";

const secret = "publish-engine-test-secret-01234567890123456789";

describe("publish wave-2 Bora fixes (pg-mem)", () => {
  let directory = "";
  let db!: DbLike;
  let close: (() => Promise<void>) | undefined;
  let service!: PublishService;
  let app!: Hono;
  let alice!: string;
  let bob!: string;
  let clock = Date.parse("2026-11-20T18:00:00.000Z");

  const headers = (session: string) => ({
    Cookie: "lov_token=" + session + "; lov_csrf=engine-csrf",
    "X-CSRF-Token": "engine-csrf",
    "Content-Type": "application/json",
  });

  async function seedProject(owner: string, projectId: string, title: string) {
    const files = BLUEPRINT_REGISTRY[1].files.map((f) => ({ name: f.path, content: f.content }));
    const workspace = {
      title, isPublic: false, liveId: "snapshot-one", files,
      snapshots: [{ id: "snapshot-one", v: 1, prompt: "source", kind: "manual", time: "test", html: "<main>source</main>", sourceFiles: JSON.stringify(files) }],
    };
    await db.query(
      "INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)",
      [owner, projectId, title, JSON.stringify(workspace)],
    );
  }

  async function publishOnce(owner = "alice", projectId = "project-one") {
    const selection = { requestId: randomUUID(), projectId, expectedRevision: 1, snapshotId: "snapshot-one", publicConsent: true as const };
    await service.start(owner, selection);
    await service.settled();
    const status = await service.status(owner, selection.requestId);
    expect(status.state).toBe("published");
    return status;
  }

  beforeEach(async () => {
    clock = Date.parse("2026-11-20T18:00:00.000Z");
    directory = await mkdtemp(path.join(tmpdir(), "lov-publish-w2fix-"));
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    db = dbFromPool(pool);
    close = () => pool.end();
    await applyMigrations(db);
    for (const id of ["alice", "bob"])
      await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [id, id + "@example.test", "not-a-login-hash"]);
    await seedProject("alice", "project-one", "Ľúbosť Café");
    await seedProject("bob", "bob-proj", "Bob");
    alice = await signToken({ sub: "alice", email: "alice@example.test", plan: "free" }, secret);
    bob = await signToken({ sub: "bob", email: "bob@example.test", plan: "free" }, secret);
    const config: PublishConfig = {
      baseUrl: "http://127.0.0.1:8791/", appUrl: "http://localhost:5176/", artifactDir: directory,
      bind: "127.0.0.1", port: 8791, maxArtifacts: 20, maxOwnerBytes: 30000000, maxArtifactBytes: 3000000, allowHostTest: true,
    };
    const host = new HostExecutor();
    service = new PublishService(db, config, { ready: host.ready.bind(host), execute: host.execute.bind(host) }, { now: () => clock });
    app = new Hono();
    app.use("/api/*", makeAuthMiddleware(secret, undefined, undefined, db));
    app.route("/", publishRouter(service, () => true));
  });

  afterEach(async () => {
    try { await service.settled(); } catch { /* beforeEach may have failed */ }
    try { await close?.(); } catch { /* ignore */ }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  describe("P2-1 rollback from the UI uses the live version token", () => {
    it("GET versions returns liveVersion; rollback with it succeeds, with null or a stale token it stays 409 (probe B8)", async () => {
      const a = await publishOnce();
      const b = await publishOnce();
      await service.promote("alice", "project-one", { requestId: b.requestId, expectedVersion: null, confirmed: true });

      const res = await app.request("/api/publish/project/project-one/versions", { headers: headers(alice) });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const list = await res.json();
      const live = await service.liveAddress("alice", "project-one");
      expect(list.liveVersion).toBe(live!.version);
      expect(list.versions.map((v: { requestId: string }) => v.requestId).sort()).toEqual([a.requestId, b.requestId].sort());
      expect(list.versions.find((v: { isLive: boolean }) => v.isLive).requestId).toBe(b.requestId);

      const rollback = (expectedVersion: string | null) =>
        app.request("/api/publish/project/project-one/rollback", {
          method: "POST", headers: headers(alice), body: JSON.stringify({ requestId: a.requestId, expectedVersion, confirmed: true }),
        });
      // Bora B8: the old UI contract (expectedVersion=null while something is live) is still rejected.
      const stale = await rollback(null);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "publish_live_conflict" });

      const ok = await rollback(list.liveVersion);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.current.requestId).toBe(a.requestId);

      // The token rotates on every switch: replaying the previous token is a strict 409.
      const replay = await rollback(list.liveVersion);
      expect(replay.status).toBe(409);
    });

    it("liveVersion is null before anything is live and for a foreign project", async () => {
      await publishOnce();
      const own = await (await app.request("/api/publish/project/project-one/versions", { headers: headers(alice) })).json();
      expect(own.liveVersion).toBeNull();
      expect(own.versions).toHaveLength(1);
      const foreign = await (await app.request("/api/publish/project/project-one/versions", { headers: headers(bob) })).json();
      expect(foreign).toEqual({ liveVersion: null, versions: [] });
    });
  });
});
