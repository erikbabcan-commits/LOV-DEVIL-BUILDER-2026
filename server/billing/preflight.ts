import Stripe from "stripe";
import { billingLivemode, billingMode, validateBillingConfig } from "./config";
import { makeStripeBillingGateway } from "./gateway";
import { BillingError, type BillingConfig, type BillingGateway } from "./types";
import type { DbLike } from "../db/pool";
import type { BillingMode } from "./config";
import { probeBillingSchema } from "./service";

/** The caller supplies one already acquired connection, never pool.query. */
export async function inspectBillingDatabase(
  connection: Pick<DbLike, "query">,
  mode: BillingMode,
): Promise<{ ready: boolean; environmentPin: string }> {
  await connection.query("BEGIN READ ONLY");
  try {
    const query: DbLike["query"] = (sql, params) => connection.query(sql, params);
    // Probe callbacks share this real, pinned, read-only transaction.
    const db: DbLike = { query, transaction: async work => work({ query }) };
    const schema = await probeBillingSchema(db, mode);
    const pin = schema.ready
      ? (await query("SELECT mode FROM billing_environment WHERE id='stripe'")).rows[0]?.mode
      : undefined;
    return {
      ready: schema.ready,
      environmentPin: schema.ready ? (pin ?? "not_initialized") : "not_ready",
    };
  } finally {
    await connection.query("ROLLBACK");
  }
}

/** The preflight has no provider mutation capability. */
export interface BillingReadOnlyProvider {
  account(): Promise<{
    id: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }>;
  price: BillingGateway["price"];
}

export function makeStripeBillingReadOnlyProvider(
  config: BillingConfig,
): BillingReadOnlyProvider {
  validateBillingConfig(config, process.env.NODE_ENV === "test");
  const stripe = new Stripe(config.secretKey, {
    timeout: 8000,
    maxNetworkRetries: 0,
  });
  const gateway = makeStripeBillingGateway(config);
  return {
    async account() {
      const account = await stripe.accounts.retrieve(null);
      return {
        id: account.id,
        chargesEnabled: account.charges_enabled === true,
        payoutsEnabled: account.payouts_enabled === true,
        detailsSubmitted: account.details_submitted === true,
      };
    },
    price: (id) => gateway.price(id),
  };
}

/** Read-only remote checks do not establish webhook delivery, Portal setup,
 * successful payments, or the database's runtime environment pin. */
export async function inspectBillingProvider(
  config: BillingConfig,
  provider: BillingReadOnlyProvider,
  expectedAccountId?: string,
) {
  validateBillingConfig(config, process.env.NODE_ENV === "test");
  if (
    expectedAccountId !== undefined &&
    !/^acct_[A-Za-z0-9]{1,128}$/.test(expectedAccountId)
  )
    throw new BillingError("billing_expected_account_invalid");
  const account = await provider.account();
  if (!/^acct_[A-Za-z0-9]{1,128}$/.test(account.id))
    throw new BillingError("billing_provider_unavailable");
  if (expectedAccountId && account.id !== expectedAccountId)
    throw new BillingError("billing_account_mismatch");
  for (const interval of ["month", "year"] as const) {
    const expected = config.prices[interval];
    const price = await provider.price(expected.priceId);
    if (
      price.id !== expected.priceId ||
      price.active !== true ||
      price.livemode !== billingLivemode(config) ||
      price.currency !== "eur" ||
      price.amount !== expected.amount ||
      price.interval !== interval ||
      price.intervalCount !== 1
    )
      throw new BillingError("billing_price_unavailable");
  }
  const ready = billingMode(config) !== "live" || account.chargesEnabled;
  return {
    ready,
    accountId: account.id,
    expectedAccount: expectedAccountId ? "matched" : "not_specified",
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    detailsSubmitted: account.detailsSubmitted,
    prices: { month: "verified", year: "verified" },
    ...(!ready ? { issues: ["billing_live_charges_unavailable"] } : {}),
    webhook: "not_checked",
    portal: "not_checked",
    payment: "not_attempted",
  };
}
