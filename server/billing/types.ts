import type { BillingInterval } from "../../shared/billing";

export interface BillingPrice {
  priceId: string;
  amount: number;
}
export interface BillingConfig {
  /** Missing mode preserves the original sandbox-only fixture/configuration contract. */
  mode?: "test" | "live";
  secretKey: string;
  webhookSecret: string;
  appUrl: string;
  prices: Record<BillingInterval, BillingPrice>;
}
export interface BillingEvent {
  id: string;
  type: string;
  livemode: boolean;
  account?: string;
  customerId: string | null;
  checkoutSessionId: string | null;
}
export interface BillingSubscription {
  id: string;
  customerId: string;
  livemode: boolean;
  status:
    | "active"
    | "trialing"
    | "canceled"
    | "past_due"
    | "unpaid"
    | "incomplete"
    | "incomplete_expired"
    | "paused";
  priceId: string | null;
  quantity: number | null;
  itemsCount: number;
  periodEnd: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  collectionPaused: boolean;
}
export interface BillingSession {
  id: string;
  customerId: string;
  url: string | null;
  expiresAt: number;
  status: "open" | "complete" | "expired";
  livemode: boolean;
}
export interface BillingGateway {
  verifyEvent(raw: Buffer, signature: string): BillingEvent;
  price(id: string): Promise<{
    id: string;
    amount: number | null;
    currency: string;
    interval: string | null;
    intervalCount: number | null;
    active: boolean;
    livemode: boolean;
  }>;
  createCustomer(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; livemode: boolean }>;
  subscriptions(
    customerId: string,
  ): Promise<{ data: BillingSubscription[]; hasMore: boolean }>;
  createCheckout(
    input: {
      customerId: string;
      priceId: string;
      trialDays: number | null;
      successUrl: string;
      cancelUrl: string;
      expiresAt: number;
    },
    idempotencyKey: string,
  ): Promise<BillingSession>;
  checkout(id: string): Promise<BillingSession>;
  createPortal(
    input: { customerId: string; returnUrl: string },
    idempotencyKey: string,
  ): Promise<{ url: string }>;
}
export class BillingError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503 = 503,
  ) {
    super(code);
  }
}
