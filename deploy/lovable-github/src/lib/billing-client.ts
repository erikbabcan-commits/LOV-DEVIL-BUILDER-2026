import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { honoFetch } from "./hono-client";

export const BillingIntervalSchema = z.enum(["month", "year"]);
export const BillingModeSchema = z.enum(["disabled", "sandbox", "live"]);
const PriceSchema = z
  .object({ amount: z.number().int().positive(), currency: z.literal("eur") })
  .strict();
export const BillingStatusSchema = z
  .object({
    userId: z.string().min(1).max(128),
    enabled: z.boolean(),
    mode: BillingModeSchema,
    plan: z.enum(["free", "pro"]),
    subscription: z
      .object({
        status: z.enum([
          "active",
          "trialing",
          "canceled",
          "past_due",
          "unpaid",
          "incomplete",
          "incomplete_expired",
          "paused",
        ]),
        interval: BillingIntervalSchema.nullable(),
        periodEnd: z.string().datetime().nullable(),
        cancelAtPeriodEnd: z.boolean(),
      })
      .strict()
      .nullable(),
    prices: z.object({ month: PriceSchema.nullable(), year: PriceSchema.nullable() }).strict(),
    trialDays: z.literal(14),
    checkoutAvailable: z.boolean(),
    portalAvailable: z.boolean(),
    pendingCheckout: z.boolean(),
  })
  .strict();
export type BillingStatus = z.infer<typeof BillingStatusSchema>;
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;
export interface BillingScope {
  cloudUserId: string;
  honoUserId: string;
  token: string;
}
export class BillingClientError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const safeCodes = new Set([
  "billing_disabled",
  "billing_pending",
  "billing_conflict",
  "billing_checkout_pending",
  "billing_checkout_expired",
  "billing_subscription_exists",
  "billing_provider_unavailable",
  "billing_reconciliation_required",
  "billing_configuration_changed",
  "billing_price_unavailable",
  "rate_limit",
  "unauthenticated",
  "unauthorized",
  "forbidden_origin",
  "auth_unavailable",
]);
async function assertSession(scope: BillingScope, signal: AbortSignal) {
  if (signal.aborted) throw new BillingClientError("stale");
  const { data } = await supabase.auth.getSession();
  if (
    signal.aborted ||
    data.session?.user.id !== scope.cloudUserId ||
    data.session.access_token !== scope.token
  )
    throw new BillingClientError("stale");
}
export function trustedStripeRedirect(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BillingClientError("protocol");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname)
  )
    throw new BillingClientError("protocol");
  return url.href;
}
async function request(scope: BillingScope, path: string, signal: AbortSignal, body?: unknown) {
  await assertSession(scope, signal);
  try {
    const response = await honoFetch("billing" + path, {
      expectedUserId: scope.cloudUserId,
      expectedAccessToken: scope.token,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
    });
    const value: unknown = await response.json().catch(() => null);
    await assertSession(scope, signal);
    if (!response.ok) {
      const code =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string" &&
        safeCodes.has(value.error)
          ? value.error
          : response.status === 401
            ? "unauthorized"
            : response.status === 429
              ? "rate_limit"
              : "unavailable";
      throw new BillingClientError(code);
    }
    return value;
  } catch (error) {
    await assertSession(scope, signal);
    if (error instanceof BillingClientError) throw error;
    throw new BillingClientError("network");
  }
}
export async function billingStatus(
  scope: BillingScope,
  signal: AbortSignal,
): Promise<BillingStatus> {
  const parsed = BillingStatusSchema.safeParse(await request(scope, "", signal));
  if (
    !parsed.success ||
    parsed.data.userId !== scope.honoUserId ||
    parsed.data.enabled !== (parsed.data.mode !== "disabled") ||
    (!parsed.data.enabled && (parsed.data.checkoutAvailable || parsed.data.portalAvailable))
  )
    throw new BillingClientError("protocol");
  return parsed.data;
}
export const CheckoutReceiptSchema = z
  .object({
    version: z.literal(1),
    interval: BillingIntervalSchema,
    requestId: z.string().uuid(),
  })
  .strict();
export type CheckoutReceipt = z.infer<typeof CheckoutReceiptSchema>;
const receiptKey = (scope: BillingScope, mode: BillingStatus["mode"]) =>
  "forge-billing-checkout:v1:" +
  encodeURIComponent(scope.cloudUserId) +
  ":" +
  encodeURIComponent(scope.honoUserId) +
  ":" +
  mode;
export function readCheckoutReceipt(
  scope: BillingScope,
  mode: BillingStatus["mode"],
): CheckoutReceipt | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(receiptKey(scope, mode));
  } catch {
    throw new BillingClientError("storage");
  }
  if (!raw) return null;
  try {
    const parsed = CheckoutReceiptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function checkoutReceipt(
  scope: BillingScope,
  mode: BillingStatus["mode"],
  interval: BillingInterval,
): CheckoutReceipt {
  if (mode === "disabled") throw new BillingClientError("billing_disabled");
  const previous = readCheckoutReceipt(scope, mode);
  if (previous) {
    if (previous.interval !== interval) throw new BillingClientError("billing_checkout_pending");
    return previous;
  }
  const receipt: CheckoutReceipt = { version: 1, interval, requestId: crypto.randomUUID() };
  try {
    const json = JSON.stringify(receipt);
    sessionStorage.setItem(receiptKey(scope, mode), json);
    if (sessionStorage.getItem(receiptKey(scope, mode)) !== json) throw new Error("storage");
  } catch {
    throw new BillingClientError("storage");
  }
  return receipt;
}
export function clearCheckoutReceipt(scope: BillingScope, mode: BillingStatus["mode"]) {
  try {
    sessionStorage.removeItem(receiptKey(scope, mode));
  } catch {
    throw new BillingClientError("storage");
  }
}
async function billingRedirect(
  scope: BillingScope,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  const parsed = z
    .object({ userId: z.string().min(1), url: z.string().url() })
    .strict()
    .safeParse(await request(scope, path, signal, body));
  if (!parsed.success || parsed.data.userId !== scope.honoUserId)
    throw new BillingClientError("protocol");
  const url = trustedStripeRedirect(parsed.data.url);
  await assertSession(scope, signal);
  return url;
}
export const billingCheckout = (
  scope: BillingScope,
  receipt: CheckoutReceipt,
  signal: AbortSignal,
) =>
  billingRedirect(
    scope,
    "/checkout",
    { interval: receipt.interval, requestId: receipt.requestId },
    signal,
  );
export const billingPortal = (scope: BillingScope, requestId: string, signal: AbortSignal) =>
  billingRedirect(scope, "/portal", { requestId }, signal);
