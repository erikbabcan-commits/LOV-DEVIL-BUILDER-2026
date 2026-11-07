import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbLike } from "../../server/db/pool";
import { applyMigrations } from "../../server/db/migrate";
import { createApp } from "../../server/index";
import { signToken } from "../../server/auth/tokens";
import { PostgresQuotaStore } from "../../server/security/quotaStore";
import { BillingService } from "../../server/billing/service";
import { verifyBillingEvent } from "../../server/billing/gateway";
import type {
  BillingConfig,
  BillingGateway,
  BillingSession,
  BillingSubscription,
} from "../../server/billing/types";
import { BillingStatusSchema } from "../../shared/billing";

export const BILLING_TEST_CONFIG: BillingConfig = {
  secretKey: "sk_test_local_billing_contract_only",
  webhookSecret: "whsec_local_billing_contract_only",
  appUrl: "https://builder.example.test/",
  prices: {
    month: { priceId: "price_contract_month", amount: 2000 },
    year: { priceId: "price_contract_year", amount: 20000 },
  },
};
const jwtSecret = "billing-contract-jwt-secret-01234567890123456789";
const stripe = new Stripe(BILLING_TEST_CONFIG.secretKey);
const seconds = () => Math.floor(Date.now() / 1000);
export function billingSubscription(
  customerId: string,
  patch: Partial<BillingSubscription> = {},
): BillingSubscription {
  return {
    id: "sub_contract",
    customerId,
    livemode: false,
    status: "active",
    priceId: BILLING_TEST_CONFIG.prices.month.priceId,
    quantity: 1,
    itemsCount: 1,
    periodEnd: seconds() + 86400 * 30,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    collectionPaused: false,
    ...patch,
  };
}
/** Synthetic boundary only. Signatures still use the real Stripe SDK and every HTTP request goes through real Hono. */
export class BillingContractGateway implements BillingGateway {
  constructor(readonly livemode = false) {}
  data: BillingSubscription[] = [];
  hasMore = false;
  sessions = new Map<string, BillingSession>();
  customerSerial = 0;
  verifyEvent = (raw: Buffer, signature: string) =>
    verifyBillingEvent(raw, signature, BILLING_TEST_CONFIG.webhookSecret);
  price = vi.fn(async (id: string) => {
    const interval =
      id === BILLING_TEST_CONFIG.prices.month.priceId ? "month" : "year";
    return {
      id,
      amount: BILLING_TEST_CONFIG.prices[interval].amount,
      currency: "eur",
      interval,
      intervalCount: 1,
      active: true,
      livemode: this.livemode,
    };
  });
  createCustomer = vi.fn(async (_userId: string, _key: string) => ({
    id: "cus_contract_" + ++this.customerSerial,
    livemode: this.livemode,
  }));
  subscriptions = vi.fn(async (customerId: string) => ({
    data: this.data.filter((sub) => sub.customerId === customerId),
    hasMore: this.hasMore,
  }));
  createCheckout = vi.fn(
    async (
      input: Parameters<BillingGateway["createCheckout"]>[0],
      _key: string,
    ): Promise<BillingSession> => {
      const session: BillingSession = {
        id: (this.livemode ? "cs_live_" : "cs_test_") + this.sessions.size,
        customerId: input.customerId,
        url: "https://checkout.stripe.com/c/pay/cs_test_contract",
        expiresAt: input.expiresAt,
        status: "open",
        livemode: this.livemode,
      };
      this.sessions.set(session.id, session);
      return session;
    },
  );
  checkout = vi.fn(async (id: string): Promise<BillingSession> => {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown synthetic session");
    return session;
  });
  createPortal = vi.fn(
    async (
      _input: Parameters<BillingGateway["createPortal"]>[0],
      _key: string,
    ) => ({ url: "https://billing.stripe.com/p/session/test_contract" }),
  );
}
export function billingContract(
  name: string,
  connect: () => Promise<{ db: DbLike; close: () => Promise<void> }>,
  native = false,
) {
  describe(name, () => {
    let db: DbLike,
      close: () => Promise<void>,
      app: ReturnType<typeof createApp>,
      gateway: BillingContractGateway,
      service: BillingService;
    let tokens: Record<string, string>, quota: PostgresQuotaStore;
    const headers = (owner = "alice") => ({
      Cookie: "lov_token=" + tokens[owner] + "; lov_csrf=billing-test-csrf",
      "X-CSRF-Token": "billing-test-csrf",
      "Content-Type": "application/json",
    });
    const get = (path = "/api/billing", owner = "alice") =>
      app.request(path, { headers: headers(owner) });
    const post = (path: string, body: unknown, owner = "alice") =>
      app.request(path, {
        method: "POST",
        headers: headers(owner),
        body: JSON.stringify(body),
      });
    const event = async (
      patch: Record<string, unknown> = {},
      rawOverride?: string,
      timestamp?: number,
    ) => {
      const customerId = gateway.createCustomer.mock.results[0]
        ? (await gateway.createCustomer.mock.results[0].value).id
        : "cus_unbound";
      const payload = JSON.stringify({
        id: "evt_" + randomUUID().replaceAll("-", ""),
        object: "event",
        type: "customer.subscription.updated",
        livemode: false,
        created: seconds(),
        data: {
          object: {
            id: "sub_contract",
            object: "subscription",
            customer: customerId,
          },
        },
        ...patch,
      });
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: BILLING_TEST_CONFIG.webhookSecret,
        ...(timestamp === undefined ? {} : { timestamp }),
      });
      return app.request("/api/billing/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": signature,
          "Content-Type": "application/json",
        },
        body: rawOverride ?? payload,
      });
    };
    const beginCheckout = async (
      owner = "alice",
      requestId = randomUUID(),
      interval: "month" | "year" = "month",
    ) => {
      const response = await post(
        "/api/billing/checkout",
        { interval, requestId },
        owner,
      );
      expect(
        response.status,
        (await response.clone().text()) +
          " provider calls=" +
          JSON.stringify({
            price: gateway.price.mock.calls.length,
            customer: gateway.createCustomer.mock.calls.length,
            subscriptions: gateway.subscriptions.mock.calls.length,
            checkout: gateway.createCheckout.mock.calls.length,
          }),
      ).toBe(200);
      return {
        requestId,
        body: (await response.json()) as { userId: string; url: string },
      };
    };
    const bindAndActivate = async (
      patch: Partial<BillingSubscription> = {},
    ) => {
      await beginCheckout();
      const customerId = (await gateway.createCustomer.mock.results[0].value)
        .id;
      gateway.data = [billingSubscription(customerId, patch)];
      for (const session of gateway.sessions.values())
        session.status = "complete";
      const result = await event();
      expect(result.status).toBe(200);
      return customerId;
    };
    // Native cluster/schema/crypto cold start is fixture setup, separate from API deadlines.
    beforeEach(
      async () => {
        ({ db, close } = await connect());
        await applyMigrations(db);
        tokens = {};
        for (const id of ["alice", "bob"]) {
          await db.query(
            "INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)",
            [id, id + "@billing.example.test", "not-an-authentication-hash"],
          );
          tokens[id] = await signToken(
            { sub: id, email: id + "@billing.example.test", plan: "free" },
            jwtSecret,
          );
        }
        gateway = new BillingContractGateway();
        service = new BillingService(db, BILLING_TEST_CONFIG, gateway);
        quota = new PostgresQuotaStore(db);
        app = createApp({}, null, {
          rateLimit: () => true,
          auth: { db, jwtSecret, quota, billing: service },
        });
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error(
              "External HTTP forbidden in the local billing contract",
            );
          }),
        );
      },
      native ? 60_000 : 10_000,
    );
    afterEach(async () => {
      try {
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        if (close) await close();
      }
    });

    it("returns validated server-owned sandbox pricing without changing the account plan", async () => {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const status = BillingStatusSchema.parse(await response.json());
      expect(status).toMatchObject({
        userId: "alice",
        enabled: true,
        mode: "sandbox",
        plan: "free",
        trialDays: 14,
        subscription: null,
        prices: {
          month: { amount: 2000, currency: "eur" },
          year: { amount: 20000, currency: "eur" },
        },
      });
      expect(gateway.createCustomer).not.toHaveBeenCalled();
    });
    it("reports disabled billing explicitly and makes no provider request", async () => {
      const disabled = createApp({}, null, {
        rateLimit: () => true,
        auth: { db, jwtSecret, quota },
      });
      const response = await disabled.request("/api/billing", {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      expect(BillingStatusSchema.parse(await response.json())).toMatchObject({
        enabled: false,
        mode: "disabled",
        plan: "free",
        prices: { month: null, year: null },
        checkoutAvailable: false,
        portalAvailable: false,
      });
      expect(
        (
          await disabled.request("/api/billing/webhook", {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(503);
      expect(gateway.createCustomer).not.toHaveBeenCalled();
    });
    it("requires authenticated ownership, CSRF and an exact checkout request schema before provider calls", async () => {
      expect((await app.request("/api/billing")).status).toBe(401);
      expect(
        (
          await app.request("/api/billing/checkout", {
            method: "POST",
            headers: {
              Cookie: "lov_token=" + tokens.alice,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              interval: "month",
              requestId: randomUUID(),
            }),
          })
        ).status,
      ).toBe(403);
      for (const body of [
        { interval: "week", requestId: randomUUID() },
        { interval: "month", requestId: "invalid" },
        { interval: "month", requestId: randomUUID(), customer: "cus_foreign" },
        {
          interval: "month",
          requestId: randomUUID(),
          returnUrl: "https://evil.example/",
        },
      ])
        expect((await post("/api/billing/checkout", body)).status).toBe(400);
      expect(gateway.createCheckout).not.toHaveBeenCalled();
      expect(gateway.createCustomer).not.toHaveBeenCalled();
    });
    it("creates checkout with the server price, bound customer and fixed return destinations", async () => {
      const { body } = await beginCheckout("alice", randomUUID(), "year");
      expect(body.userId).toBe("alice");
      expect(new URL(body.url).hostname).toBe("checkout.stripe.com");
      const input = gateway.createCheckout.mock.calls[0][0];
      expect(input).toMatchObject({
        priceId: BILLING_TEST_CONFIG.prices.year.priceId,
        customerId: "cus_contract_1",
        trialDays: 14,
      });
      expect(new URL(input.successUrl).origin).toBe(
        "https://builder.example.test",
      );
      expect(new URL(input.cancelUrl).origin).toBe(
        "https://builder.example.test",
      );
      expect((await (await get("/api/auth/me")).json()).user.plan).toBe("free");
    });
    it("reuses one pending checkout across retries and refuses a competing interval", async () => {
      const { requestId, body } = await beginCheckout();
      const again = await post("/api/billing/checkout", {
        interval: "month",
        requestId,
      });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(body);
      expect(gateway.createCheckout).toHaveBeenCalledTimes(1);
      expect(
        (await post("/api/billing/checkout", { interval: "year", requestId }))
          .status,
      ).toBe(409);
      const recovered = await post("/api/billing/checkout", {
        interval: "month",
        requestId: randomUUID(),
      });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).userId).toBe("alice");
      expect(gateway.createCheckout).toHaveBeenCalledTimes(1);
    });
    it("recovers a completed checkout past its expiry deadline after a reconciliation failure", async () => {
      const { requestId } = await beginCheckout();
      const [session] = gateway.sessions.values();
      session.status = "complete";
      const retry = () =>
        post("/api/billing/checkout", { interval: "month", requestId });
      const attempt = async () =>
        (
          await db.query(
            "SELECT state,session_url FROM billing_checkout_attempts WHERE request_id=$1",
            [requestId],
          )
        ).rows[0];

      gateway.checkout.mockImplementationOnce(async () => {
        gateway.subscriptions.mockRejectedValueOnce(new Error("Stripe offline"));
        return session;
      });
      const unavailable = await retry();
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({
        error: "billing_provider_unavailable",
      });
      expect((await attempt()).state).toBe("ready");

      session.expiresAt = seconds() - 1;
      session.subscriptionId = "sub_contract";
      gateway.data = [
        billingSubscription(session.customerId, {
          id: "sub_unrelated",
          status: "canceled",
        }),
      ];
      expect(
        (
          await event({
            type: "checkout.session.completed",
            data: { object: { id: session.id, customer: session.customerId } },
          })
        ).status,
      ).toBe(200);
      expect((await attempt()).state).toBe("ready");
      const unconfirmed = await retry();
      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toEqual({
        error: "billing_reconciliation_required",
      });
      const another = await post("/api/billing/checkout", {
        interval: "month",
        requestId: randomUUID(),
      });
      expect(another.status).toBe(409);
      expect(await another.json()).toEqual({
        error: "billing_reconciliation_required",
      });
      expect(gateway.createCheckout).toHaveBeenCalledTimes(1);

      gateway.checkout.mockImplementationOnce(async () => {
        gateway.data = [billingSubscription(session.customerId)];
        return session;
      });
      const completed = await retry();
      expect(completed.status).toBe(409);
      expect(await completed.json()).toEqual({
        error: "billing_subscription_exists",
      });
      expect(await attempt()).toEqual({ state: "complete", session_url: null });
      expect((await quota.usage("alice")).plan).toBe("pro");
      expect(gateway.createCheckout).toHaveBeenCalledTimes(1);

      gateway.data = [
        billingSubscription(session.customerId, { status: "canceled" }),
      ];
      const closed = await retry();
      expect(closed.status).toBe(409);
      expect(await closed.json()).toEqual({ error: "billing_checkout_expired" });
      expect(await attempt()).toEqual({ state: "complete", session_url: null });
      expect((await quota.usage("alice")).plan).toBe("free");
      await beginCheckout("alice", randomUUID(), "year");
      expect(gateway.createCheckout).toHaveBeenCalledTimes(2);
      expect(gateway.createCheckout.mock.calls[1][0].trialDays).toBeNull();
    });
    it("never shares a checkout request UUID or customer binding with another account", async () => {
      const { requestId } = await beginCheckout("alice");
      expect(
        (
          await post(
            "/api/billing/checkout",
            { interval: "month", requestId },
            "bob",
          )
        ).status,
      ).toBe(409);
      expect(gateway.createCheckout).toHaveBeenCalledTimes(1);
      const bob = await beginCheckout("bob");
      expect(bob.body.userId).toBe("bob");
      expect(gateway.createCheckout.mock.calls[1][0].customerId).not.toBe(
        gateway.createCheckout.mock.calls[0][0].customerId,
      );
      expect((await quota.usage("alice")).plan).toBe("free");
      expect((await quota.usage("bob")).plan).toBe("free");
    });
    it.each([
      ["past due", { status: "past_due" }],
      ["unpaid", { status: "unpaid" }],
      ["incomplete", { status: "incomplete" }],
      ["paused", { status: "paused" }],
      ["active with expired local period", { periodEnd: 1 }],
      ["unconfigured active price", { priceId: "price_unrelated_product" }],
      ["non-unit active quantity", { quantity: 2 }],
      ["multiple active items", { itemsCount: 2 }],
    ] as Array<[string, Partial<BillingSubscription>]>)(
      "refuses another subscription while the canonical customer has a %s subscription",
      async (_name, patch) => {
        await beginCheckout();
        const customer = (await gateway.createCustomer.mock.results[0].value)
            .id,
          session = [...gateway.sessions.values()][0];
        session.status = "complete";
        expect(
          (
            await event({
              type: "checkout.session.completed",
              data: { object: { id: session.id, customer } },
            })
          ).status,
        ).toBe(200);
        gateway.data = [billingSubscription(customer, patch)];
        const response = await post("/api/billing/checkout", {
          interval: "month",
          requestId: randomUUID(),
        });
        expect(response.status).toBe(409);
        expect(gateway.createCheckout).toHaveBeenCalledTimes(1);
        expect(await (await get()).json()).toMatchObject({
          checkoutAvailable: false,
          portalAvailable: true,
        });
      },
    );
    it("keeps ambiguous checkout failures bound to the original idempotency key", async () => {
      gateway.createCheckout.mockRejectedValueOnce(
        new Error("upstream secret sk_test_do_not_expose"),
      );
      const requestId = randomUUID();
      const failed = await post("/api/billing/checkout", {
        interval: "month",
        requestId,
      });
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("sk_test_do_not_expose");
      const recovered = await post("/api/billing/checkout", {
        interval: "month",
        requestId: randomUUID(),
      });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).userId).toBe("alice");
      expect(
        (await post("/api/billing/checkout", { interval: "month", requestId }))
          .status,
      ).toBe(200);
      expect(gateway.createCheckout.mock.calls).toHaveLength(2);
      expect(gateway.createCheckout.mock.calls[0]).toEqual(
        gateway.createCheckout.mock.calls[1],
      );
    });
    it("does not grant Pro from checkout creation or browser success query parameters", async () => {
      await beginCheckout();
      expect(
        (await get("/api/billing?success=1&session_id=cs_test_forged")).status,
      ).toBe(400);
      expect((await (await get("/api/auth/me")).json()).user.plan).toBe("free");
      expect((await quota.usage("alice")).limit).toBe(10);
    });
    it("uses signed canonical subscription state to upgrade the same cookie without resetting monthly usage", async () => {
      for (let i = 0; i < 10; i++)
        expect((await quota.consume("alice")).ok).toBe(true);
      expect((await quota.consume("alice")).ok).toBe(false);
      await bindAndActivate();
      const me = await (await get("/api/auth/me")).json();
      expect(me.user.plan).toBe("pro");
      expect(me.quota).toMatchObject({
        plan: "pro",
        used: 10,
        limit: 200,
        remaining: 190,
      });
      expect((await quota.consume("alice")).snapshot).toMatchObject({
        plan: "pro",
        used: 11,
        limit: 200,
      });
      expect((await (await get("/api/auth/me", "bob")).json()).user.plan).toBe(
        "free",
      );
      expect(
        (await db.query("SELECT COUNT(*)::int AS n FROM ai_runs")).rows[0].n,
      ).toBe(0);
    });
    it("keeps project source and immutable history unchanged across subscription activation and downgrade", async () => {
      const workspace = {
        title: "Billing must preserve sources",
        isPublic: false,
        liveId: "v1",
        files: [{ name: "index.html", content: "<main>unchanged</main>" }],
        snapshots: [
          {
            id: "v1",
            v: 1,
            kind: "manual",
            time: "now",
            prompt: "source",
            html: "<main>unchanged</main>",
          },
        ],
      };
      expect(
        (
          await post("/api/projects/billing-project", {
            expectedRevision: 0,
            workspace,
          })
        ).status,
      ).toBe(201);
      const before = await (await get("/api/projects/billing-project")).json();
      const customer = await bindAndActivate();
      gateway.data = [billingSubscription(customer, { status: "canceled" })];
      expect((await event()).status).toBe(200);
      expect(await (await get("/api/projects/billing-project")).json()).toEqual(
        before,
      );
    });
    it("applies a finite trial and never offers another trial after a completed subscription", async () => {
      const customer = await bindAndActivate({
        status: "trialing",
        trialEnd: seconds() + 86400 * 14,
      });
      expect((await quota.usage("alice")).plan).toBe("pro");
      expect(
        (
          await post("/api/billing/checkout", {
            requestId: randomUUID(),
            interval: "month",
          })
        ).status,
      ).toBe(409);
      expect(gateway.createCheckout).toHaveBeenCalledTimes(1);
      const session = [...gateway.sessions.values()][0];
      expect(
        (
          await event({
            type: "checkout.session.completed",
            data: { object: { id: session.id, customer } },
          })
        ).status,
      ).toBe(200);
      gateway.data = [billingSubscription(customer, { status: "canceled" })];
      expect((await event()).status).toBe(200);
      await beginCheckout("alice", randomUUID(), "year");
      expect(gateway.createCheckout.mock.calls[1][0].trialDays).toBeNull();
    });
    it("retains paid access through scheduled cancellation then revokes it on current canceled state", async () => {
      const customer = await bindAndActivate({ cancelAtPeriodEnd: true });
      expect((await (await get()).json()).subscription.cancelAtPeriodEnd).toBe(
        true,
      );
      expect((await quota.usage("alice")).plan).toBe("pro");
      gateway.data = [
        billingSubscription(customer, {
          status: "canceled",
          cancelAtPeriodEnd: false,
        }),
      ];
      expect((await event()).status).toBe(200);
      expect((await (await get("/api/auth/me")).json()).user.plan).toBe("free");
    });
    it("enforces finite expiry even if no cancellation webhook arrives", async () => {
      await bindAndActivate();
      await db.query("UPDATE users SET plan_expires_at=$2 WHERE id=$1", [
        "alice",
        new Date(Date.now() - 60000),
      ]);
      expect((await (await get("/api/auth/me")).json()).user.plan).toBe("free");
      expect((await quota.usage("alice")).plan).toBe("free");
    });
    it("reconciles reordered events against current Stripe state instead of trusting old event payloads", async () => {
      const customer = await bindAndActivate();
      gateway.data = [billingSubscription(customer, { status: "canceled" })];
      expect(
        (
          await event({
            created: 1,
            data: {
              object: {
                id: "sub_old",
                customer,
                status: "active",
                metadata: { plan: "pro" },
              },
            },
          })
        ).status,
      ).toBe(200);
      expect((await quota.usage("alice")).plan).toBe("free");
    });
    it("deduplicates a signed event without fetching or granting twice", async () => {
      const customer = await bindAndActivate(),
        patch = {
          id: "evt_duplicate_contract",
          data: { object: { id: "sub_contract", customer } },
        };
      expect((await event(patch)).status).toBe(200);
      const reads = gateway.subscriptions.mock.calls.length;
      expect((await event(patch)).status).toBe(200);
      expect(gateway.subscriptions).toHaveBeenCalledTimes(reads);
    });
    it.each([
      "past_due",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ] as const)(
      "does not grant access for %s subscriptions",
      async (status) => {
        await bindAndActivate({ status });
        expect((await quota.usage("alice")).plan).toBe("free");
      },
    );
    it.each([
      ["unconfigured price", { priceId: "price_unknown" }],
      ["wrong quantity", { quantity: 2 }],
      ["multiple items", { itemsCount: 2 }],
      ["expired period", { periodEnd: 1 }],
      ["paused collection", { collectionPaused: true }],
      ["live subscription", { livemode: true }],
    ] as Array<[string, Partial<BillingSubscription>]>)(
      "fails closed for %s",
      async (_name, patch) => {
        await beginCheckout();
        const customer = (await gateway.createCustomer.mock.results[0].value)
          .id;
        gateway.data = [billingSubscription(customer, patch)];
        const response = await event();
        expect([200, 400, 409, 503]).toContain(response.status);
        expect((await quota.usage("alice")).plan).toBe("free");
      },
    );
    it("rejects a canonical subscription whose customer differs from its bound owner", async () => {
      await beginCheckout();
      gateway.subscriptions.mockResolvedValueOnce({
        data: [billingSubscription("cus_someone_else")],
        hasMore: false,
      });
      const response = await event();
      expect([200, 400, 409, 503]).toContain(response.status);
      expect((await quota.usage("alice")).plan).toBe("free");
      expect((await quota.usage("bob")).plan).toBe("free");
    });
    it("does not activate an unrelated customer or accept event metadata as account binding", async () => {
      gateway.data = [billingSubscription("cus_unbound")];
      const response = await event({
        data: {
          object: {
            id: "sub_foreign",
            customer: "cus_unbound",
            metadata: { userId: "alice", plan: "pro" },
          },
        },
      });
      expect([200, 400]).toContain(response.status);
      expect((await quota.usage("alice")).plan).toBe("free");
      expect(gateway.createCustomer).not.toHaveBeenCalled();
    });
    it("rejects invalid signatures, stale signatures and modified raw bytes before provider reads", async () => {
      const malformed = await app.request("/api/billing/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "t=1,v1=forged",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(malformed.status).toBe(400);
      expect((await event({}, "{}")).status).toBe(400);
      expect((await event({}, undefined, seconds() - 1000)).status).toBe(400);
      expect(gateway.subscriptions).not.toHaveBeenCalled();
    });
    it("bounds raw webhook input and does not exempt other webhook methods from authentication", async () => {
      expect((await app.request("/api/billing/webhook")).status).toBe(401);
      const response = await app.request("/api/billing/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "invalid",
          "Content-Type": "application/json",
        },
        body: "x".repeat(1024 * 1024),
      });
      expect(response.status).toBe(413);
      expect(gateway.subscriptions).not.toHaveBeenCalled();
    });
    it.each([{ livemode: true }, { account: "acct_connected_other" }])(
      "rejects a live or Connect event (%j)",
      async (patch) => {
        expect((await event(patch)).status).toBe(400);
        expect(gateway.subscriptions).not.toHaveBeenCalled();
      },
    );
    it("does not claim a Pro plan when canonical subscription reads fail", async () => {
      await beginCheckout();
      gateway.subscriptions.mockRejectedValueOnce(
        new Error("provider request includes private detail"),
      );
      const response = await event();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private detail");
      expect((await quota.usage("alice")).plan).toBe("free");
    });
    it("rejects incomplete canonical pages rather than granting from a partial list", async () => {
      await beginCheckout();
      gateway.data = [
        billingSubscription(
          (await gateway.createCustomer.mock.results[0].value).id,
        ),
      ];
      gateway.hasMore = true;
      expect((await event()).status).toBe(503);
      expect((await quota.usage("alice")).plan).toBe("free");
    });
    it("portal uses only the verified customer and never a browser-supplied customer or destination", async () => {
      await bindAndActivate();
      expect(
        (
          await post("/api/billing/portal", {
            requestId: randomUUID(),
            customerId: "cus_other",
          })
        ).status,
      ).toBe(400);
      const response = await post("/api/billing/portal", {
        requestId: randomUUID(),
      });
      expect(response.status).toBe(200);
      expect(gateway.createPortal.mock.calls[0][0]).toEqual({
        customerId: "cus_contract_1",
        returnUrl: expect.stringContaining("https://builder.example.test/"),
      });
      expect(
        (await post("/api/billing/portal", { requestId: randomUUID() }, "bob"))
          .status,
      ).toBe(409);
    });
    it("never returns a provider-controlled redirect outside the exact Stripe hosts", async () => {
      gateway.createCheckout.mockImplementationOnce(async (input) => ({
        id: "cs_test_bad",
        customerId: input.customerId,
        url: "https://checkout.stripe.com.evil.example/pay",
        expiresAt: input.expiresAt,
        status: "open",
        livemode: false,
      }));
      const response = await post("/api/billing/checkout", {
        requestId: randomUUID(),
        interval: "month",
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("evil.example");
    });
    it("validates the configured price against Stripe before creating a session", async () => {
      gateway.price.mockImplementationOnce(async (id) => ({
        id,
        amount: 1,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        active: true,
        livemode: false,
      }));
      expect(
        (
          await post("/api/billing/checkout", {
            requestId: randomUUID(),
            interval: "month",
          })
        ).status,
      ).toBe(503);
      expect(gateway.createCheckout).not.toHaveBeenCalled();
    });
    if (native) {
      it("rolls back entitlement and event receipt together when the durable receipt cannot be written", async () => {
        await beginCheckout();
        const customer = (await gateway.createCustomer.mock.results[0].value)
          .id;
        gateway.data = [billingSubscription(customer)];
        let fail = true;
        const faultDb: DbLike = {
          query: db.query,
          transaction: (work) =>
            db.transaction!((tx) =>
              work({
                query: async (sql, params) => {
                  if (fail && sql.startsWith("INSERT INTO billing_events")) {
                    fail = false;
                    throw new Error("injected receipt storage failure");
                  }
                  return tx.query(sql, params);
                },
              }),
            ),
        };
        app = createApp({}, null, {
          rateLimit: () => true,
          auth: {
            db,
            jwtSecret,
            quota,
            billing: new BillingService(faultDb, BILLING_TEST_CONFIG, gateway),
          },
        });
        const patch = {
          id: "evt_native_rollback",
          data: { object: { id: "sub_contract", customer } },
        };
        expect((await event(patch)).status).toBe(503);
        expect((await quota.usage("alice")).plan).toBe("free");
        expect(
          (
            await db.query(
              "SELECT COUNT(*)::int AS n FROM billing_events WHERE event_id=$1",
              [patch.id],
            )
          ).rows[0].n,
        ).toBe(0);
        expect((await event(patch)).status).toBe(200);
        expect((await quota.usage("alice")).plan).toBe("pro");
        expect(
          (
            await db.query(
              "SELECT COUNT(*)::int AS n FROM billing_events WHERE event_id=$1",
              [patch.id],
            )
          ).rows[0].n,
        ).toBe(1);
      });
      it("serializes concurrent duplicate delivery and quota admissions on the real owner lock", async () => {
        const customer = await bindAndActivate();
        const patch = {
          id: "evt_native_duplicate",
          data: { object: { id: "sub_contract", customer } },
        };
        const responses = await Promise.all(
          Array.from({ length: 4 }, () => event(patch)),
        );
        expect(responses.every((response) => response.status === 200)).toBe(
          true,
        );
        const used = await Promise.all(
          Array.from({ length: 12 }, () => quota.consume("alice")),
        );
        expect(used.every((result) => result.ok)).toBe(true);
        expect((await quota.usage("alice")).used).toBe(12);
        gateway.data = [billingSubscription(customer, { status: "canceled" })];
        expect((await event()).status).toBe(200);
        expect((await quota.consume("alice")).ok).toBe(false);
        expect(await quota.usage("alice")).toMatchObject({
          used: 12,
          limit: 10,
          remaining: 0,
          plan: "free",
        });
      });
    }
  });
}
