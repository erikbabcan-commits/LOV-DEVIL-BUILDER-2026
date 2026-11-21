import type { DbLike } from "../db/pool";
import {
  BillingError,
  type BillingEvent,
  type BillingEventProcessor,
  type BillingQueueState,
  type BillingWebhookOutcome,
} from "./types";

/** Attempts before a row becomes `dead` and waits for reconciliation or an operator. */
export const BILLING_QUEUE_MAX_ATTEMPTS = 8;
/** First retry delay; doubles per failed attempt (30 s, 1 min, 2 min, … capped). */
export const BILLING_QUEUE_BASE_DELAY_MS = 30_000;
/** Upper bound for a single retry delay. */
export const BILLING_QUEUE_MAX_DELAY_MS = 6 * 3600_000;

export interface BillingQueueRow {
  event_id: string;
  user_id: string;
  event_type: string;
  event_created: number | string | null;
  customer_id: string;
  checkout_session_id: string | null;
  positive_invoice_subscription_id: string | null;
  positive_invoice_paid_at: number | string | null;
  livemode: boolean;
  state: BillingQueueState;
  outcome: BillingWebhookOutcome | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | string;
  last_error: string | null;
  received_at: Date | string;
  updated_at: Date | string;
  processed_at: Date | string | null;
}

/** Exponential backoff for the n-th failed attempt (n >= 1). */
export function billingQueueBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(
    BILLING_QUEUE_BASE_DELAY_MS * 2 ** exponent,
    BILLING_QUEUE_MAX_DELAY_MS,
  );
}

const numberOrUndefined = (value: number | string | null) =>
  value === null ? undefined : Number(value);

/** Rebuilds the verified, normalized event from its queue row (no raw payload is stored). */
export function queuedBillingEvent(row: BillingQueueRow): BillingEvent {
  const created = numberOrUndefined(row.event_created);
  const paidAt = numberOrUndefined(row.positive_invoice_paid_at);
  return {
    id: row.event_id,
    type: row.event_type,
    livemode: row.livemode,
    customerId: row.customer_id,
    checkoutSessionId: row.checkout_session_id,
    ...(row.positive_invoice_subscription_id && paidAt !== undefined
      ? {
          positiveInvoice: {
            subscriptionId: row.positive_invoice_subscription_id,
            paidAt,
          },
        }
      : {}),
    ...(created !== undefined ? { created } : {}),
  };
}

export async function readQueuedBillingEvent(
  db: DbLike,
  eventId: string,
): Promise<BillingQueueRow | null> {
  return (
    ((
      await db.query("SELECT * FROM billing_webhook_queue WHERE event_id=$1", [
        eventId,
      ])
    ).rows[0] as BillingQueueRow | undefined) ?? null
  );
}

/**
 * Durably records a verified event for its bound owner. A redelivery with the
 * same Stripe event id keeps the first row, so it is processed at most once.
 */
export async function enqueueBillingEvent(
  db: DbLike,
  event: BillingEvent,
  userId: string,
  now: Date,
  maxAttempts = BILLING_QUEUE_MAX_ATTEMPTS,
): Promise<BillingQueueRow> {
  if (!event.customerId) throw new BillingError("billing_webhook_environment", 400);
  const at = now.toISOString();
  await db.query(
    "INSERT INTO billing_webhook_queue(event_id,user_id,event_type,event_created,customer_id,checkout_session_id,positive_invoice_subscription_id,positive_invoice_paid_at,livemode,state,attempts,max_attempts,next_attempt_at,received_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',0,$10,$11,$11,$11) ON CONFLICT (event_id) DO NOTHING",
    [
      event.id,
      userId,
      event.type,
      event.created ?? null,
      event.customerId,
      event.checkoutSessionId,
      event.positiveInvoice?.subscriptionId ?? null,
      event.positiveInvoice?.paidAt ?? null,
      event.livemode,
      maxAttempts,
      at,
    ],
  );
  const row = await readQueuedBillingEvent(db, event.id);
  if (!row) throw new BillingError("billing_storage_unavailable");
  return row;
}

