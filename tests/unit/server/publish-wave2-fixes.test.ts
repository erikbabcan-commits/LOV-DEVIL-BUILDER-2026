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
import { publicPublishApp } from "../../../server/publish/public";
import type { PublishConfig } from "../../../server/publish/config";
import { HostExecutor } from "../../../server/sandbox/executor";
import { BLUEPRINT_REGISTRY } from "../../../src/templates/registry";
import { checkCustomDomain, publishPlatformZones } from "../../../server/publish/router";
import { CUSTOM_DOMAIN_PENDING_TTL_MS, MAX_PENDING_CUSTOM_DOMAINS } from "../../../server/publish/service";
import { atomicLiveSwitch } from "../../../server/publish/rollback";

const secret = "publish-engine-test-secret-01234567890123456789";

describe("publish wave-2 Bora fixes (pg-mem)", () => {
  let directory = "";
  let db!: DbLike;
  let close: (() => Promise<void>) | undefined;
  let service!: PublishService;
  let app!: Hono;
  let publicApp!: Hono;
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
    publicApp = publicPublishApp(config, db, service.artifacts, { baseDomain: "lov-devil.test" });
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

  describe("P2-2 custom domain claims", () => {
    const post = (session: string, project: string, domain: string) =>
      app.request(`/api/publish/project/${project}/domains`, { method: "POST", headers: headers(session), body: JSON.stringify({ domain }) });
    const del = (session: string, project: string, domain: string) =>
      app.request(`/api/publish/project/${project}/domains/${encodeURIComponent(domain)}`, { method: "DELETE", headers: headers(session) });

    it("strict hostname validation (probe B4 odd domains)", async () => {
      const zones = ["lov-devil.test", "apps.example.org"];
      const rejected: Array<[string, string]> = [
        ["127.0.0.1", "publish_domain_invalid"], ["10.0.0.1.", "publish_domain_invalid"], ["::1", "publish_domain_invalid"],
        ["[::1]", "publish_domain_invalid"], ["2001:db8::1", "publish_domain_invalid"], ["127.1", "publish_domain_invalid"],
        ["localhost", "publish_domain_invalid"], ["localhost.", "publish_domain_invalid"],
        ["app.localhost", "publish_domain_reserved"], ["a.b.LOCALHOST", "publish_domain_reserved"],
        ["a", "publish_domain_invalid"], ["a..b", "publish_domain_invalid"], [".a.com", "publish_domain_invalid"], ["a.com..", "publish_domain_invalid"],
        ["-a.com", "publish_domain_invalid"], ["a-.com", "publish_domain_invalid"], ["a_b.com", "publish_domain_invalid"], ["ľúbosť.sk", "publish_domain_invalid"],
        ["a b.com", "publish_domain_invalid"], ["a.com/x", "publish_domain_invalid"], ["a.com:443", "publish_domain_invalid"], ["", "publish_domain_invalid"],
        ["x".repeat(64) + ".com", "publish_domain_invalid"], [Array(64).fill("abc").join(".") + ".com", "publish_domain_invalid"],
        ["lov-devil.test", "publish_domain_reserved"], ["evil.lov-devil.test", "publish_domain_reserved"], ["a.b.LOV-DEVIL.TEST.", "publish_domain_reserved"],
        ["apps.example.org", "publish_domain_reserved"], ["x.apps.example.org", "publish_domain_reserved"],
      ];
      for (const [raw, error] of rejected) expect([raw, checkCustomDomain(raw, zones)]).toEqual([raw, { ok: false, error }]);
      expect(checkCustomDomain(" Shop.Example.COM. ", zones)).toEqual({ ok: true, domain: "shop.example.com" });
      expect(checkCustomDomain("xn--80ak6aa92e.com", zones)).toEqual({ ok: true, domain: "xn--80ak6aa92e.com" });
      expect(checkCustomDomain("notlov-devil.test", zones)).toEqual({ ok: true, domain: "notlov-devil.test" });
      expect(checkCustomDomain("x".repeat(63) + ".com", zones).ok).toBe(true);
      // Default zones always include lov-devil.test/lov-devil.app plus PUBLISH_BASE_DOMAIN.
      expect(publishPlatformZones({ PUBLISH_BASE_DOMAIN: "pages.example.net" })).toEqual(expect.arrayContaining(["lov-devil.test", "lov-devil.app", "pages.example.net"]));
      expect(checkCustomDomain("lubost-cafe.lov-devil.app").ok).toBe(false);

      // Over HTTP every odd domain from probe B4 is now 400.
      const statuses: string[] = [];
      for (const d of ["127.0.0.1", "localhost", "lov-devil.test", "evil.lov-devil.test", "a..b", "-a.com", "a"])
        statuses.push(d + "=" + (await post(bob, "bob-proj", d)).status);
      expect(statuses).toEqual(["127.0.0.1=400", "localhost=400", "lov-devil.test=400", "evil.lov-devil.test=400", "a..b=400", "-a.com=400", "a=400"]);
      expect((await post(bob, "bob-proj", "xn--80ak6aa92e.com")).status).toBe(200);
    });

    it("probe B4: Bob's unverified claim blocks Alice only until it expires (72 h), then Alice takes it over atomically", async () => {
      const squat = await post(bob, "bob-proj", "shop.alice-company.test");
      expect(squat.status).toBe(200);
      const squatBody = await squat.json();
      expect(squatBody.expiresAt).toBe(new Date(clock + CUSTOM_DOMAIN_PENDING_TTL_MS).toISOString());

      const blocked = await post(alice, "project-one", "shop.alice-company.test");
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ error: "publish_domain_taken" });

      clock += CUSTOM_DOMAIN_PENDING_TTL_MS - 1000; // still inside the window
      expect((await post(alice, "project-one", "shop.alice-company.test")).status).toBe(409);

      clock += 1000; // exactly at expiry
      const legit = await post(alice, "project-one", "shop.alice-company.test");
      expect(legit.status).toBe(200);
      const legitBody = await legit.json();
      expect(legitBody.status).toBe("pending_verification");
      expect(legitBody.verificationToken).not.toBe(squatBody.verificationToken);

      const rows = (await db.query("SELECT owner_id, project_id FROM publish_custom_domains WHERE domain=$1", ["shop.alice-company.test"])).rows;
      expect(rows).toEqual([{ owner_id: "alice", project_id: "project-one" }]);
      expect(await service.listProjectDomains("bob", "bob-proj")).toEqual([]);
      // Bob can no longer verify or delete the domain he lost.
      await expect(service.verifyProjectDomain("bob", "shop.alice-company.test", async () => ({ cname: [], txt: [`lov-devil-verify=${squatBody.verificationToken}`] }))).rejects.toMatchObject({ code: "publish_domain_not_found" });
      expect((await del(bob, "bob-proj", "shop.alice-company.test")).status).toBe(404);
      // Bob re-claiming while Alice's fresh claim is active is 409 again.
      expect((await post(bob, "bob-proj", "shop.alice-company.test")).status).toBe(409);
    });

    it("verified claims never expire through the claim path", async () => {
      await service.ensureProjectSlug("alice", "project-one");
      const claim = await service.registerCustomDomain("alice", "project-one", "verified.example.test");
      expect(await service.verifyProjectDomain("alice", claim.domain, async () => ({ cname: [], txt: [`lov-devil-verify=${claim.verificationToken}`] }))).toBe("verified");
      const row = (await db.query("SELECT status, expires_at FROM publish_custom_domains WHERE domain=$1", [claim.domain])).rows[0];
      expect(row).toEqual({ status: "verified", expires_at: null });
      clock += 10 * CUSTOM_DOMAIN_PENDING_TTL_MS;
      const takeover = await post(bob, "bob-proj", "verified.example.test");
      expect(takeover.status).toBe(409);
      expect(await takeover.json()).toEqual({ error: "publish_domain_taken" });
      expect((await service.listProjectDomains("alice", "project-one"))[0]).toMatchObject({ domain: "verified.example.test", status: "verified", expiresAt: null });
    });

    it("same owner re-registering is idempotent; an own lapsed claim is renewed", async () => {
      const first = await (await post(alice, "project-one", "own.example.test")).json();
      const again = await (await post(alice, "project-one", "own.example.test")).json();
      expect(again).toEqual(first);
      clock += CUSTOM_DOMAIN_PENDING_TTL_MS + 1;
      const renewed = await (await post(alice, "project-one", "own.example.test")).json();
      expect(renewed.verificationToken).toBe(first.verificationToken);
      expect(renewed.expiresAt).toBe(new Date(clock + CUSTOM_DOMAIN_PENDING_TTL_MS).toISOString());
    });

    it("concurrent takeovers of one expired claim: exactly one account wins", async () => {
      await db.query("INSERT INTO users(id,email,password_hash) VALUES('carol','carol@example.test','not-a-login-hash')");
      await seedProject("carol", "carol-proj", "Carol");
      await service.registerCustomDomain("bob", "bob-proj", "race.example.test");
      clock += CUSTOM_DOMAIN_PENDING_TTL_MS;
      const res = await Promise.allSettled([
        service.registerCustomDomain("alice", "project-one", "race.example.test"),
        service.registerCustomDomain("carol", "carol-proj", "race.example.test"),
      ]);
      const ok = res.filter((r) => r.status === "fulfilled");
      const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0].reason).toMatchObject({ code: "publish_domain_taken", status: 409 });
      const owners = (await db.query("SELECT owner_id FROM publish_custom_domains WHERE domain=$1", ["race.example.test"])).rows;
      expect(owners).toHaveLength(1);
      expect(["alice", "carol"]).toContain(owners[0].owner_id);
    });

    it(`caps unexpired pending claims at ${MAX_PENDING_CUSTOM_DOMAINS} per account (probe B4: 60/60 were accepted)`, async () => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await post(bob, "bob-proj", `d${i}.squat.test`)).status);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
      const limited = await post(bob, "bob-proj", "d9.squat.test");
      expect(await limited.json()).toEqual({ error: "publish_domain_limit" });
      // Other accounts are unaffected.
      expect((await post(alice, "project-one", "alice.squat.test")).status).toBe(200);
      // Releasing one frees a slot.
      expect((await del(bob, "bob-proj", "d0.squat.test")).status).toBe(200);
      expect((await post(bob, "bob-proj", "d5.squat.test")).status).toBe(200);
      expect((await post(bob, "bob-proj", "d6.squat.test")).status).toBe(429);
      // Verified domains do not count against the pending cap.
      const d1 = (await service.listProjectDomains("bob", "bob-proj")).find((d) => d.domain === "d1.squat.test")!;
      expect(await service.verifyProjectDomain("bob", "d1.squat.test", async () => ({ cname: [], txt: [`lov-devil-verify=${d1.verificationToken}`] }))).toBe("verified");
      expect((await post(bob, "bob-proj", "d6.squat.test")).status).toBe(200);
      expect((await post(bob, "bob-proj", "d7.squat.test")).status).toBe(429);
      // Expired claims stop counting.
      clock += CUSTOM_DOMAIN_PENDING_TTL_MS;
      expect((await post(bob, "bob-proj", "d7.squat.test")).status).toBe(200);
      expect((await service.listProjectDomains("bob", "bob-proj")).length).toBeGreaterThan(MAX_PENDING_CUSTOM_DOMAINS);
    });

    it("DELETE releases a domain for its owner only; non-owners and unknown domains get 404", async () => {
      await post(alice, "project-one", "release.example.test");
      expect((await del(bob, "bob-proj", "release.example.test")).status).toBe(404);
      expect((await del(bob, "project-one", "release.example.test")).status).toBe(404);
      expect((await del(alice, "project-one", "unknown.example.test")).status).toBe(404);
      expect((await del(alice, "project-one", "127.0.0.1")).status).toBe(404);
      const unauth = await app.request("/api/publish/project/project-one/domains/release.example.test", { method: "DELETE" });
      expect(unauth.status).toBe(401);
      expect((await db.query("SELECT domain FROM publish_custom_domains WHERE domain=$1", ["release.example.test"])).rows).toHaveLength(1);

      const ok = await del(alice, "project-one", "Release.Example.TEST.");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ domain: "release.example.test", deleted: true });
      expect((await db.query("SELECT domain FROM publish_custom_domains WHERE domain=$1", ["release.example.test"])).rows).toHaveLength(0);
      // Released → immediately claimable by someone else.
      expect((await post(bob, "bob-proj", "release.example.test")).status).toBe(200);
    });
  });

  describe("P3-1 concurrent slug/domain creation maps unique violations to 409 (never 503)", () => {
    it("probe B6: two projects with the same title get distinct slugs concurrently", async () => {
      await seedProject("alice", "p-a", "Same Name");
      await seedProject("alice", "p-b", "Same Name");
      const res = await Promise.allSettled([service.ensureProjectSlug("alice", "p-a"), service.ensureProjectSlug("alice", "p-b")]);
      const outcome = res.map((r) => (r.status === "fulfilled" ? r.value.slug : "err:" + (r.reason as { code?: string })?.code));
      // Before the fix the loser surfaced a raw 23505 (router: 503). Now it retries and takes the next suffix.
      expect(outcome.sort()).toEqual(["same-name", "same-name-2"]);
    });

    it("two accounts claiming the same new domain concurrently: one 200, the other 409 publish_domain_taken over HTTP", async () => {
      const post = (session: string, project: string) =>
        app.request(`/api/publish/project/${project}/domains`, { method: "POST", headers: headers(session), body: JSON.stringify({ domain: "fresh.example.test" }) });
      const [a, b] = await Promise.all([post(alice, "project-one"), post(bob, "bob-proj")]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(await loser.json()).toEqual({ error: "publish_domain_taken" });
    });

    it("a 23505 that escapes the slug retries surfaces as 409 publish_slug_conflict", async () => {
      const original = db.transaction!.bind(db);
      let calls = 0;
      db.transaction = (async (work: (tx: DbLike) => Promise<unknown>) => {
        calls += 1;
        return original(async (tx) => {
          const query = tx.query.bind(tx);
          const wrapped = { ...tx, query: async (sql: string, params?: unknown[]) => {
            if (/^INSERT INTO publish_project_slugs/.test(sql.trim()))
              throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
            return query(sql, params);
          } } as DbLike;
          return work(wrapped);
        });
      }) as typeof db.transaction;
      try {
        await expect(service.ensureProjectSlug("alice", "project-one")).rejects.toMatchObject({ code: "publish_slug_conflict", status: 409 });
        expect(calls).toBe(3);
      } finally {
        db.transaction = original;
      }
      const res = await app.request("/api/publish/project/project-one/slug", { method: "POST", headers: headers(alice), body: "{}" });
      expect(res.status).toBe(200);
    });
  });

  describe("P3-7 atomicLiveSwitch checks owner, project and target (defense in depth)", () => {
    const liveRow = async (owner: string, project: string) =>
      (await db.query("SELECT request_id, previous_request_id FROM publish_live_addresses WHERE owner_id=$1 AND project_id=$2", [owner, project])).rows[0] ?? null;
    const switchTo = (owner: string, project: string, requestId: string, previous: string | null = null) =>
      db.transaction!((tx) => atomicLiveSwitch(tx, owner, project, requestId, previous));

    it("rejects a foreign owner, a requestId from another project, an unknown or withdrawn target; accepts the owner's own", async () => {
      const a = await publishOnce("alice", "project-one");
      const b = await publishOnce("alice", "project-one");
      const bobs = await publishOnce("bob", "bob-proj");
      await service.promote("alice", "project-one", { requestId: a.requestId, expectedVersion: null, confirmed: true });

      // Bob cannot point Alice's project anywhere, even at Alice's own artifact.
      await expect(switchTo("bob", "project-one", b.requestId)).rejects.toMatchObject({ code: "publish_not_found", status: 404 });
      // Alice cannot point her project at Bob's artifact.
      await expect(switchTo("alice", "project-one", bobs.requestId)).rejects.toMatchObject({ code: "publish_not_found", status: 404 });
      await expect(switchTo("alice", "project-one", randomUUID())).rejects.toMatchObject({ code: "publish_not_found", status: 404 });
      await service.withdraw("alice", b.requestId);
      await expect(switchTo("alice", "project-one", b.requestId)).rejects.toMatchObject({ code: "publish_not_found", status: 404 });
      expect(await liveRow("alice", "project-one")).toMatchObject({ request_id: a.requestId });
      expect(await liveRow("bob", "project-one")).toBeNull();

      const c = await publishOnce("alice", "project-one");
      // A foreign previousRequestId is dropped, never stored.
      await switchTo("alice", "project-one", c.requestId, bobs.requestId);
      expect(await liveRow("alice", "project-one")).toEqual({ request_id: c.requestId, previous_request_id: null });
      await switchTo("alice", "project-one", a.requestId, c.requestId);
      expect(await liveRow("alice", "project-one")).toEqual({ request_id: a.requestId, previous_request_id: c.requestId });
    });

    it("rejects a deleted project", async () => {
      const a = await publishOnce("alice", "project-one");
      await db.query("UPDATE builder_projects SET deleted_at=now() WHERE owner_id='alice' AND project_id='project-one'");
      await expect(switchTo("alice", "project-one", a.requestId)).rejects.toMatchObject({ code: "publish_not_found", status: 404 });
    });
  });

  describe("TIC TAC P2-3 hard-delete releases slug/domain and unpublishes atomically", () => {
    const get = (hostHeader: string, url = "http://x/") => publicApp.request(url, { headers: { Host: hostHeader } });

    it("Alice publishes and hard-deletes; Bob can never get her slug and her content is never served under his claims (probe T3)", async () => {
      const pub = await publishOnce("alice", "project-one");
      const live = await service.promote("alice", "project-one", { requestId: pub.requestId, expectedVersion: null, confirmed: true });
      const { slug } = await service.ensureProjectSlug("alice", "project-one");
      expect(slug).toBe("lubost-cafe");
      const claim = await service.registerCustomDomain("alice", "project-one", "www.alice-company.test");
      expect(await service.verifyProjectDomain("alice", claim.domain, async () => ({ cname: ["lubost-cafe.lov-devil.test."], txt: [] }), "lov-devil.test")).toBe("verified");
      const aliceHtml = await (await get("lubost-cafe.lov-devil.test")).text();
      expect(aliceHtml).toContain('<div id="root">');
      expect((await get("www.alice-company.test")).status).toBe(200);
      expect((await get("127.0.0.1:8791", pub.url!)).status).toBe(200);
      expect((await get("127.0.0.1:8791", live.url)).status).toBe(200);

      const purged = await service.hardDeleteProject("alice", "project-one");
      expect(purged).toEqual({ slug: "lubost-cafe", domains: ["www.alice-company.test"], withdrawn: 1 });
      for (const table of ["builder_projects", "publish_project_slugs", "publish_custom_domains", "publish_live_addresses"])
        expect([table, (await db.query(`SELECT 1 FROM ${table} WHERE owner_id='alice'`)).rows.length]).toEqual([table, 0]);
      expect((await db.query("SELECT withdrawn_at FROM publish_jobs WHERE owner_id='alice'")).rows.every((r: { withdrawn_at: unknown }) => r.withdrawn_at !== null)).toBe(true);

      // Nothing of Alice's is served any more: slug host, custom domain, artifact URL, live alias → 404 no-store.
      for (const [hostHeader, url] of [["lubost-cafe.lov-devil.test", "http://x/"], ["www.alice-company.test", "http://x/"], ["127.0.0.1:8791", pub.url!], ["127.0.0.1:8791", live.url]] as const) {
        const res = await get(hostHeader, url);
        expect([hostHeader, url, res.status, res.headers.get("cache-control")]).toEqual([hostHeader, url, 404, "no-store"]);
      }

      // Bob: same title and even an explicit seed never yield the released slug.
      await seedProject("bob", "bob-cafe", "Ľúbosť Café");
      const bobSlug = await service.ensureProjectSlug("bob", "bob-cafe", "lubost-cafe");
      expect(bobSlug.slug).not.toBe("lubost-cafe");
      expect(bobSlug.slug).toBe("lubost-cafe-2");
      const bobPub = await publishOnce("bob", "bob-cafe");
      await service.promote("bob", "bob-cafe", { requestId: bobPub.requestId, expectedVersion: null, confirmed: true });
      expect((await get("lubost-cafe-2.lov-devil.test")).status).toBe(200);
      // The old slug link stays dead instead of switching to Bob's project.
      expect((await get("lubost-cafe.lov-devil.test")).status).toBe(404);

      // Bob may claim Alice's released domain, but her dangling CNAME (→ lubost-cafe) cannot verify it for him.
      const bobClaim = await service.registerCustomDomain("bob", "bob-cafe", "www.alice-company.test");
      expect(bobClaim.status).toBe("pending_verification");
      expect(await service.verifyProjectDomain("bob", "www.alice-company.test", async () => ({ cname: ["lubost-cafe.lov-devil.test."], txt: [] }), "lov-devil.test")).toBe("pending_verification");
      const hijack = await get("www.alice-company.test");
      expect(hijack.status).toBe(404);
      expect(hijack.headers.get("cache-control")).toBe("no-store");
    });

    it("is owner-scoped and all-or-nothing", async () => {
      await publishOnce("alice", "project-one");
      await service.ensureProjectSlug("alice", "project-one");
      await expect(service.hardDeleteProject("bob", "project-one")).rejects.toMatchObject({ code: "publish_project_not_found", status: 404 });
      expect((await db.query("SELECT 1 FROM builder_projects WHERE owner_id='alice'")).rows).toHaveLength(1);

      // All purge statements run inside ONE owner transaction and none on the pool
      // directly. (pg-mem's pg adapter does not undo work on ROLLBACK, so the
      // rollback itself is only provable on native Postgres: NOT RUN here.)
      const original = db.transaction!.bind(db);
      const outside = db.query.bind(db);
      const inTx: string[] = [], onPool: string[] = [];
      let transactions = 0;
      db.query = (async (sql: string, params?: unknown[]) => { onPool.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")); return outside(sql, params); }) as typeof db.query;
      db.transaction = (async (work: (tx: DbLike) => Promise<unknown>) => {
        transactions += 1;
        return original(async (tx) => {
          const query = tx.query.bind(tx);
          return work({ ...tx, query: async (sql: string, params?: unknown[]) => { inTx.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")); return query(sql, params); } } as DbLike);
        });
      }) as typeof db.transaction;
      try {
        await service.hardDeleteProject("alice", "project-one");
      } finally {
        db.transaction = original;
        db.query = outside;
      }
      expect(transactions).toBe(1);
      expect(onPool).toEqual([]);
      expect(inTx).toEqual(expect.arrayContaining([
        "UPDATE publish_jobs SET", "DELETE FROM publish_live_addresses", "DELETE FROM publish_custom_domains",
        "INSERT INTO publish_slug_tombstones(slug,", "DELETE FROM publish_project_slugs", "DELETE FROM builder_projects",
      ]));
      // Withdrawal happens before the slug/domain release and the project delete.
      expect(inTx.indexOf("UPDATE publish_jobs SET")).toBeLessThan(inTx.indexOf("DELETE FROM publish_project_slugs"));
      expect(inTx.indexOf("UPDATE publish_jobs SET")).toBeLessThan(inTx.indexOf("DELETE FROM publish_custom_domains"));
      expect((await get("lubost-cafe.lov-devil.test")).status).toBe(404);
    });
  });
});
