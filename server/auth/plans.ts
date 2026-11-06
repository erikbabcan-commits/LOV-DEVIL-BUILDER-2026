import type { Plan } from "../security/quotaStore";

/** Null expiry preserves operator-provisioned plans; Stripe plans always have a finite entitlement. */
export function effectivePlan(
  row: { plan?: unknown; plan_expires_at?: unknown },
  now = new Date(),
): Plan {
  if (row.plan !== "pro") return "free";
  if (row.plan_expires_at == null) return "pro";
  const until =
    row.plan_expires_at instanceof Date
      ? row.plan_expires_at.getTime()
      : Date.parse(String(row.plan_expires_at));
  return Number.isFinite(until) && until > now.getTime() ? "pro" : "free";
}