export async function markBillingEventProcessed(
  db: DbLike,
  eventId: string,
  outcome: BillingWebhookOutcome,
  now: Date,
): Promise<void> {
  const at = now.toISOString();
  await db.query(
    "UPDATE billing_webhook_queue SET state='processed',outcome=$2,attempts=attempts+1,last_error=NULL,processed_at=$3,updated_at=$3 WHERE event_id=$1 AND state<>'processed'",
    [eventId, outcome, at],
  );
}

/**
 * Bora P2-4: a Stripe redelivery of an event that is already `dead` must not be
 * acknowledged unprocessed. Revive it (attempts reset, due now) so the caller
 * processes it synchronously; a failure is recorded and surfaces as 5xx again.
 */
export async function reviveDeadBillingEvent(
  db: DbLike,
  eventId: string,
  now: Date,
): Promise<BillingQueueRow | null> {
  const at = now.toISOString();
  await db.query(
    "UPDATE billing_webhook_queue SET state='pending',attempts=0,last_error=NULL,next_attempt_at=$2,updated_at=$2 WHERE event_id=$1 AND state='dead'",
    [eventId, at],
  );
  return readQueuedBillingEvent(db, eventId);
}

/** Records a failed attempt with backoff, or `dead` once max attempts are used. Stores only an error code. */
export async function markBillingEventFailed(
  db: DbLike,
  eventId: string,
  error: unknown,
  now: Date,
): Promise<BillingQueueState | null> {
  const row = await readQueuedBillingEvent(db, eventId);
  if (!row || row.state === "processed") return row?.state ?? null;
  const attempts = Number(row.attempts) + 1;
  const state: BillingQueueState =
    attempts >= Number(row.max_attempts) ? "dead" : "failed";
  const code =
    error instanceof BillingError ? error.code : "billing_processing_failed";
  await db.query(
    "UPDATE billing_webhook_queue SET state=$2,attempts=$3,last_error=$4,next_attempt_at=$5,updated_at=$6 WHERE event_id=$1 AND state<>'processed'",
    [
      eventId,
      state,
      attempts,
      code,
      new Date(now.getTime() + billingQueueBackoffMs(attempts)).toISOString(),
      now.toISOString(),
    ],
  );
  return state;
}

/** Processes one queue row and records the result. Rethrows the processing error after recording it. */
export async function runQueuedBillingEvent(
  processor: BillingEventProcessor,
  db: DbLike,
  row: BillingQueueRow,
  now: () => Date,
): Promise<BillingWebhookOutcome> {
  let outcome: BillingWebhookOutcome;
  try {
    outcome = await processor.processQueuedEvent(
      queuedBillingEvent(row),
      row.user_id,
    );
  } catch (error) {
    try {
      await markBillingEventFailed(db, row.event_id, error, now());
    } catch {
      // Keep the processing error; the row stays due and is retried later.
    }
    throw error;
  }
  await markBillingEventProcessed(db, row.event_id, outcome, now());
  return outcome;
}

export interface BillingQueueDrainResult {
  processed: number;
  failed: number;
  dead: number;
}

/** Retries due `pending`/`failed` rows in arrival order. Never deletes rows. */
export async function drainBillingWebhookQueue(
  processor: BillingEventProcessor,
  db: DbLike,
  options: { now?: () => Date; limit?: number } = {},
): Promise<BillingQueueDrainResult> {
  const now = options.now ?? (() => new Date());
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const due = (
    await db.query(
      "SELECT * FROM billing_webhook_queue WHERE state IN ('pending','failed') AND next_attempt_at <= $1 ORDER BY next_attempt_at, received_at, event_id LIMIT $2",
      [now().toISOString(), limit],
    )
  ).rows as BillingQueueRow[];
  const result: BillingQueueDrainResult = { processed: 0, failed: 0, dead: 0 };
  for (const row of due) {
    try {
      await runQueuedBillingEvent(processor, db, row, now);
      result.processed++;
    } catch {
      const state = (await readQueuedBillingEvent(db, row.event_id))?.state;
      if (state === "dead") result.dead++;
      else result.failed++;
    }
  }
  return result;
}
