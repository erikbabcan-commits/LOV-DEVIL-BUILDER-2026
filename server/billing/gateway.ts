import Stripe from "stripe";
import { validateBillingConfig } from "./config";
import {
  BillingError,
  type BillingConfig,
  type BillingEvent,
  type BillingGateway,
  type BillingSession,
  type BillingSubscription,
} from "./types";

const identifier = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);

export function verifyBillingEvent(
  raw: Buffer,
  signature: string,
  webhookSecret: string,
): BillingEvent {
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(raw, signature, webhookSecret, 300);
  } catch {
    throw new BillingError("billing_webhook_signature", 400);
  }
  const object = event.data.object as unknown as {
    customer?: string | { id: string };
    id?: string;
  };
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    ...(event.account ? { account: event.account } : {}),
    customerId: identifier(object.customer),
    checkoutSessionId: event.type.startsWith("checkout.session.")
      ? (object.id ?? null)
      : null,
  };
}
function session(value: Stripe.Checkout.Session): BillingSession {
  const customerId = identifier(value.customer);
  const statuses: BillingSession["status"][] = ["open", "complete", "expired"];
  const status = statuses.find((candidate) => candidate === value.status);
  if (!customerId || !status)
    throw new BillingError("billing_provider_unavailable");
  return {
    id: value.id,
    customerId,
    url: value.url,
    expiresAt: value.expires_at,
    status,
    livemode: value.livemode,
  };
}
export function makeStripeBillingGateway(
  config: BillingConfig,
): BillingGateway {
  validateBillingConfig(config, process.env.NODE_ENV === "test");
  const stripe = new Stripe(config.secretKey, {
    timeout: 8000,
    maxNetworkRetries: 0,
  });
  return {
    verifyEvent: (raw, signature) =>
      verifyBillingEvent(raw, signature, config.webhookSecret),
    async price(id) {
      const value = await stripe.prices.retrieve(id);
      return {
        id: value.id,
        amount: value.unit_amount,
        currency: value.currency,
        interval: value.recurring?.interval ?? null,
        intervalCount: value.recurring?.interval_count ?? null,
        active: value.active,
        livemode: value.livemode,
      };
    },
    async createCustomer(userId, key) {
      const value = await stripe.customers.create(
        { metadata: { forge_user_id: userId } },
        { idempotencyKey: key },
      );
      return { id: value.id, livemode: value.livemode };
    },
    async subscriptions(customerId) {
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      });
      return {
        hasMore: list.has_more,
        data: list.data.map((value): BillingSubscription => {
          const statuses: BillingSubscription["status"][] = [
            "active",
            "trialing",
            "canceled",
            "past_due",
            "unpaid",
            "incomplete",
            "incomplete_expired",
            "paused",
          ];
          const status = statuses.find(
            (candidate) => candidate === value.status,
          );
          if (!status) throw new BillingError("billing_provider_unavailable");
          return {
            id: value.id,
            customerId: identifier(value.customer) ?? "",
            livemode: value.livemode,
            status,
            priceId: value.items.data[0]?.price.id ?? null,
            quantity: value.items.data[0]?.quantity ?? null,
            itemsCount: value.items.has_more ? -1 : value.items.data.length,
            periodEnd:
              value.cancel_at && value.items.data[0]?.current_period_end
                ? Math.min(
                    value.cancel_at,
                    value.items.data[0].current_period_end,
                  )
                : (value.items.data[0]?.current_period_end ?? null),
            trialEnd: value.trial_end,
            cancelAtPeriodEnd:
              value.cancel_at_period_end || value.cancel_at !== null,
            collectionPaused: value.pause_collection != null,
          };
        }),
      };
    },
    async createCheckout(input, key) {
      return session(
        await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: input.customerId,
            line_items: [{ price: input.priceId, quantity: 1 }],
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            expires_at: input.expiresAt,
            payment_method_collection: "always",
            ...(input.trialDays
              ? {
                  subscription_data: {
                    trial_period_days: input.trialDays,
                    trial_settings: {
                      end_behavior: { missing_payment_method: "cancel" },
                    },
                  },
                }
              : {}),
          },
          { idempotencyKey: key },
        ),
      );
    },
    async checkout(id) {
      return session(await stripe.checkout.sessions.retrieve(id));
    },
    async createPortal(input, key) {
      const value = await stripe.billingPortal.sessions.create(
        { customer: input.customerId, return_url: input.returnUrl },
        { idempotencyKey: key },
      );
      return { url: value.url };
    },
  };
}
