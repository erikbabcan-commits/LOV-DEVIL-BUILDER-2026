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

type PortalConfiguration = {
  active: boolean;
  is_default: boolean;
  livemode: boolean;
  features: {
    invoice_history?: { enabled: boolean };
    payment_method_update?: { enabled: boolean };
    subscription_cancel?: { enabled: boolean };
    customer_update?: { enabled: boolean; allowed_updates: readonly string[] };
  };
};

/** The preflight has no provider mutation capability. */
export interface BillingReadOnlyProvider {
  account(): Promise<{
    id: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }>;
  price: BillingGateway["price"];
  portalConfigurations(): Promise<{
    data: PortalConfiguration[];
    has_more: boolean;
  }>;
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
    portalConfigurations: () => stripe.billingPortal.configurations.list({ active: true, is_default: true, limit: 2 }),
  };
}

/** Check the default configuration used by runtime Portal sessions, without creating one. */
async function inspectDefaultPortal(config: BillingConfig, provider: BillingReadOnlyProvider) {
  const result = await provider.portalConfigurations();
  if (result.data.length === 0 && result.has_more === false)
    return { ready: false, state: "missing", issues: ["billing_portal_default_missing"] } as const;
  const [portal] = result.data;
  if (
    result.data.length !== 1 || result.has_more !== false || !portal ||
    portal.active !== true || portal.is_default !== true || portal.livemode !== billingLivemode(config) ||
    !portal.features
  )
    return { ready: false, state: "invalid", issues: ["billing_portal_default_invalid"] } as const;
  const invoiceHistory = portal.features.invoice_history?.enabled === true;
  const paymentMethodUpdate = portal.features.payment_method_update?.enabled === true;
  const subscriptionCancellation = portal.features.subscription_cancel?.enabled === true;
  const customer = portal.features.customer_update;
  const allowedUpdates = customer?.enabled === true && Array.isArray(customer.allowed_updates)
    ? customer.allowed_updates : [];
  const issues = [
    ...(!invoiceHistory ? ["billing_portal_invoices_disabled"] : []),
    ...(!paymentMethodUpdate ? ["billing_portal_payment_update_disabled"] : []),
    ...(!subscriptionCancellation ? ["billing_portal_cancellation_disabled"] : []),
  ];
  return {
    ready: issues.length === 0,
    state: "checked",
    invoiceHistory,
    paymentMethodUpdate,
    subscriptionCancellation,
    billingAddress: allowedUpdates.includes("address"),
    taxId: allowedUpdates.includes("tax_id"),
    issues,
  } as const;
}

/** Inspect the configured Stripe account, prices and optionally its default Portal features. */
export async function inspectBillingProvider(
  config: BillingConfig,
  provider: BillingReadOnlyProvider,
  expectedAccountId?: string,
  checkPortal = false,
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
  const chargesReady = billingMode(config) !== "live" || account.chargesEnabled;
  const portal = checkPortal ? await inspectDefaultPortal(config, provider) : "not_checked";
  return {
    ready: chargesReady && (portal === "not_checked" || portal.ready),
    accountId: account.id,
    expectedAccount: expectedAccountId ? "matched" : "not_specified",
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    detailsSubmitted: account.detailsSubmitted,
    prices: { month: "verified", year: "verified" },
    ...(!chargesReady ? { issues: ["billing_live_charges_unavailable"] } : {}),
    webhook: "not_checked",
    portal,
    payment: "not_attempted",
  };
}
