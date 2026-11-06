import type { DbLike } from "../db/pool";
import { BillingError } from "./types";
import type { BillingMode } from "./config";

/** One immutable provider environment per database. Switching requires a separate
 * database or a separately reviewed offline migration, never a runtime UPDATE. */
export async function initializeBillingEnvironment(
  db: DbLike,
  expected: BillingMode,
): Promise<void> {
  if (!db.transaction || !["test", "live"].includes(expected))
    throw new BillingError("billing_storage_unavailable");
  await db.transaction(async (tx) => {
    const initial = (
      await tx.query("SELECT mode FROM billing_environment WHERE id='stripe'")
    ).rows[0];
    if (!initial) {
      const legacy = await tx.query(
        "SELECT user_id FROM billing_accounts LIMIT 1",
      );
      // Before this migration every customer and finite Stripe grant was test-only.
      if (legacy.rows.length && expected !== "test")
        throw new BillingError("billing_environment_mismatch");
      await tx.query(
        "INSERT INTO billing_environment(id,mode) VALUES('stripe',$1) ON CONFLICT(id) DO NOTHING",
        [expected],
      );
    }
    const actual = (
      await tx.query("SELECT mode FROM billing_environment WHERE id='stripe'")
    ).rows[0]?.mode;
    if (actual !== expected)
      throw new BillingError("billing_environment_mismatch");
  });
}

export async function assertBillingEnvironment(
  db: DbLike,
  expected: BillingMode,
): Promise<void> {
  const actual = (
    await db.query("SELECT mode FROM billing_environment WHERE id='stripe'")
  ).rows[0]?.mode;
  if (actual !== expected)
    throw new BillingError("billing_environment_mismatch");
}
