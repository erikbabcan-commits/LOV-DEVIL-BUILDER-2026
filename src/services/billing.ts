import { z } from "zod";
import {
  BillingCheckoutSchema,
  BillingRedirectSchema,
  BillingStatusSchema,
  type BillingInterval,
  type BillingStatus,
} from "../../shared/billing";
import { apiHeaders, getCsrfToken } from "../lib/csrf";
import { DB_NAME, persistenceScope } from "./persistence/db";

export interface BillingIdentity {
  userId: string;
  databaseName: string;
  epoch: number;
}
export class BillingApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function captureBillingIdentity(userId: string): BillingIdentity | null {
  const scope = persistenceScope();
  return scope.databaseName ===
    DB_NAME + ":account:" + encodeURIComponent(userId)
    ? { userId, databaseName: scope.databaseName, epoch: scope.epoch }
    : null;
}
export function matchesBillingIdentity(identity: BillingIdentity): boolean {
  const scope = persistenceScope();
  return (
    scope.databaseName === identity.databaseName &&
    scope.epoch === identity.epoch
  );
}
function assertIdentity(identity: BillingIdentity, signal?: AbortSignal) {
  if (signal?.aborted || !matchesBillingIdentity(identity))
    throw new BillingApiError("stale");
}
const safeCodes = new Set([
  "billing_disabled",
  "billing_unavailable",
  "billing_pending",
  "billing_conflict",
  "billing_checkout_expired",
  "billing_checkout_pending",
  "billing_provider_unavailable",
  "billing_subscription_exists",
  "billing_reconciliation_required",
  "billing_configuration_changed",
  "billing_price_unavailable",
  "invalid_request",
  "login_required",
  "rate_limit",
]);
async function request(
  identity: BillingIdentity,
  path: string,
  signal: AbortSignal,
  body?: unknown,
) {
  assertIdentity(identity, signal);
  try {
    if (body !== undefined && !getCsrfToken())
      throw new BillingApiError("csrf_required");
    const response = await fetch("/api/billing" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      ...(body === undefined
        ? {}
        : { headers: apiHeaders(), body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json().catch(() => null);
    assertIdentity(identity, signal);
    if (!response.ok) {
      const code =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string" &&
        safeCodes.has(value.error)
          ? value.error
          : response.status === 401
            ? "login_required"
            : response.status === 429
              ? "rate_limit"
              : "billing_unavailable";
      throw new BillingApiError(code);
    }
    return value;
  } catch (error) {
    assertIdentity(identity, signal);
    if (error instanceof BillingApiError) throw error;
    throw new BillingApiError("network");
  }
}
export function trustedBillingUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BillingApiError("protocol");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname)
  )
    throw new BillingApiError("protocol");
  return url.href;
}
export async function loadBillingStatus(
  identity: BillingIdentity,
  signal: AbortSignal,
): Promise<BillingStatus> {
  const parsed = BillingStatusSchema.safeParse(
    await request(identity, "", signal),
  );
  if (
    !parsed.success ||
    parsed.data.userId !== identity.userId ||
    parsed.data.enabled !== (parsed.data.mode === "sandbox") ||
    (!parsed.data.enabled &&
      (parsed.data.checkoutAvailable || parsed.data.portalAvailable))
  )
    throw new BillingApiError("protocol");
  return parsed.data;
}
const AttemptSchema = BillingCheckoutSchema.extend({
  version: z.literal(1),
}).strict();
export type CheckoutAttempt = z.infer<typeof AttemptSchema>;
const attemptKey = (identity: BillingIdentity) =>
  "billing-checkout:v1:" + encodeURIComponent(identity.userId);
export function readCheckoutAttempt(
  identity: BillingIdentity,
): CheckoutAttempt | null {
  assertIdentity(identity);
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(attemptKey(identity));
  } catch {
    throw new BillingApiError("storage");
  }
  if (!raw) return null;
  try {
    const parsed = AttemptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function prepareCheckoutAttempt(
  identity: BillingIdentity,
  interval: BillingInterval,
): CheckoutAttempt {
  assertIdentity(identity);
  const previous = readCheckoutAttempt(identity);
  if (previous) {
    if (previous.interval !== interval)
      throw new BillingApiError("interval_locked");
    return previous;
  }
  const record: CheckoutAttempt = {
    version: 1,
    requestId: crypto.randomUUID(),
    interval,
  };
  try {
    sessionStorage.setItem(attemptKey(identity), JSON.stringify(record));
    if (sessionStorage.getItem(attemptKey(identity)) !== JSON.stringify(record))
      throw new Error("storage");
  } catch {
    throw new BillingApiError("storage");
  }
  return record;
}
export function clearCheckoutAttempt(identity: BillingIdentity) {
  assertIdentity(identity);
  try {
    sessionStorage.removeItem(attemptKey(identity));
  } catch {
    throw new BillingApiError("storage");
  }
}
async function redirect(
  identity: BillingIdentity,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  const parsed = BillingRedirectSchema.safeParse(
    await request(identity, path, signal, body),
  );
  if (!parsed.success || parsed.data.userId !== identity.userId)
    throw new BillingApiError("protocol");
  const url = trustedBillingUrl(parsed.data.url);
  assertIdentity(identity, signal);
  return url;
}
export const billingApi = {
  status: loadBillingStatus,
  checkout: (
    identity: BillingIdentity,
    attempt: CheckoutAttempt,
    signal: AbortSignal,
  ) =>
    redirect(
      identity,
      "/checkout",
      { interval: attempt.interval, requestId: attempt.requestId },
      signal,
    ),
  portal: (identity: BillingIdentity, requestId: string, signal: AbortSignal) =>
    redirect(identity, "/portal", { requestId }, signal),
};
