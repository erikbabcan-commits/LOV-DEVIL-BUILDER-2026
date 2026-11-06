/** Disposable loopback fixture. All provider methods are synthetic; no external Stripe traffic. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import Stripe from "stripe";
import { newDb } from "pg-mem";
import { createApp } from "../../server/index";
import { dbFromPool } from "../../server/db/pool";
import { applyMigrations } from "../../server/db/migrate";
import { PostgresQuotaStore } from "../../server/security/quotaStore";
import { InMemoryAiUsageStore } from "../../server/usage/store";
import { signToken } from "../../server/auth/tokens";
import { BillingService } from "../../server/billing/service";
import { verifyBillingEvent } from "../../server/billing/gateway";
import type {
  BillingConfig,
  BillingGateway,
  BillingSession,
  BillingSubscription,
} from "../../server/billing/types";
import { registerProjectByteLength } from "../helpers/projectMemoryDb";
if (process.env.BILLING_UI_FIXTURE !== "1" || process.env.NODE_ENV !== "test")
  throw new Error("Explicit test fixture required");
process.env.GITHUB_ALLOWED_ORIGINS = "http://localhost:5177";
const mem = newDb();
registerProjectByteLength(mem);
const pool = new (mem.adapters.createPg().Pool)(),
  db = dbFromPool(pool);
await applyMigrations(db);
for (const id of ["alice", "bob"])
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [
    id,
    id + "@example.test",
    "not-a-password",
  ]);
const config: BillingConfig = {
  secretKey: "sk_test_local_browser_fixture",
  webhookSecret: "whsec_local_browser_fixture",
  appUrl: "http://localhost:5177/",
  prices: {
    month: { priceId: "price_browser_month", amount: 2000 },
    year: { priceId: "price_browser_year", amount: 20000 },
  },
};
const sessions = new Map<string, BillingSession>();
let subscriptions: BillingSubscription[] = [],
  serial = 0;
const gateway: BillingGateway = {
  verifyEvent: (raw, signature) =>
    verifyBillingEvent(raw, signature, config.webhookSecret),
  price: async (id) => ({
    id,
    amount: id === config.prices.month.priceId ? 2000 : 20000,
    currency: "eur",
    interval: id === config.prices.month.priceId ? "month" : "year",
    intervalCount: 1,
    active: true,
    livemode: false,
  }),
  createCustomer: async (userId) => ({
    id: "cus_browser_" + userId,
    livemode: false,
  }),
  subscriptions: async (customerId) => ({
    data: subscriptions.filter((s) => s.customerId === customerId),
    hasMore: false,
  }),
  createCheckout: async (input) => {
    const s: BillingSession = {
      id: "cs_test_browser_" + ++serial,
      customerId: input.customerId,
      url: "https://checkout.stripe.com/c/pay/cs_test_browser_fixture",
      expiresAt: input.expiresAt,
      status: "open",
      livemode: false,
    };
    sessions.set(s.id, s);
    return s;
  },
  checkout: async (id) => {
    const s = sessions.get(id);
    if (!s) throw new Error("Unknown fixture session");
    return s;
  },
  createPortal: async () => ({
    url: "https://billing.stripe.com/p/session/test_browser_fixture",
  }),
};
const secret = "billing-browser-fixture-jwt-secret-01234567890123456789",
  service = new BillingService(db, config, gateway),
  quota = new PostgresQuotaStore(db);
const backend = createApp({}, null, {
    rateLimit: () => true,
    auth: {
      db,
      jwtSecret: secret,
      quota,
      usage: new InMemoryAiUsageStore(),
      ...(process.env.BILLING_FIXTURE_DISABLED === "1"
        ? {}
        : { billing: service }),
    },
  }),
  app = new Hono();
app.get("/__test/session/:owner", async (c) => {
  const owner = c.req.param("owner");
  if (!["alice", "bob"].includes(owner)) return c.notFound();
  c.header(
    "Set-Cookie",
    "lov_token=" +
      (await signToken(
        { sub: owner, email: owner + "@example.test", plan: "free" },
        secret,
      )) +
      "; Path=/; HttpOnly; SameSite=Lax",
  );
  c.header("Set-Cookie", "lov_csrf=billing-browser; Path=/; SameSite=Lax", {
    append: true,
  });
  return c.redirect("http://localhost:5177/");
});
app.get("/__test/state/:state", async (c) => {
  const state = c.req.param("state");
  if (!["pro", "cancel", "free"].includes(state)) return c.notFound();
  if (
    !(
      await db.query(
        "SELECT customer_id FROM billing_accounts WHERE user_id=$1",
        ["alice"],
      )
    ).rows[0]?.customer_id
  )
    await service.checkout("alice", "month", crypto.randomUUID());
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  subscriptions =
    state === "free"
      ? []
      : [
          {
            id: "sub_browser_fixture",
            customerId: "cus_browser_alice",
            livemode: false,
            status: "active",
            priceId: config.prices.month.priceId,
            quantity: 1,
            itemsCount: 1,
            periodEnd: end,
            trialEnd: null,
            cancelAtPeriodEnd: state === "cancel",
            collectionPaused: false,
          },
        ];
  const payload = JSON.stringify({
    id: "evt_browser_" + crypto.randomUUID().replaceAll("-", ""),
    object: "event",
    type: "customer.subscription.updated",
    livemode: false,
    data: {
      object: { id: "sub_browser_fixture", customer: "cus_browser_alice" },
    },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.webhookSecret,
  });
  const response = await backend.request("/api/billing/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": signature },
    body: payload,
  });
  if (!response.ok) return c.text("Synthetic webhook failed", 500);
  return c.redirect("/__test/session/alice");
});
app.route("/", backend);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8789 });
console.log(
  "Disposable billing fixture: 8789 -> frontend5177; synthetic provider, signed Hono webhooks, pg-mem, Alice/Bob only",
);
