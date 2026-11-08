import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { parse } from "dotenv";
import { Pool } from "pg";
import { billingMode, readBillingConfig } from "../server/billing/config";
import {
  inspectBillingDatabase,
  inspectBillingProvider,
  makeStripeBillingReadOnlyProvider,
} from "../server/billing/preflight";
import { BillingError } from "../server/billing/types";

// No dotenv/config, server/index, migration runner, or billing initializer.
// An explicit file is optional; process environment takes precedence.
let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      "check-db": { type: "boolean", default: false },
      "check-stripe": { type: "boolean", default: false },
      "check-portal": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: tsx scripts/billing-preflight.ts [--env-file <private-file>] [--check-db] [--check-stripe [--check-portal]]\n" +
        "Default: configuration only, no network. Explicit dotenv file only; process environment wins.\n" +
        "--check-db: read-only schema/environment-pin checks; explicit DATABASE_URL required.\n" +
        "--check-stripe: read-only account and configured monthly/yearly EUR prices. Optional BILLING_EXPECTED_STRIPE_ACCOUNT_ID verifies the intended account.\n" +
        "--check-portal: also verify the active default Portal and invoice, payment method and cancellation features. Requires --check-stripe.\n" +
        "No migrations, pin initialization, Stripe writes, Checkout/Portal creation, or payment attempts. No secrets as arguments.",
    );
  } else {
    if (values["check-portal"] && !values["check-stripe"])
      throw new BillingError("billing_portal_check_requires_stripe");
    let env = { ...process.env };
    if (values["env-file"]) {
      try {
        const file = values["env-file"], info = statSync(file);
        if (!info.isFile() || info.size > 65536) throw new Error("invalid_file");
        env = { ...parse(readFileSync(file)), ...env };
      } catch {
        throw new BillingError("billing_env_file_unavailable");
      }
    }
    const config = readBillingConfig(env);
    if (!config) {
      console.log(JSON.stringify({
        ok: true, mode: "disabled", database: "not_checked", provider: "not_called",
      }));
    } else {
      const mode = billingMode(config);
      let database: { ready: boolean; environmentPin: string } | undefined;
      if (values["check-db"]) {
        if (!env.DATABASE_URL) throw new BillingError("billing_database_url_required");
        pool = new Pool({
          connectionString: env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          application_name: "lov-billing-preflight",
          options: "-c default_transaction_read_only=on",
        });
        const client = await pool.connect();
        try {
          database = await inspectBillingDatabase({
            query: async (sql, params) => {
              const result = await client.query(sql, params);
              return { rows: result.rows, rowCount: result.rowCount };
            },
          }, mode);
        } finally {
          client.release();
        }
      }
      // Fail closed before provider reads if a requested DB probe failed.
      const provider = values["check-stripe"] && (database?.ready ?? true)
        ? await inspectBillingProvider(config, makeStripeBillingReadOnlyProvider(config), env.BILLING_EXPECTED_STRIPE_ACCOUNT_ID, values["check-portal"])
        : undefined;
      const ok = (database?.ready ?? true) && (provider?.ready ?? true);
      console.log(JSON.stringify({
        ok, mode, configuration: "valid",
        database: database ?? "not_checked",
        provider: provider ?? "not_called",
        activation: "operator_required",
      }));
      if (!ok) process.exitCode = 1;
    }
  }
} catch (error) {
  // Never echo environment, flags, private filenames, URLs, or provider exceptions.
  const allowed = new Set([
    "billing_configuration", "billing_env_file_unavailable", "billing_database_url_required",
    "billing_expected_account_invalid", "billing_account_mismatch", "billing_price_unavailable",
    "billing_portal_check_requires_stripe",
  ]);
  const code = error instanceof BillingError && allowed.has(error.code) ? error.code : "billing_preflight_failed";
  console.log(JSON.stringify({ ok: false, issues: [code] }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
