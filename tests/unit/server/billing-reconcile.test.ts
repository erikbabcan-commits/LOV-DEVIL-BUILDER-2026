// @vitest-environment node
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, listMigrations } from "../../../server/db/migrate";
import { dbFromPool, type DbLike } from "../../../server/db/pool";
import { BillingService } from "../../../server/billing/service";
import {
  BILLING_QUEUE_BASE_DELAY_MS,
  BILLING_QUEUE_MAX_ATTEMPTS,
  BILLING_QUEUE_MAX_DELAY_MS,
  billingQueueBackoffMs,
  drainBillingWebhookQueue,
} from "../../../server/billing/webhookQueue";
import {
  BILLING_GRACE_PERIOD_MS,
  expireGracePeriods,
  readBillingMaintenanceInterval,
  reconcileBillingAccounts,
  runBillingMaintenance,
} from "../../../server/billing/reconcile";
import { registerProjectByteLength } from "../../helpers/projectMemoryDb";
import {
  BILLING_TEST_CONFIG,
  BillingContractGateway,
  billingSubscription,
} from "../../helpers/billingContract";

/* Local only: pg-mem, a synthetic gateway and locally signed payloads (fake whsec). No Stripe HTTP. */
const stripe = new Stripe(BILLING_TEST_CONFIG.secretKey);
const DAY = 24 * 3600_000;
const CUSTOMER = "cus_reconcile_alice";

