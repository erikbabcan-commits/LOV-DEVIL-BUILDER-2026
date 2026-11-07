import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbLike } from "../../server/db/pool";
import { applyMigrations } from "../../server/db/migrate";
import { createApp } from "../../server/index";
import { signToken } from "../../server/auth/tokens";
import { PostgresQuotaStore } from "../../server/security/quotaStore";
import {
  BillingService,
  initializeBillingEnvironment,
  probeBillingSchema,
} from "../../server/billing/service";
import type { BillingConfig } from "../../server/billing/types";
import type { BillingMode } from "../../server/billing/config";
import { BillingStatusSchema } from "../../shared/billing";
import {
  BillingContractGateway,
  BILLING_TEST_CONFIG,
  billingSubscription,
} from "./billingContract";

const secret = "billing-mode-local-jwt-secret-01234567890123456789";
const configFor = (mode: BillingMode): BillingConfig => ({
  ...BILLING_TEST_CONFIG,
  mode,
  secretKey:
    mode === "live"
      ? "sk_live_local_billing_mode_contract_only"
      : BILLING_TEST_CONFIG.secretKey,
});
const signer = new Stripe(BILLING_TEST_CONFIG.secretKey);
const future = () => Math.floor(Date.now() / 1000) + 86400;

export function billingModeContract(
  name: string,
  connect: () => Promise<{ db: DbLike; close: () => Promise<void> }>,
  native = false,
) {
  describe(name, () => {
    let db: DbLike, close: () => Promise<void>, token: string;
    beforeEach(
      async () => {
        ({ db, close } = await connect());
        await applyMigrations(db);
        for (const user of ["alice", "bob"])
          await db.query(
            "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
            [user, user + "@billing-mode.example.test", "not-a-password"],
          );
        token = await signToken(
          {
            sub: "alice",
            email: "alice@billing-mode.example.test",
            plan: "free",
          },
          secret,
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error(
              "External HTTP is forbidden in the billing-mode contract",
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
    function application(mode: BillingMode) {
      const gateway = new BillingContractGateway(mode === "live");
      const service = new BillingService(db, configFor(mode), gateway);
      const quota = new PostgresQuotaStore(db);
      const app = createApp({}, null, {
        rateLimit: () => true,
        auth: { db, jwtSecret: secret, quota, billing: service },
      });
      const headers = {
        Cookie: "lov_token=" + token + "; lov_csrf=billing-mode-csrf",
        "X-CSRF-Token": "billing-mode-csrf",
        "Content-Type": "application/json",
      };
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      const event = (
        customer: string,
        livemode: boolean,
        extra: Record<string, unknown> = {},
      ) => {
        const payload = JSON.stringify({
          id: "evt_" + randomUUID().replaceAll("-", ""),
          object: "event",
          type: "customer.subscription.updated",
          livemode,
          data: { object: { id: "sub_mode_contract", customer } },
          ...extra,
        });
        const signature = signer.webhooks.generateTestHeaderString({
          payload,
          secret: BILLING_TEST_CONFIG.webhookSecret,
        });
        return app.request("/api/billing/webhook", {
          method: "POST",
          headers: {
            "Stripe-Signature": signature,
            "Content-Type": "application/json",
          },
          body: payload,
        });
      };
      const checkout = () =>
        post("/api/billing/checkout", {
          interval: "month",
          requestId: randomUUID(),
        });
      const status = () => app.request("/api/billing", { headers });
      const customer = async () => {
        const response = await checkout();
        expect(response.status, await response.clone().text()).toBe(200);
        return (await gateway.createCustomer.mock.results[0].value).id;
      };
      return {
        gateway,
        service,
        quota,
        app,
        post,
        event,
        checkout,
        status,
        customer,
      };
    }
    it.each(["test", "live"] as const)(
      "records positive Pro invoice evidence only in live mode (%s)",
      async (mode) => {
        const api = application(mode);
        const live = mode === "live";
        const customer = await api.customer();
        api.gateway.data = [billingSubscription(customer, { livemode: live, periodEnd: future() })];
        const paidAt = Math.floor(Date.now() / 1000) - 10;
        const delivery = (eventId: string, fields: Record<string, unknown> = {}) => api.event(customer, live, {
          id: eventId,
          type: "invoice.paid",
          created: paidAt + 5,
          data: { object: {
            id: "in_contract",
            object: "invoice",
            customer,
            status: "paid",
            currency: "eur",
            livemode: live,
            amount_paid: 2000,
            status_transitions: { paid_at: paidAt },
            parent: { type: "subscription_details", subscription_details: { subscription: "sub_contract" } },
            ...fields,
          } },
        });
        const attempts = [
          ["evt_positive", {}],
          ["evt_zero", { amount_paid: 0 }],
          ["evt_other_currency", { currency: "usd" }],
          ["evt_other_subscription", { parent: null, subscription: "sub_unrecognized" }],
          ["evt_mismatch", { subscription: "sub_conflicting" }],
          ["evt_future_paid", { status_transitions: { paid_at: paidAt + 6 } }],
          ["evt_legacy", { parent: null, subscription: "sub_contract" }],
        ] as const;
        for (const [eventId, fields] of attempts)
          expect((await delivery(eventId, fields)).status).toBe(200);
        expect((await delivery("evt_positive")).status).toBe(200);
        const rows = (await db.query(
          "SELECT event_id,positive_pro_invoice_paid_at FROM billing_events ORDER BY event_id",
        )).rows;
        expect(rows).toHaveLength(attempts.length);
        const recorded = rows.filter(row => row.positive_pro_invoice_paid_at !== null);
        expect(recorded.map(row => row.event_id)).toEqual(live ? ["evt_legacy", "evt_positive"] : []);
        expect(recorded.every(row => new Date(row.positive_pro_invoice_paid_at).getTime() === paidAt * 1000)).toBe(true);
      },
    );
    it.each(["test", "live"] as const)(
      "runs the complete %s-mode lifecycle without resetting monthly usage",
      async (mode) => {
        const api = application(mode),
          live = mode === "live";
        for (let i = 0; i < 8; i++)
          expect((await api.quota.consume("alice")).ok).toBe(true);
        const status = BillingStatusSchema.parse(
          await (await api.status()).json(),
        );
        expect(status.mode).toBe(live ? "live" : "sandbox");
        expect(status.plan).toBe("free");
        const customer = await api.customer();
        expect(api.gateway.createCustomer.mock.calls[0][1]).toMatch(
          new RegExp("^forge-" + mode + "-customer:"),
        );
        expect(api.gateway.createCheckout.mock.calls[0][1]).toMatch(
          new RegExp("^forge-" + mode + "-checkout:"),
        );
        api.gateway.data = [
          billingSubscription(customer, {
            livemode: live,
            periodEnd: future(),
          }),
        ];
        expect((await api.event(customer, !live)).status).toBe(400);
        expect((await api.quota.usage("alice")).plan).toBe("free");
        expect((await api.event(customer, live)).status).toBe(200);
        expect(await api.quota.usage("alice")).toMatchObject({
          plan: "pro",
          used: 8,
          limit: 200,
          remaining: 192,
        });
        expect(
          (await api.post("/api/billing/portal", { requestId: randomUUID() }))
            .status,
        ).toBe(200);
        expect(api.gateway.createPortal.mock.calls[0][1]).toMatch(
          new RegExp("^forge-" + mode + "-portal:"),
        );
        api.gateway.data = [
          billingSubscription(customer, { livemode: live, status: "canceled" }),
        ];
        expect((await api.event(customer, live)).status).toBe(200);
        expect(await api.quota.usage("alice")).toMatchObject({
          plan: "free",
          used: 8,
          limit: 10,
          remaining: 2,
        });
      },
    );
    const boundaries = (["test", "live"] as const).flatMap((mode) =>
      (["price", "customer", "checkout", "subscription", "event"] as const).map(
        (boundary) => ({ mode, boundary }),
      ),
    );
    it.each(boundaries)(
      "rejects the opposite environment at $mode/$boundary before any entitlement grant",
      async ({ mode, boundary }) => {
        const api = application(mode),
          live = mode === "live";
        if (boundary === "price") {
          const price = await api.gateway.price(
            BILLING_TEST_CONFIG.prices.month.priceId,
          );
          api.gateway.price.mockResolvedValue({ ...price, livemode: !live });
          expect((await api.checkout()).status).toBe(503);
          expect(api.gateway.createCustomer).not.toHaveBeenCalled();
        } else if (boundary === "customer") {
          api.gateway.createCustomer.mockResolvedValue({
            id: "cus_wrong_environment",
            livemode: !live,
          });
          expect((await api.checkout()).status).toBe(503);
          expect(api.gateway.createCheckout).not.toHaveBeenCalled();
          expect(
            (
              await db.query(
                "SELECT customer_id FROM billing_accounts WHERE user_id=$1",
                ["alice"],
              )
            ).rows[0].customer_id,
          ).toBeNull();
        } else if (boundary === "checkout") {
          api.gateway.createCheckout.mockImplementation(async (input) => ({
            id: "cs_wrong_environment",
            customerId: input.customerId,
            url: "https://checkout.stripe.com/c/pay/wrong",
            expiresAt: input.expiresAt,
            status: "open",
            livemode: !live,
          }));
          const response = await api.checkout();
          expect(response.status).toBe(503);
          expect(await response.text()).not.toContain("https://checkout");
        } else {
          const customer = await api.customer();
          api.gateway.data = [
            billingSubscription(customer, {
              livemode: boundary === "subscription" ? !live : live,
            }),
          ];
          const reads = api.gateway.subscriptions.mock.calls.length;
          expect(
            (await api.event(customer, boundary === "event" ? !live : live))
              .status,
          ).toBe(boundary === "event" ? 400 : 503);
          if (boundary === "event")
            expect(api.gateway.subscriptions).toHaveBeenCalledTimes(reads);
          expect(
            (await db.query("SELECT event_id FROM billing_events")).rows,
          ).toHaveLength(0);
        }
        expect((await api.quota.usage("alice")).plan).toBe("free");
      },
    );
    it.each(["test", "live"] as const)(
      "never accepts Connect events in %s mode",
      async (mode) => {
        const api = application(mode),
          customer = await api.customer(),
          reads = api.gateway.subscriptions.mock.calls.length;
        expect(
          (
            await api.event(customer, mode === "live", {
              account: "acct_connected_unapproved",
            })
          ).status,
        ).toBe(400);
        expect(api.gateway.subscriptions).toHaveBeenCalledTimes(reads);
      },
    );
    it.each(["test", "live"] as const)(
      "refuses switching a pinned %s database before provider IO or reuse of existing entitlement",
      async (first) => {
        const original = application(first),
          customer = await original.customer();
        original.gateway.data = [
          billingSubscription(customer, { livemode: first === "live" }),
        ];
        expect((await original.event(customer, first === "live")).status).toBe(
          200,
        );
        const other = application(first === "live" ? "test" : "live");
        expect((await other.status()).status).toBe(503);
        expect((await other.checkout()).status).toBe(503);
        expect(
          (await other.post("/api/billing/portal", { requestId: randomUUID() }))
            .status,
        ).toBe(503);
        expect((await other.event(customer, first !== "live")).status).toBe(
          503,
        );
        expect(other.gateway.price).not.toHaveBeenCalled();
        expect(other.gateway.createCustomer).not.toHaveBeenCalled();
        expect(other.gateway.subscriptions).not.toHaveBeenCalled();
        expect(other.gateway.createPortal).not.toHaveBeenCalled();
        expect(
          (await probeBillingSchema(db, first === "live" ? "test" : "live"))
            .ready,
        ).toBe(false);
        await expect(
          initializeBillingEnvironment(db, first === "live" ? "test" : "live"),
        ).rejects.toMatchObject({ code: "billing_environment_mismatch" });
        expect(
          (await db.query("SELECT mode FROM billing_environment")).rows[0].mode,
        ).toBe(first);
      },
    );
    it("recognizes unpinned WS-18 accounts as test and preserves unrelated operator Pro", async () => {
      await db.query(
        "INSERT INTO billing_accounts(user_id,customer_id,customer_key,created_at) VALUES('alice','cus_legacy_test',$1,$2)",
        [randomUUID(), new Date().toISOString()],
      );
      await db.query(
        "UPDATE users SET plan='pro',plan_expires_at=$2 WHERE id=$1",
        ["alice", new Date(Date.now() + 86400_000).toISOString()],
      );
      await db.query(
        "UPDATE users SET plan='pro',plan_expires_at=NULL WHERE id='bob'",
      );
      expect((await probeBillingSchema(db, "live")).ready).toBe(false);
      await expect(
        initializeBillingEnvironment(db, "live"),
      ).rejects.toMatchObject({ code: "billing_environment_mismatch" });
      await initializeBillingEnvironment(db, "test");
      expect(
        (await db.query("SELECT mode FROM billing_environment")).rows[0].mode,
      ).toBe("test");
      expect(await new PostgresQuotaStore(db).usage("bob")).toMatchObject({
        plan: "pro",
        limit: 200,
      });
    });
    it("fails schema readiness and operations closed when the environment migration is missing", async () => {
      await db.query("DROP TABLE billing_environment");
      expect((await probeBillingSchema(db, "live")).ready).toBe(false);
      const api = application("live");
      expect((await api.checkout()).status).toBe(503);
      expect(api.gateway.price).not.toHaveBeenCalled();
    });
    if (native)
      it("atomically pins only one environment during simultaneous test/live startup", async () => {
        const result = await Promise.allSettled([
          initializeBillingEnvironment(db, "test"),
          initializeBillingEnvironment(db, "live"),
        ]);
        expect(
          result.filter((value) => value.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          result.filter((value) => value.status === "rejected"),
        ).toHaveLength(1);
        expect(
          (await db.query("SELECT mode FROM billing_environment")).rows,
        ).toHaveLength(1);
      });
  });
}
