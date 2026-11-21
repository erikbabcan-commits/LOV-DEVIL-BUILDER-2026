import type { DbLike } from "../db/pool";
import type { BillingEventProcessor, BillingSubscription } from "./types";
import { drainBillingWebhookQueue } from "./webhookQueue";

/**
 * Default grace period after `invoice.payment_failed`: 7 days.
 *
 * Why 7 days: it covers a weekend plus the first Stripe Smart Retries attempts
 * and gives the owner time to update the card in the Customer Portal, while it
 * keeps unpaid AI usage (real provider cost) bounded to about a quarter of a
 * monthly period. It is a constant on purpose; tests and operators can pass a
 * different value through BillingService options.
 */
export const BILLING_GRACE_PERIOD_MS = 7 * 24 * 3600_000;

/** Subscription states that may still recover by payment, so Pro is kept during grace. */
const RECOVERABLE: ReadonlyArray<BillingSubscription["status"]> = [
  "past_due",
  "unpaid",
];

export interface BillingAccountState {
  user_id: string;
  last_subscription_event_created: number | string | null;
  last_subscription_event_id: string | null;
  payment_failed_at: Date | string | null;
  grace_period_ends_at: Date | string | null;
  grace_resolved_at: Date | string | null;
  downgraded_to_free_at: Date | string | null;
  downgrade_reason: "grace_period_expired" | "subscription_ended" | null;
  updated_at: Date | string;
}

export async function readBillingAccountState(
  db: DbLike,
  userId: string,
): Promise<BillingAccountState | null> {
  return (
    ((
      await db.query("SELECT * FROM billing_account_state WHERE user_id=$1", [
        userId,
      ])
    ).rows[0] as BillingAccountState | undefined) ?? null
  );
}

async function ensureState(db: DbLike, userId: string, now: Date) {
  await db.query(
    "INSERT INTO billing_account_state(user_id,updated_at) VALUES($1,$2) ON CONFLICT (user_id) DO NOTHING",
    [userId, now.toISOString()],
  );
}

const graceOpen = (state: BillingAccountState | null) =>
  !!state?.grace_period_ends_at &&
  !state.grace_resolved_at &&
  !state.downgraded_to_free_at;

/** True when a subscription event is strictly older than the newest one already applied. */
export async function isStaleSubscriptionEvent(
  db: DbLike,
  userId: string,
  created: number | undefined,
): Promise<boolean> {
  if (created === undefined) return false;
  const last = (await readBillingAccountState(db, userId))
    ?.last_subscription_event_created;
  return last !== null && last !== undefined && created < Number(last);
}

export async function recordSubscriptionEvent(
  db: DbLike,
  userId: string,
  eventId: string,
  created: number | undefined,
  now: Date,
): Promise<void> {
  if (created === undefined) return;
  await ensureState(db, userId, now);
  await db.query(
    "UPDATE billing_account_state SET last_subscription_event_created=$2,last_subscription_event_id=$3,updated_at=$4 WHERE user_id=$1 AND (last_subscription_event_created IS NULL OR last_subscription_event_created <= $2)",
    [userId, created, eventId, now.toISOString()],
  );
}

/** Opens a grace period for a currently-Pro owner unless one is already open. */
export async function openGracePeriod(
  db: DbLike,
  userId: string,
  now: Date,
  graceMs: number = BILLING_GRACE_PERIOD_MS,
): Promise<void> {
  await ensureState(db, userId, now);
  if (graceOpen(await readBillingAccountState(db, userId))) return;
  await db.query(
    "UPDATE billing_account_state SET payment_failed_at=$2,grace_period_ends_at=$3,grace_resolved_at=NULL,downgraded_to_free_at=NULL,downgrade_reason=NULL,updated_at=$2 WHERE user_id=$1",
    [userId, now.toISOString(), new Date(now.getTime() + graceMs).toISOString()],
  );
}

/**
 * Downgrade is a state change only: users.plan='free' plus a flag on
 * billing_account_state. Projects, blueprints and all user data stay intact.
 */
async function markDowngraded(
  db: DbLike,
  userId: string,
  now: Date,
  reason: "grace_period_expired" | "subscription_ended",
): Promise<void> {
  await db.query("UPDATE users SET plan='free',plan_expires_at=NULL WHERE id=$1", [
    userId,
  ]);
  await db.query(
    "UPDATE billing_account_state SET downgraded_to_free_at=$2,downgrade_reason=$3,updated_at=$2 WHERE user_id=$1",
    [userId, now.toISOString(), reason],
  );
}

/**
 * Runs after canonical reconciliation (inside the owner lock). While a grace
 * period is open and the subscription can still recover, keeps Pro until the
 * grace end; a paid subscription resolves the grace period; an ended
 * subscription or an elapsed grace period sets the downgrade flag.
 */
