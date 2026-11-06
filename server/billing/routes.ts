import { Hono, type Context } from "hono";
import {
  BillingCheckoutSchema,
  BillingPortalSchema,
  BillingStatusSchema,
} from "../../shared/billing";
import { getUserFromContext } from "../auth/middleware";
import type { BillingService } from "./service";
import { BillingError } from "./types";

function failure(c: Context, error: unknown) {
  return error instanceof BillingError
    ? c.json({ error: error.code }, error.status)
    : c.json({ error: "billing_unavailable" }, 503);
}

/** Mounted before cookie authentication, on this exact signed POST only. */
export function billingWebhook(service: BillingService | null) {
  return async (c: Context) => {
    c.header("Cache-Control", "no-store");
    if (!service) return c.json({ error: "billing_disabled" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    const signature = c.req.header("Stripe-Signature");
    if (!signature || signature.length > 4096)
      return c.json({ error: "billing_signature" }, 400);
    try {
      await service.webhook(Buffer.from(await c.req.arrayBuffer()), signature);
      return c.json({ received: true });
    } catch (error) {
      return failure(c, error);
    }
  };
}

/** Identity and CSRF are resolved by the existing middleware. No customer ID comes from the client. */
export function billingRouter(
  service: BillingService | null,
  rateLimit: (key: string) => boolean,
) {
  const router = new Hono();
  router.use("/api/billing", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  router.use("/api/billing/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  router.get("/api/billing", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "billing_unavailable" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    if (!rateLimit("billing-status:" + user.id))
      return c.json({ error: "rate_limit" }, 429);
    try {
      const status = service
        ? await service.status(user.id)
        : {
            userId: user.id,
            enabled: false,
            mode: "disabled",
            plan: user.plan,
            subscription: null,
            prices: { month: null, year: null },
            trialDays: 14,
            checkoutAvailable: false,
            portalAvailable: false,
            pendingCheckout: false,
          };
      return c.json(BillingStatusSchema.parse(status));
    } catch (error) {
      return failure(c, error);
    }
  });
  router.post("/api/billing/checkout", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "billing_unavailable" }, 503);
    if (!service) return c.json({ error: "billing_disabled" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    if (!rateLimit("billing-checkout:" + user.id))
      return c.json({ error: "rate_limit" }, 429);
    const parsed = BillingCheckoutSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({
        userId: user.id,
        ...(await service.checkout(
          user.id,
          parsed.data.interval,
          parsed.data.requestId,
        )),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  router.post("/api/billing/portal", async (c) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: "billing_unavailable" }, 503);
    if (!service) return c.json({ error: "billing_disabled" }, 503);
    if (new URL(c.req.url).search)
      return c.json({ error: "invalid_query" }, 400);
    if (!rateLimit("billing-portal:" + user.id))
      return c.json({ error: "rate_limit" }, 429);
    const parsed = BillingPortalSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({
        userId: user.id,
        ...(await service.portal(user.id, parsed.data.requestId)),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  return router;
}
