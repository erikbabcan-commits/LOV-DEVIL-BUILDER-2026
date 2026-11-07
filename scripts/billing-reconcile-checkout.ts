import { parseArgs } from "node:util";
import { Pool } from "pg";
import { billingMode, readBillingConfig } from "../server/billing/config";
import { makeStripeBillingGateway } from "../server/billing/gateway";
import { BillingService } from "../server/billing/service";
import { BillingError } from "../server/billing/types";
import { dbFromPool } from "../server/db/pool";

let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean" },
      "user-id": { type: "string" },
      "request-id": { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: billing:reconcile-checkout --apply --user-id <owner> --request-id <uuid>\n" +
        "Requires explicit BILLING_MODE=test and a database already pinned to Stripe test mode.\n" +
        "Uses the existing Checkout session recorded for the owner. Reads Stripe and updates only the local ledger and entitlement.\n" +
        "Does not create, expire or change Stripe objects. Provide configuration via the environment.",
    );
  } else {
    if (!values.apply || !values["user-id"] || !values["request-id"])
      throw new BillingError("billing_invalid_request", 400);
    if (process.env.BILLING_MODE !== "test")
      throw new BillingError("billing_reconciliation_test_only", 409);
    const config = readBillingConfig(process.env);
    if (!config || billingMode(config) !== "test") throw new BillingError("billing_configuration");
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !["postgres:", "postgresql:"].includes(new URL(connectionString).protocol))
      throw new BillingError("billing_database_url_required");
    pool = new Pool({
      connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      application_name: "lov-billing-reconcile-checkout", options: "-c lock_timeout=3000",
    });
    const service = new BillingService(dbFromPool(pool), config, makeStripeBillingGateway(config));
    const result = await service.reconcileKnownCheckout(values["user-id"], values["request-id"]);
    console.log(JSON.stringify({ ok: true, ...result }));
  }
} catch (error) {
  const allowed = new Set([
    "billing_checkout_attempt_not_found", "billing_configuration", "billing_configuration_changed",
    "billing_database_url_required", "billing_environment_mismatch", "billing_invalid_request",
    "billing_price_unavailable", "billing_provider_unavailable", "billing_reconciliation_required",
    "billing_reconciliation_test_only", "billing_user_unavailable",
  ]);
  const code = error instanceof BillingError && allowed.has(error.code) ? error.code : "billing_reconcile_failed";
  console.log(JSON.stringify({ ok: false, error: code }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
