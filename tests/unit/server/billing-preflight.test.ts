// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectBillingProvider,
  inspectBillingDatabase,
  makeStripeBillingReadOnlyProvider,
  type BillingReadOnlyProvider,
} from "../../../server/billing/preflight";
import type { BillingConfig } from "../../../server/billing/types";
import { BILLING_TEST_CONFIG } from "../../helpers/billingContract";

const live: BillingConfig = {
  ...BILLING_TEST_CONFIG,
  mode: "live",
  secretKey: "sk_live_local_preflight_test_only",
};
function provider(config: BillingConfig, chargesEnabled = true) {
  return {
    account: vi.fn(async () => ({
      id: "acct_LocalPreflight",
      chargesEnabled,
      payoutsEnabled: false,
      detailsSubmitted: true,
    })),
    price: vi.fn<BillingReadOnlyProvider["price"]>(async (id) => {
      const interval = id === config.prices.month.priceId ? "month" : "year";
      return {
        id,
        amount: config.prices[interval].amount,
        currency: "eur",
        interval,
        intervalCount: 1,
        active: true,
        livemode: config.mode === "live",
      };
    }),
  };
}
afterEach(() => vi.restoreAllMocks());
describe("read-only billing database preflight", () => {
  function connection(mode: string | null, missing = false) {
    return { query: vi.fn(async (sql: string) => {
      if (missing && sql.includes("billing_environment")) throw new Error("missing_table");
      return {
        rows: sql === "SELECT mode FROM billing_environment WHERE id='stripe'" && mode ? [{ mode }] : [],
        rowCount: 0,
      };
    }) };
  }
  it("recognizes a matching schema using the same pinned READ ONLY transaction and never initializes it", async () => {
    const db = connection("live");
    expect(await inspectBillingDatabase(db, "live")).toEqual({ ready: true, environmentPin: "live" });
    const statements = db.query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe("BEGIN READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.slice(1, -1).every(sql => sql.startsWith("SELECT "))).toBe(true);
  });
  it("reports an uninitialized pin without silently creating it", async () => {
    expect(await inspectBillingDatabase(connection(null), "live")).toEqual({ ready: true, environmentPin: "not_initialized" });
  });
  it("reports a foreign environment or missing migration as not ready and always rolls back", async () => {
    for (const db of [connection("test"), connection(null, true)]) {
      expect(await inspectBillingDatabase(db, "live")).toEqual({ ready: false, environmentPin: "not_ready" });
      expect(db.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    }
  });
});
describe("read-only billing provider preflight", () => {
  it("verifies the live account and both configured prices without claiming a completed payment", async () => {
    const remote = provider(live);
    const result = await inspectBillingProvider(live, remote, "acct_LocalPreflight");
    expect(result).toEqual({
      ready: true,
      accountId: "acct_LocalPreflight",
      expectedAccount: "matched",
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
      prices: { month: "verified", year: "verified" },
      webhook: "not_checked",
      portal: "not_checked",
      payment: "not_attempted",
    });
    expect(remote.account).toHaveBeenCalledOnce();
    expect(remote.price.mock.calls).toEqual([
      [live.prices.month.priceId], [live.prices.year.priceId],
    ]);
  });
  it("does not report live readiness while charges are disabled", async () => {
    expect(await inspectBillingProvider(live, provider(live, false))).toMatchObject({
      ready: false, issues: ["billing_live_charges_unavailable"],
    });
    expect(await inspectBillingProvider(BILLING_TEST_CONFIG, provider(BILLING_TEST_CONFIG, false))).toMatchObject({ ready: true });
  });
  it("rejects a different intended Stripe account before reading its prices", async () => {
    const remote = provider(live);
    await expect(inspectBillingProvider(live, remote, "acct_AnotherAccount")).rejects.toMatchObject({ code: "billing_account_mismatch" });
    expect(remote.price).not.toHaveBeenCalled();
  });
  it("rejects invalid expected account values before any provider read", async () => {
    const remote = provider(live);
    await expect(inspectBillingProvider(live, remote, "private-untrusted-value")).rejects.toMatchObject({ code: "billing_expected_account_invalid" });
    expect(remote.account).not.toHaveBeenCalled();
  });
  it.each([
    { id: "price_foreign" }, { livemode: false }, { currency: "usd" },
    { amount: 999999 }, { interval: "day" }, { intervalCount: 2 }, { active: false },
  ])("rejects provider price mismatch %j", async (override) => {
    const remote = provider(live), base = await remote.price(live.prices.month.priceId);
    remote.price.mockReset().mockResolvedValue({ ...base, ...override });
    await expect(inspectBillingProvider(live, remote)).rejects.toMatchObject({ code: "billing_price_unavailable" });
  });
  it("uses only the SDK current-account and price GET methods at the provider boundary", async () => {
    const sdk = new Stripe(live.secretKey), remote = provider(live);
    const account = vi.spyOn(Object.getPrototypeOf(sdk.accounts), "retrieve").mockResolvedValue({
      id: "acct_LocalPreflight", charges_enabled: true, payouts_enabled: false, details_submitted: true,
    });
    const prices = vi.spyOn(Object.getPrototypeOf(sdk.prices), "retrieve").mockImplementation(async (id: unknown) => {
      if (typeof id !== "string") throw new TypeError("Expected a price ID");
      const price = await remote.price(id);
      return { ...price, unit_amount: price.amount, recurring: { interval: price.interval, interval_count: price.intervalCount } };
    });
    const customerWrite = vi.spyOn(Object.getPrototypeOf(sdk.customers), "create").mockRejectedValue(new Error("unexpected_write"));
    const checkoutWrite = vi.spyOn(Object.getPrototypeOf(sdk.checkout.sessions), "create").mockRejectedValue(new Error("unexpected_write"));
    const portalWrite = vi.spyOn(Object.getPrototypeOf(sdk.billingPortal.sessions), "create").mockRejectedValue(new Error("unexpected_write"));
    expect((await inspectBillingProvider(live, makeStripeBillingReadOnlyProvider(live))).ready).toBe(true);
    expect(account).toHaveBeenCalledExactlyOnceWith(null);
    expect(prices.mock.calls).toEqual([[live.prices.month.priceId], [live.prices.year.priceId]]);
    expect(customerWrite).not.toHaveBeenCalled();
    expect(checkoutWrite).not.toHaveBeenCalled();
    expect(portalWrite).not.toHaveBeenCalled();
  });
});

const repo = resolve(import.meta.dirname, "../../.."), cli = join(repo, "node_modules/tsx/dist/cli.mjs");
function run(args: string[], environment: Record<string, string> = {}, cwd = repo) {
  const result = spawnSync(process.execPath, [cli, join(repo, "scripts/billing-preflight.ts"), ...args], {
    cwd, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: "test", MISTRAL_API_KEY: "", ...environment },
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
const enabled = {
  BILLING_ENABLED: "1", AUTH_ENABLED: "1", BILLING_MODE: "live",
  STRIPE_SECRET_KEY: live.secretKey, STRIPE_WEBHOOK_SECRET: live.webhookSecret,
  BILLING_APP_URL: live.appUrl,
  STRIPE_PRO_MONTHLY_PRICE_ID: live.prices.month.priceId,
  STRIPE_PRO_YEARLY_PRICE_ID: live.prices.year.priceId,
  BILLING_PRO_MONTHLY_EUR_CENTS: String(live.prices.month.amount),
  BILLING_PRO_YEARLY_EUR_CENTS: String(live.prices.year.amount),
};
describe("billing preflight CLI", () => {
  it("stays default-off and never automatically loads the current directory dotenv", () => {
    const temp = mkdtempSync(join(tmpdir(), "lov-billing-preflight-"));
    try {
      writeFileSync(join(temp, ".env"), "BILLING_ENABLED=1\nSTRIPE_SECRET_KEY=private-cwd-value\n");
      const result = run(["--check-db", "--check-stripe"], {}, temp);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, mode: "disabled", database: "not_checked", provider: "not_called" });
      expect(result.stderr).not.toContain("private-cwd-value");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 20000);
  it("provides mode-aware configuration readiness without network by default", () => {
    const result = run([], enabled);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, mode: "live", configuration: "valid", database: "not_checked", provider: "not_called", activation: "operator_required" });
    expect(result.stdout + result.stderr).not.toContain(live.secretKey);
    expect(run(["--help"]).stdout).toContain("No migrations, pin initialization, Stripe writes");
  }, 35000);
  it("requires an explicit database URL rather than falling back to a local connection", () => {
    const result = run(["--check-db", "--check-stripe"], enabled);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, issues: ["billing_database_url_required"] });
    expect(result.stderr).toBe("");
  }, 20000);
  it("loads only an explicit dotenv file with environment taking precedence", () => {
    const temp = mkdtempSync(join(tmpdir(), "lov-billing-preflight-"));
    try {
      const file = join(temp, "private.env");
      writeFileSync(file, Object.entries(enabled).map(([key, value]) => key + "=" + value).join("\n"), { mode: 0o600 });
      expect(JSON.parse(run(["--env-file", file]).stdout).mode).toBe("live");
      const disabled = run(["--env-file", file], { BILLING_ENABLED: "0" });
      expect(JSON.parse(disabled.stdout).mode).toBe("disabled");
      expect(disabled.stdout + disabled.stderr).not.toContain(file);
      expect(disabled.stdout + disabled.stderr).not.toContain(live.secretKey);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 35000);
  it("never echoes invalid flags, credentials, or provider exception text", () => {
    const flag = run(["--private-secret-value"]);
    expect(flag.code).toBe(1);
    expect(flag.stdout + flag.stderr).not.toContain("private-secret-value");
    const invalid = run(["--check-db", "--check-stripe"], { ...enabled, STRIPE_SECRET_KEY: "private-bad-key" });
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toEqual({ ok: false, issues: ["billing_configuration"] });
    expect(invalid.stdout + invalid.stderr).not.toContain("private-bad-key");
  }, 35000);
});