describe("billing webhook queue, reconciliation and grace period (pg-mem)", () => {
  let db: DbLike;
  let pool: { end: () => Promise<void> };
  let gateway: BillingContractGateway;
  let service: BillingService;
  let clock: Date;
  const now = () => clock;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  const signed = (event: Record<string, unknown>) => {
    const payload = JSON.stringify({
      object: "event",
      livemode: false,
      ...event,
    });
    return {
      raw: Buffer.from(payload),
      signature: stripe.webhooks.generateTestHeaderString({
        payload,
        secret: BILLING_TEST_CONFIG.webhookSecret,
      }),
    };
  };
  const deliver = (
    type: string,
    options: { id?: string; created?: number; object?: Record<string, unknown> } = {},
  ) => {
    const { raw, signature } = signed({
      id: options.id ?? "evt_" + randomUUID().replaceAll("-", ""),
      type,
      created: options.created ?? Math.floor(clock.getTime() / 1000),
      data: {
        object: {
          id: type.startsWith("invoice.") ? "in_reconcile" : type.startsWith("checkout.") ? "cs_test_unknown" : "sub_contract",
          object: type.startsWith("invoice.") ? "invoice" : type.startsWith("checkout.") ? "checkout.session" : "subscription",
          customer: CUSTOMER,
          ...options.object,
        },
      },
    });
    return service.webhook(raw, signature);
  };
  const plan = async (user = "alice") =>
    (await db.query("SELECT plan,plan_expires_at FROM users WHERE id=$1", [user])).rows[0];
  const queueRow = async (eventId: string) =>
    (await db.query("SELECT * FROM billing_webhook_queue WHERE event_id=$1", [eventId])).rows[0];
  const accountState = async (user = "alice") =>
    (await db.query("SELECT * FROM billing_account_state WHERE user_id=$1", [user])).rows[0];
  const makeService = (gracePeriodMs?: number) =>
    new BillingService(
      db,
      BILLING_TEST_CONFIG,
      gateway,
      now,
      gracePeriodMs === undefined ? {} : { gracePeriodMs },
    );
  const activatePro = async () => {
    gateway.data = [billingSubscription(CUSTOMER)];
    await deliver("customer.subscription.updated");
    expect((await plan()).plan).toBe("pro");
  };

  beforeEach(async () => {
    const mem = newDb();
    registerProjectByteLength(mem);
    const memPool = new (mem.adapters.createPg().Pool)();
    pool = memPool;
    db = dbFromPool(memPool);
    await applyMigrations(db);
    clock = new Date();
    for (const user of ["alice", "bob"]) {
      await db.query("INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)", [
        user,
        user + "@billing.example.test",
        "not-an-authentication-hash",
      ]);
    }
    await db.query(
      "INSERT INTO billing_accounts(user_id,customer_id,customer_key,created_at) VALUES($1,$2,$3,$4)",
      ["alice", CUSTOMER, randomUUID(), clock.toISOString()],
    );
    gateway = new BillingContractGateway();
    service = makeService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("External HTTP forbidden in billing reconcile tests");
      }),
    );
  });
  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      await pool.end();
    }
  });

  it("migration 025 is idempotent: applyMigrations runs twice without error", async () => {
    const migration = listMigrations().find((m) => m.name === "025_billing_webhook_queue.sql");
    expect(migration).toBeDefined();
    // Full set twice. pg-mem's AST coverage check rejects CREATE TABLE IF NOT EXISTS on an
    // existing table for every migration (001+), so only that check is disabled here.
    const mem = newDb({ noAstCoverageCheck: true });
    registerProjectByteLength(mem);
    const twicePool = new (mem.adapters.createPg().Pool)();
    try {
      const twice = dbFromPool(twicePool);
      await applyMigrations(twice);
      await expect(applyMigrations(twice)).resolves.toContain("025_billing_webhook_queue.sql");
      await twice.query(migration!.sql);
      await twice.query("SELECT event_id FROM billing_webhook_queue LIMIT 0");
    } finally {
      await twicePool.end();
    }
    await db.query("SELECT event_id,state,outcome,attempts,max_attempts,next_attempt_at,last_error FROM billing_webhook_queue LIMIT 0");
    await db.query("SELECT user_id,last_subscription_event_created,grace_period_ends_at,grace_resolved_at,downgraded_to_free_at,downgrade_reason FROM billing_account_state LIMIT 0");
  });

  it("queues and processes checkout.session.completed, recording the processed state", async () => {
    gateway.data = [billingSubscription(CUSTOMER)];
    await deliver("checkout.session.completed", { id: "evt_checkout_done" });
    expect(await queueRow("evt_checkout_done")).toMatchObject({
      state: "processed",
      outcome: "applied",
      attempts: 1,
      last_error: null,
      event_type: "checkout.session.completed",
    });
    expect((await plan()).plan).toBe("pro");
  });

  it("processes a duplicate event id exactly once", async () => {
    gateway.data = [billingSubscription(CUSTOMER)];
    await deliver("customer.subscription.updated", { id: "evt_dup" });
    await deliver("customer.subscription.updated", { id: "evt_dup" });
    await deliver("customer.subscription.updated", { id: "evt_dup" });
    expect(gateway.subscriptions).toHaveBeenCalledTimes(1);
    expect((await db.query("SELECT event_id FROM billing_events WHERE event_id='evt_dup'")).rows).toHaveLength(1);
    expect((await db.query("SELECT event_id FROM billing_webhook_queue")).rows).toHaveLength(1);
    expect((await queueRow("evt_dup")).attempts).toBe(1);
  });

  it("an older subscription.updated after a newer one does not restore the older (active) state", async () => {
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "canceled" })];
    const t = Math.floor(clock.getTime() / 1000);
    await deliver("customer.subscription.updated", { id: "evt_newer", created: t + 100, object: { status: "canceled" } });
    expect((await plan()).plan).toBe("free");
    await deliver("customer.subscription.updated", { id: "evt_older", created: t + 50, object: { status: "active" } });
    expect((await plan()).plan).toBe("free");
    expect((await queueRow("evt_older")).outcome).toBe("stale");
    expect(Number((await accountState()).last_subscription_event_created)).toBe(t + 100);
    expect((await accountState()).last_subscription_event_id).toBe("evt_newer");
  });

  it("an older canceled event after a newer active one keeps the newer Pro state", async () => {
    gateway.data = [billingSubscription(CUSTOMER)];
    const t = Math.floor(clock.getTime() / 1000);
    await deliver("customer.subscription.updated", { id: "evt_new_active", created: t + 10 });
    await deliver("customer.subscription.updated", { id: "evt_old_canceled", created: t - 500, object: { status: "canceled" } });
    expect((await plan()).plan).toBe("pro");
    expect((await queueRow("evt_old_canceled")).outcome).toBe("stale");
  });

  it("retries a failed event with exponential backoff and then processes it", async () => {
    gateway.subscriptions.mockRejectedValueOnce(new Error("provider detail that must not be stored"));
    gateway.data = [billingSubscription(CUSTOMER)];
    await expect(deliver("customer.subscription.updated", { id: "evt_retry" })).rejects.toMatchObject({
      code: "billing_provider_unavailable",
      status: 503,
    });
    const failed = await queueRow("evt_retry");
    expect(failed).toMatchObject({ state: "failed", attempts: 1, last_error: "billing_provider_unavailable" });
    expect(new Date(failed.next_attempt_at).getTime()).toBe(clock.getTime() + BILLING_QUEUE_BASE_DELAY_MS);
    expect(JSON.stringify(failed)).not.toContain("provider detail");
    expect((await plan()).plan).toBe("free");

    expect(await drainBillingWebhookQueue(service, db, { now })).toEqual({ processed: 0, failed: 0, dead: 0 });
    advance(BILLING_QUEUE_BASE_DELAY_MS);
    expect(await drainBillingWebhookQueue(service, db, { now })).toEqual({ processed: 1, failed: 0, dead: 0 });
    expect(await queueRow("evt_retry")).toMatchObject({ state: "processed", attempts: 2, last_error: null });
    expect((await plan()).plan).toBe("pro");
  });

  it("marks an event dead after max attempts and stops retrying it", async () => {
    gateway.subscriptions.mockRejectedValue(new Error("down"));
    await expect(deliver("invoice.payment_failed", { id: "evt_dead" })).rejects.toBeTruthy();
    for (let attempt = 2; attempt <= BILLING_QUEUE_MAX_ATTEMPTS; attempt++) {
      advance(BILLING_QUEUE_MAX_DELAY_MS);
      await drainBillingWebhookQueue(service, db, { now });
    }
    expect(await queueRow("evt_dead")).toMatchObject({ state: "dead", attempts: BILLING_QUEUE_MAX_ATTEMPTS });
    const calls = gateway.subscriptions.mock.calls.length;
    advance(BILLING_QUEUE_MAX_DELAY_MS);
    expect(await drainBillingWebhookQueue(service, db, { now })).toEqual({ processed: 0, failed: 0, dead: 0 });
    expect(gateway.subscriptions).toHaveBeenCalledTimes(calls);
  });

  it("a Stripe redelivery of a dead event is retried, not acknowledged unprocessed (Bora P2-4)", async () => {
    gateway.subscriptions.mockRejectedValue(new Error("down"));
    await expect(deliver("customer.subscription.updated", { id: "evt_dead_redelivery" })).rejects.toBeTruthy();
    for (let attempt = 2; attempt <= BILLING_QUEUE_MAX_ATTEMPTS; attempt++) {
      advance(BILLING_QUEUE_MAX_DELAY_MS);
      await drainBillingWebhookQueue(service, db, { now });
    }
    expect(await queueRow("evt_dead_redelivery")).toMatchObject({ state: "dead", attempts: BILLING_QUEUE_MAX_ATTEMPTS });
    // Provider still down: the redelivery is processed again and fails (5xx to Stripe), attempts restart.
    await expect(deliver("customer.subscription.updated", { id: "evt_dead_redelivery" })).rejects.toBeTruthy();
    expect(await queueRow("evt_dead_redelivery")).toMatchObject({ state: "failed", attempts: 1 });
    expect((await plan()).plan).toBe("free");
    // Provider back: the next redelivery applies the plan.
    gateway.subscriptions.mockReset();
    gateway.data = [billingSubscription(CUSTOMER)];
    await expect(deliver("customer.subscription.updated", { id: "evt_dead_redelivery" })).resolves.toBeUndefined();
    expect(await queueRow("evt_dead_redelivery")).toMatchObject({ state: "processed" });
    expect((await plan()).plan).toBe("pro");
  });

  it("backoff doubles from the base delay and is capped", () => {
    expect(billingQueueBackoffMs(1)).toBe(BILLING_QUEUE_BASE_DELAY_MS);
    expect(billingQueueBackoffMs(2)).toBe(2 * BILLING_QUEUE_BASE_DELAY_MS);
    expect(billingQueueBackoffMs(4)).toBe(8 * BILLING_QUEUE_BASE_DELAY_MS);
    expect(billingQueueBackoffMs(40)).toBe(BILLING_QUEUE_MAX_DELAY_MS);
  });

  it("rejects a tampered signed payload without queueing anything", async () => {
    const { signature } = signed({ id: "evt_tamper", type: "customer.subscription.updated", created: 1, data: { object: { customer: CUSTOMER } } });
    const forged = Buffer.from(JSON.stringify({ id: "evt_tamper", object: "event", livemode: false, type: "invoice.paid", created: 1, data: { object: { customer: CUSTOMER } } }));
    await expect(service.webhook(forged, signature)).rejects.toMatchObject({ code: "billing_webhook_signature", status: 400 });
    expect((await db.query("SELECT event_id FROM billing_webhook_queue")).rows).toHaveLength(0);
    expect(gateway.subscriptions).not.toHaveBeenCalled();
  });

  it("reconcile repairs a missed webhook from the (fake) gateway and records per-account failures", async () => {
    await db.query(
      "INSERT INTO billing_accounts(user_id,customer_id,customer_key,created_at) VALUES($1,$2,$3,$4)",
      ["bob", "cus_reconcile_bob", randomUUID(), clock.toISOString()],
    );
    gateway.data = [billingSubscription(CUSTOMER)];
    const real = gateway.subscriptions.getMockImplementation()!;
    gateway.subscriptions.mockImplementation(async (customerId: string) => {
      if (customerId === "cus_reconcile_bob") throw new Error("bob unavailable");
      return real(customerId);
    });
    expect((await plan()).plan).toBe("free");
    const result = await reconcileBillingAccounts(service, db);
    expect(result).toEqual({ reconciled: ["alice"], failed: ["bob"], cursor: null });
    expect((await plan()).plan).toBe("pro");
    expect((await db.query("SELECT event_id FROM billing_webhook_queue")).rows).toHaveLength(0);
  });

  it("invoice.payment_failed opens a 7-day grace period and keeps Pro until it ends", async () => {
    expect(BILLING_GRACE_PERIOD_MS).toBe(7 * DAY);
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed", { id: "evt_failed" });
    const graceEnd = clock.getTime() + BILLING_GRACE_PERIOD_MS;
    const user = await plan();
    expect(user.plan).toBe("pro");
    expect(new Date(user.plan_expires_at).getTime()).toBe(graceEnd);
    const state = await accountState();
    expect(new Date(state.grace_period_ends_at).getTime()).toBe(graceEnd);
    expect(state.downgraded_to_free_at).toBeNull();
    // A later past_due subscription event inside the window keeps the grace entitlement.
    advance(DAY);
    await deliver("customer.subscription.updated");
    expect((await plan()).plan).toBe("pro");
  });

  it("after grace expiry downgrades to free only as a DB flag and keeps projects and data", async () => {
    await db.query(
      "INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES('alice','p1','Keep me',1,'{}'::jsonb)",
    );
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed");
    advance(BILLING_GRACE_PERIOD_MS - 1000);
    expect(await expireGracePeriods(db, clock)).toEqual({ downgraded: [], resolved: [] });
    advance(2000);
    expect(await expireGracePeriods(db, clock)).toEqual({ downgraded: ["alice"], resolved: [] });
    expect(await plan()).toMatchObject({ plan: "free", plan_expires_at: null });
    expect(await accountState()).toMatchObject({ downgrade_reason: "grace_period_expired" });
    expect((await accountState()).downgraded_to_free_at).not.toBeNull();
    const projects = (await db.query("SELECT project_id,title,deleted_at FROM builder_projects WHERE owner_id='alice'")).rows;
    expect(projects).toEqual([{ project_id: "p1", title: "Keep me", deleted_at: null }]);
    expect((await db.query("SELECT user_id FROM billing_accounts WHERE user_id='alice'")).rows).toHaveLength(1);
    expect((await db.query("SELECT id FROM users WHERE id='alice'")).rows).toHaveLength(1);
    expect((await db.query("SELECT event_id FROM billing_events")).rows.length).toBeGreaterThan(0);
  });

  it("a recovered payment resolves the grace period so expiry never downgrades", async () => {
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed");
    gateway.data = [billingSubscription(CUSTOMER, { periodEnd: Math.floor(clock.getTime() / 1000) + 40 * 86400 })];
    await deliver("invoice.paid");
    expect((await accountState()).grace_resolved_at).not.toBeNull();
    advance(BILLING_GRACE_PERIOD_MS + DAY);
    expect(await expireGracePeriods(db, clock)).toEqual({ downgraded: [], resolved: [] });
    expect((await plan()).plan).toBe("pro");
  });

  it("does not open a grace period for an owner who was not Pro", async () => {
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed");
    expect((await plan()).plan).toBe("free");
    expect((await accountState())?.grace_period_ends_at ?? null).toBeNull();
  });

  it("a subscription that ends during grace sets the downgrade flag immediately", async () => {
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed");
    gateway.data = [billingSubscription(CUSTOMER, { status: "canceled" })];
    await deliver("customer.subscription.deleted");
    expect(await plan()).toMatchObject({ plan: "free", plan_expires_at: null });
    expect(await accountState()).toMatchObject({ downgrade_reason: "subscription_ended" });
  });

  it("the grace period length is configurable per service", async () => {
    service = makeService(DAY);
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed");
    expect(new Date((await plan()).plan_expires_at).getTime()).toBe(clock.getTime() + DAY);
    expect(() => makeService(-1)).toThrow();
  });

  it("one maintenance pass retries the queue, reconciles accounts and expires grace", async () => {
    await activatePro();
    gateway.data = [billingSubscription(CUSTOMER, { status: "past_due" })];
    await deliver("invoice.payment_failed");
    gateway.subscriptions.mockRejectedValueOnce(new Error("blip"));
    await expect(deliver("customer.subscription.updated", { id: "evt_blip" })).rejects.toBeTruthy();
    advance(BILLING_GRACE_PERIOD_MS + DAY);
    const result = await runBillingMaintenance(service, db, { now });
    expect(result.queue).toEqual({ processed: 1, failed: 0, dead: 0 });
    expect(result.accounts.reconciled).toEqual(["alice"]);
    expect((await queueRow("evt_blip")).state).toBe("processed");
    expect((await plan()).plan).toBe("free");
    expect((await accountState()).downgrade_reason).toBe("grace_period_expired");
  });

  it("maintenance timer is opt-in and validates its interval", () => {
    expect(readBillingMaintenanceInterval({})).toBeNull();
    expect(readBillingMaintenanceInterval({ BILLING_MAINTENANCE_INTERVAL_MS: "300000" })).toBe(300000);
    expect(() => readBillingMaintenanceInterval({ BILLING_MAINTENANCE_INTERVAL_MS: "10" })).toThrow();
    expect(() => readBillingMaintenanceInterval({ BILLING_MAINTENANCE_INTERVAL_MS: "abc" })).toThrow();
  });
});
