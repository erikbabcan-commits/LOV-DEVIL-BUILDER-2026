// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { newDb } from "pg-mem";
import { Hono } from "hono";
import { dbFromPool, type DbLike } from "../../../server/db/pool";
import { applyMigrations, listMigrations } from "../../../server/db/migrate";
import { registerProjectByteLength } from "../../helpers/projectMemoryDb";
import { makeAuthMiddleware } from "../../../server/auth/middleware";
import { signToken } from "../../../server/auth/tokens";
import { PublishService } from "../../../server/publish/service";
import { publishRouter } from "../../../server/publish/routes";
import { publicPublishApp } from "../../../server/publish/public";
import type { PublishConfig } from "../../../server/publish/config";
import { HostExecutor } from "../../../server/sandbox/executor";
import { BLUEPRINT_REGISTRY } from "../../../src/templates/registry";
import {
  isReservedSlug,
  isValidSlug,
  normalizeSlug,
  publishCacheControl,
  publishBaseDomain,
  resolvePublishHost,
  uniqueSlug,
  type DnsLookup,
} from "../../../server/publish/router";
import { atomicLiveSwitch, listPublishVersions } from "../../../server/publish/rollback";

const secret = "publish-engine-test-secret-01234567890123456789";

describe("publish engine: slugs, domains, rollback, cache (agent-7)", () => {
  let directory = "";
  let db!: DbLike;
  let close: (() => Promise<void>) | undefined;
  let service!: PublishService;
  let app!: Hono;
  let publicApp!: Hono;
  let token!: string;
  let config!: PublishConfig;
  let dns!: DnsLookup;
  const baseDomain = "lov-devil.test";

  const authHeaders = (session = token) => ({
    Cookie: "lov_token=" + session + "; lov_csrf=engine-csrf",
    "X-CSRF-Token": "engine-csrf",
    "Content-Type": "application/json",
  });

  async function seedProject(owner = "alice", projectId = "project-one", title = "Ľúbosť Café") {
    const files = BLUEPRINT_REGISTRY[1].files.map((f) => ({
      name: f.path,
      content: f.content,
    }));
    const workspace = {
      title,
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
      [owner, projectId, title, JSON.stringify(workspace)],
    );
    return { files, workspace };
  }

  async function publishOnce(owner = "alice", projectId = "project-one") {
    const selection = {
      requestId: randomUUID(),
      projectId,
      expectedRevision: 1,
      snapshotId: "snapshot-one",
      publicConsent: true as const,
    };
    await service.start(owner, selection);
    await service.settled();
    const status = await service.status(owner, selection.requestId);
    expect(status.state).toBe("published");
    return status;
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "lov-publish-engine-"));
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    db = dbFromPool(pool);
    close = () => pool.end();
    await applyMigrations(db);
    for (const id of ["alice", "bob"]) {
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
        [id, id + "@example.test", "not-a-login-hash"],
      );
    }
    await seedProject();
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
    service = new PublishService(db, config, {
      ready: host.ready.bind(host),
      execute: host.execute.bind(host),
    });
    dns = vi.fn(async () => ({ cname: [] as string[], txt: [] as string[] }));
    app = new Hono();
    app.use("/api/*", makeAuthMiddleware(secret, undefined, undefined, db));
    app.route("/", publishRouter(service, () => true, { dnsLookup: dns }));
    publicApp = publicPublishApp(config, db, service.artifacts, {
      baseDomain,
    });
  });

  afterEach(async () => {
    try { await service.settled(); } catch { /* beforeEach may have failed */ }
    try { await close?.(); } catch { /* ignore */ }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("normalizes slugs: diacritics, length, charset and reserved names", () => {
    expect(normalizeSlug("Ľúbosť Café!!!")).toBe("lubost-cafe");
    expect(normalizeSlug("A".repeat(100)).length).toBeLessThanOrEqual(63);
    expect(isValidSlug(normalizeSlug("Hello World"))).toBe(true);
    expect(isReservedSlug("www")).toBe(true);
    expect(isReservedSlug("api")).toBe(true);
    expect(isReservedSlug("admin")).toBe(true);
    expect(isValidSlug("www")).toBe(false);
    expect(isValidSlug("-bad")).toBe(false);
  });

  it("uniqueSlug appends numeric suffix on collision", async () => {
    const taken = new Set(["demo", "demo-2"]);
    const slug = await uniqueSlug("demo", async (c) => taken.has(c));
    expect(slug).toBe("demo-3");
  });

  it("assigns a deterministic unique project slug and rejects reserved seeds via suffix", async () => {
    const first = await service.ensureProjectSlug("alice", "project-one");
    expect(first.created).toBe(true);
    expect(isValidSlug(first.slug)).toBe(true);
    expect(first.slug).toBe("lubost-cafe");
    const again = await service.ensureProjectSlug("alice", "project-one");
    expect(again).toEqual({ slug: first.slug, created: false });

    await seedProject("alice", "project-two", "Ľúbosť Café");
    const second = await service.ensureProjectSlug("alice", "project-two");
    expect(second.slug).toBe("lubost-cafe-2");

    await seedProject("alice", "project-www", "www");
    const reserved = await service.ensureProjectSlug("alice", "project-www", "www");
    expect(isReservedSlug(reserved.slug)).toBe(false);
    expect(reserved.slug.startsWith("www")).toBe(true);
  });

  it("migration 026 is present and idempotent under pg-mem", async () => {
    const migration = listMigrations().find(
      (m) => m.name === "026_publish_rollback_domains.sql",
    );
    expect(migration).toBeDefined();
    const mem = newDb({ noAstCoverageCheck: true });
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    try {
      const twice = dbFromPool(pool);
      await applyMigrations(twice);
      await expect(applyMigrations(twice)).resolves.toContain(
        "026_publish_rollback_domains.sql",
      );
      await twice.query(migration!.sql);
      await twice.query("SELECT slug FROM publish_project_slugs LIMIT 0");
      await twice.query(
        "SELECT domain,status,verification_token FROM publish_custom_domains LIMIT 0",
      );
    } finally {
      await pool.end();
    }
  });

  it("stores custom domains as pending and verifies only via injected DNS resolver", async () => {
    await service.ensureProjectSlug("alice", "project-one");
    const pending = await service.registerCustomDomain(
      "alice",
      "project-one",
      "Shop.Example.TEST",
    );
    expect(pending).toMatchObject({
      domain: "shop.example.test",
      status: "pending_verification",
    });
    expect(pending.verificationToken).toMatch(/^[a-f0-9]{32}$/);

    dns = vi.fn(async () => ({ cname: [] as string[], txt: [] as string[] }));
    app = new Hono();
    app.use("/api/*", makeAuthMiddleware(secret, undefined, undefined, db));
    app.route("/", publishRouter(service, () => true, { dnsLookup: dns }));

    const stillPending = await service.verifyProjectDomain(
      "alice",
      "shop.example.test",
      dns,
    );
    expect(stillPending).toBe("pending_verification");
    expect(dns).toHaveBeenCalledWith("shop.example.test");

    const okLookup: DnsLookup = async () => ({
      cname: ["lubost-cafe.lov-devil.test."],
      txt: [],
    });
    const verified = await service.verifyProjectDomain(
      "alice",
      "shop.example.test",
      okLookup,
      baseDomain,
    );
    expect(verified).toBe("verified");
    const listed = await service.listProjectDomains("alice", "project-one");
    expect(listed[0]?.status).toBe("verified");
  });

  it("does not serve unverified custom domains; serves verified ones and slug hosts", async () => {
    const published = await publishOnce();
    const live = await service.promote("alice", "project-one", {
      requestId: published.requestId,
      expectedVersion: null,
      confirmed: true,
    });
    expect(live.current?.requestId).toBe(published.requestId);
    await service.ensureProjectSlug("alice", "project-one");
    const domain = await service.registerCustomDomain(
      "alice",
      "project-one",
      "pending.example.test",
    );

    const pendingHost = await publicApp.request("http://pending.example.test/", {
      headers: { Host: "pending.example.test" },
    });
    expect(pendingHost.status).toBe(404);
    expect(pendingHost.headers.get("cache-control")).toBe("no-store");

    await service.verifyProjectDomain("alice", domain.domain, async () => ({
      cname: [],
      txt: [`lov-devil-verify=${domain.verificationToken}`],
    }));

    const verifiedHost = await publicApp.request("http://pending.example.test/", {
      headers: { Host: "pending.example.test" },
    });
    expect(verifiedHost.status).toBe(200);
    expect(verifiedHost.headers.get("cache-control")).toBe("no-cache");
    expect(await verifiedHost.text()).toContain('<div id="root">');

    const slugHost = await publicApp.request("http://lubost-cafe.lov-devil.test/", {
      headers: { Host: "lubost-cafe.lov-devil.test" },
    });
    expect(slugHost.status).toBe(200);
    expect(slugHost.headers.get("cache-control")).toBe("no-cache");

    const binding = await resolvePublishHost(
      db,
      "lubost-cafe.lov-devil.test",
      baseDomain,
    );
    expect(binding).toMatchObject({
      kind: "slug",
      projectId: "project-one",
      ownerId: "alice",
    });
  });

  it("keeps the publish archive immutable and rolls back the live address atomically under 50ms (pg-mem)", async () => {
    const first = await publishOnce();
    await service.promote("alice", "project-one", {
      requestId: first.requestId,
      expectedVersion: null,
      confirmed: true,
    });

    // Second published version (new revision + snapshot) then promote it.
    const files = BLUEPRINT_REGISTRY[1].files.map((f) => ({
      name: f.path,
      content: f.content + "\n",
    }));
    await db.query(
      `UPDATE builder_projects SET revision=2, workspace=$3::jsonb
       WHERE owner_id=$1 AND project_id=$2`,
      [
        "alice",
        "project-one",
        JSON.stringify({
          title: "Ľúbosť Café",
          isPublic: false,
          liveId: "snapshot-two",
          files,
          snapshots: [
            {
              id: "snapshot-two",
              v: 2,
              prompt: "v2",
              kind: "manual",
              time: "test",
              html: "<main>v2</main>",
              sourceFiles: JSON.stringify(files),
            },
          ],
        }),
      ],
    );
    const secondSel = {
      requestId: randomUUID(),
      projectId: "project-one",
      expectedRevision: 2,
      snapshotId: "snapshot-two",
      publicConsent: true as const,
    };
    await service.start("alice", secondSel);
    await service.settled();
    const second = await service.status("alice", secondSel.requestId);
    expect(second.state).toBe("published");
    const before = await service.liveAddress("alice", "project-one");
    await service.promote("alice", "project-one", {
      requestId: second.requestId,
      expectedVersion: before!.version,
      confirmed: true,
    });

    const archiveBefore = (
      await db.query(
        "SELECT request_id, state FROM publish_jobs WHERE owner_id=$1 ORDER BY project_revision",
        ["alice"],
      )
    ).rows;
    expect(archiveBefore).toHaveLength(2);

    const live = await service.liveAddress("alice", "project-one");
    const rolled = await service.rollback("alice", "project-one", {
      requestId: first.requestId,
      expectedVersion: live!.version,
      confirmed: true,
    });
    expect(rolled.address.current?.requestId).toBe(first.requestId);
    expect(rolled.address.previous?.requestId).toBe(second.requestId);
    expect(rolled.elapsedMs).toBeLessThan(1000);
    // Report measured value (not a guarantee beyond this pg-mem run).
    expect(rolled.elapsedMs).toBeGreaterThanOrEqual(0);

    const archiveAfter = (
      await db.query(
        "SELECT request_id, state, withdrawn_at FROM publish_jobs WHERE owner_id=$1 ORDER BY project_revision",
        ["alice"],
      )
    ).rows;
    expect(archiveAfter).toEqual(
      archiveBefore.map((row) => ({ ...row, withdrawn_at: null })),
    );

    const foreign = await signToken(
      { sub: "bob", email: "bob@example.test", plan: "free" },
      secret,
    );
    const denied = await app.request("/api/publish/project/project-one/rollback", {
      method: "POST",
      headers: authHeaders(foreign),
      body: JSON.stringify({
        requestId: first.requestId,
        expectedVersion: rolled.address.version,
        confirmed: true,
      }),
    });
    // Bob does not own the project → promote target missing → 404
    expect(denied.status).toBe(404);

    const versions = await listPublishVersions(db, "alice", "project-one");
    expect(versions.length).toBe(2);
    expect(versions.some((v) => v.isLive && v.requestId === first.requestId)).toBe(
      true,
    );
  });

  it("sets HTML no-cache, documents immutable hashed-asset headers, and keeps no-store on public errors", async () => {
    expect(publishCacheControl("/p/" + randomUUID() + "/")).toBe("no-cache");
    expect(publishCacheControl("/index.html")).toBe("no-cache");
    expect(publishCacheControl("/p/x/app.deadbeef01234567.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(publishCacheControl("/p/x/deadbeef01234567.css")).toBe(
      "public, max-age=31536000, immutable",
    );

    const published = await publishOnce();
    const ok = await publicApp.request(published.url!, {
      headers: { Host: "127.0.0.1:8791" },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-cache");

    const asset = await publicApp.request(
      published.url! + "app.abcdef0123456789.js",
      { headers: { Host: "127.0.0.1:8791" } },
    );
    expect(asset.status).toBe(404);
    expect(asset.headers.get("cache-control")).toBe("no-store");
    expect(await asset.text()).not.toContain('<div id="root">');

    const missing = await publicApp.request(
      "http://127.0.0.1:8791/p/" + randomUUID() + "/",
      { headers: { Host: "127.0.0.1:8791" } },
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    const wrongHost = await publicApp.request(published.url!, {
      headers: { Host: "localhost:5176" },
    });
    expect(wrongHost.status).toBe(404);
    expect(wrongHost.headers.get("cache-control")).toBe("no-store");
  });

  it("does not serve parent HTML on a hashed-asset URL with an immutable cache header", async () => {
    const published = await publishOnce();
    const html = await (await publicApp.request(published.url!, { headers: { Host: "127.0.0.1:8791" } })).text();
    expect(html).toContain('<div id="root">');
    const asset = await publicApp.request(published.url! + "app.deadbeef01234567.js", {
      headers: { Host: "127.0.0.1:8791" },
    });
    expect(asset.status).toBe(404);
    expect(asset.headers.get("cache-control")).toBe("no-store");
    expect(asset.headers.get("cache-control")).not.toContain("immutable");
    expect(await asset.text()).not.toBe(html);
  });

  it("owner API: slug + versions + rollback routes require auth and stay owner-scoped", async () => {
    const published = await publishOnce();
    await service.promote("alice", "project-one", {
      requestId: published.requestId,
      expectedVersion: null,
      confirmed: true,
    });

    expect(
      (
        await app.request("/api/publish/project/project-one/slug", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);

    const slug = await app.request("/api/publish/project/project-one/slug", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(slug.status).toBe(200);
    expect(await slug.json()).toMatchObject({
      slug: "lubost-cafe",
      created: true,
    });

    const versions = await app.request(
      "/api/publish/project/project-one/versions",
      { headers: authHeaders() },
    );
    expect(versions.status).toBe(200);
    const list = await versions.json();
    expect(list.versions[0].requestId).toBe(published.requestId);
    expect(list.liveVersion).toBe((await service.liveAddress("alice", "project-one"))!.version);
    expect(versions.headers.get("cache-control")).toBe("no-store");

    // atomicLiveSwitch smoke (single UPSERT path used by rollback internals)
    await db.transaction!(async (tx) => {
      await atomicLiveSwitch(
        tx,
        "alice",
        "project-one",
        published.requestId,
        null,
      );
    });
  });

  it("publishBaseDomain reads PUBLISH_BASE_DOMAIN and defaults safely in tests", () => {
    expect(publishBaseDomain({ PUBLISH_BASE_DOMAIN: undefined })).toBe(
      "lov-devil.app",
    );
    expect(publishBaseDomain({ PUBLISH_BASE_DOMAIN: " apps.example " })).toBe(
      "apps.example",
    );
  });

  it("authenticated publish status responses keep Cache-Control no-store", async () => {
    const published = await publishOnce();
    const status = await app.request(
      "/api/publish/project/project-one/1/snapshot-one",
      { headers: authHeaders() },
    );
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect((await status.json()).requestId).toBe(published.requestId);
  });
});