export async function applyGraceOverlay(
  tx: DbLike,
  userId: string,
  input: {
    paid: boolean;
    status: BillingSubscription["status"] | null;
    allowResolve: boolean;
  },
  now: Date,
): Promise<void> {
  const state = await readBillingAccountState(tx, userId);
  if (!graceOpen(state)) return;
  if (input.paid) {
    if (input.allowResolve)
      await tx.query(
        "UPDATE billing_account_state SET grace_resolved_at=$2,updated_at=$2 WHERE user_id=$1",
        [userId, now.toISOString()],
      );
    return;
  }
  const ends = new Date(state!.grace_period_ends_at!);
  const recoverable = input.status !== null && RECOVERABLE.includes(input.status);
  if (recoverable && now.getTime() < ends.getTime()) {
    await tx.query("UPDATE users SET plan='pro',plan_expires_at=$2 WHERE id=$1", [
      userId,
      ends.toISOString(),
    ]);
    return;
  }
  await markDowngraded(
    tx,
    userId,
    now,
    now.getTime() >= ends.getTime() ? "grace_period_expired" : "subscription_ended",
  );
}

/**
 * Sets the downgrade flag for every elapsed, unresolved grace period. An owner
 * whose entitlement now ends after the grace end (renewed elsewhere) or is
 * operator-provisioned (no expiry) is resolved instead of downgraded.
 */
export async function expireGracePeriods(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ downgraded: string[]; resolved: string[] }> {
  const due = (
    await db.query(
      "SELECT user_id FROM billing_account_state WHERE grace_period_ends_at <= $1 AND grace_resolved_at IS NULL AND downgraded_to_free_at IS NULL ORDER BY user_id",
      [now.toISOString()],
    )
  ).rows as Array<{ user_id: string }>;
  const result = { downgraded: [] as string[], resolved: [] as string[] };
  for (const { user_id } of due) {
    const work = async (tx: DbLike) => {
      const user = (
        await tx.query(
          "SELECT plan,plan_expires_at FROM users WHERE id=$1 FOR UPDATE",
          [user_id],
        )
      ).rows[0] as
        | { plan: string; plan_expires_at: Date | string | null }
        | undefined;
      const state = await readBillingAccountState(tx, user_id);
      if (!user || !graceOpen(state)) return;
      const ends = new Date(state!.grace_period_ends_at!).getTime();
      if (ends > now.getTime()) return;
      const renewed =
        user.plan === "pro" &&
        (user.plan_expires_at === null ||
          new Date(user.plan_expires_at).getTime() > ends);
      if (renewed) {
        await tx.query(
          "UPDATE billing_account_state SET grace_resolved_at=$2,updated_at=$2 WHERE user_id=$1",
          [user_id, now.toISOString()],
        );
        result.resolved.push(user_id);
        return;
      }
      await markDowngraded(tx, user_id, now, "grace_period_expired");
      result.downgraded.push(user_id);
    };
    if (db.transaction) await db.transaction(work);
    else await work(db);
  }
  return result;
}

/** Refreshes one owner from canonical Stripe state; implemented by BillingService. */
export interface BillingAccountReconciler {
  reconcileAccount(userId: string): Promise<boolean>;
}

/**
 * Repairs missed webhooks: re-reads canonical subscription state for bound
 * accounts (keyset batches by user id) and records per-account failures
 * without stopping the sweep.
 */
export async function reconcileBillingAccounts(
  reconciler: BillingAccountReconciler,
  db: DbLike,
  options: { after?: string; limit?: number } = {},
): Promise<{ reconciled: string[]; failed: string[]; cursor: string | null }> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 500));
  // Unbound accounts are skipped by reconcileAccount (returns false).
  const rows = (
    await db.query(
      "SELECT user_id FROM billing_accounts WHERE user_id > $1 ORDER BY user_id LIMIT $2",
      [options.after ?? "", limit],
    )
  ).rows as Array<{ user_id: string }>;
  const result = {
    reconciled: [] as string[],
    failed: [] as string[],
    cursor: rows.length === limit ? rows[rows.length - 1].user_id : null,
  };
  for (const { user_id } of rows) {
    try {
      if (await reconciler.reconcileAccount(user_id))
        result.reconciled.push(user_id);
    } catch {
      result.failed.push(user_id);
    }
  }
  return result;
}

/** One maintenance pass: retry due queue rows, reconcile a batch, expire grace periods. */
export async function runBillingMaintenance(
  service: BillingEventProcessor & BillingAccountReconciler,
  db: DbLike,
  options: { now?: () => Date; after?: string; limit?: number } = {},
) {
  const now = options.now ?? (() => new Date());
  const queue = await drainBillingWebhookQueue(service, db, { now });
  const accounts = await reconcileBillingAccounts(service, db, options);
  const grace = await expireGracePeriods(db, now());
  return { queue, accounts, grace };
}

/** Parses the opt-in BILLING_MAINTENANCE_INTERVAL_MS (60 s – 24 h). Unset means off. */
export function readBillingMaintenanceInterval(
  env: Record<string, string | undefined>,
): number | null {
  const raw = env.BILLING_MAINTENANCE_INTERVAL_MS;
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 86_400_000)
    throw new Error("BILLING_MAINTENANCE_INTERVAL_MS must be 60000–86400000.");
  return value;
}

/** Starts a non-blocking maintenance timer; returns a stop function. Errors never escape the timer. */
export function startBillingMaintenance(
  service: BillingEventProcessor & BillingAccountReconciler,
  db: DbLike,
  intervalMs: number,
): () => void {
  let cursor: string | undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runBillingMaintenance(service, db, { after: cursor })
      .then((result) => {
        cursor = result.accounts.cursor ?? undefined;
      })
      .catch(() => {
        // Next tick retries; queue rows keep their own attempt state.
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
