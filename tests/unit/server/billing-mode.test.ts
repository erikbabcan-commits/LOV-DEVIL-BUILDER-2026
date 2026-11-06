// @vitest-environment node
import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { dbFromPool } from "../../../server/db/pool";
import {
  readBillingConfig,
  validateBillingConfig,
  billingMode,
} from "../../../server/billing/config";
import { makeStripeBillingGateway } from "../../../server/billing/gateway";
import { billingModeContract } from "../../helpers/billingModeContract";
import { BILLING_TEST_CONFIG } from "../../helpers/billingContract";
import { registerProjectByteLength } from "../../helpers/projectMemoryDb";

billingModeContract(
  "billing test/live HTTP and durable environment boundaries",
  async () => {
    const mem = newDb();
    registerProjectByteLength(mem);
    const pool = new (mem.adapters.createPg().Pool)();
    return {
      db: dbFromPool(pool),
      close: async () => {
        await pool.end();
      },
    };
  },
);
const enabled = {
  BILLING_ENABLED: "1",
  AUTH_ENABLED: "1",
  STRIPE_SECRET_KEY: BILLING_TEST_CONFIG.secretKey,
  STRIPE_WEBHOOK_SECRET: BILLING_TEST_CONFIG.webhookSecret,
  BILLING_APP_URL: BILLING_TEST_CONFIG.appUrl,
  STRIPE_PRO_MONTHLY_PRICE_ID: BILLING_TEST_CONFIG.prices.month.priceId,
  STRIPE_PRO_YEARLY_PRICE_ID: BILLING_TEST_CONFIG.prices.year.priceId,
  BILLING_PRO_MONTHLY_EUR_CENTS: "2000",
  BILLING_PRO_YEARLY_EUR_CENTS: "20000",
};
describe("explicit mode and credentials", () => {
  it("preserves default-off and old sandbox fixture compatibility", () => {
    expect(
      readBillingConfig({
        BILLING_MODE: "live",
        STRIPE_SECRET_KEY: "sk_live_unused",
      }),
    ).toBeNull();
    expect(readBillingConfig(enabled)).toEqual(BILLING_TEST_CONFIG);
    expect(billingMode(BILLING_TEST_CONFIG)).toBe("test");
  });
  it("requires an explicit live mode and matching live key", () => {
    const key = "sk_live_local_mode_config_only";
    expect(() =>
      readBillingConfig({ ...enabled, STRIPE_SECRET_KEY: key }),
    ).toThrow();
    expect(
      readBillingConfig({
        ...enabled,
        BILLING_MODE: "live",
        STRIPE_SECRET_KEY: key,
      }),
    ).toMatchObject({ mode: "live", secretKey: key });
    expect(() =>
      readBillingConfig({ ...enabled, BILLING_MODE: "live" }),
    ).toThrow();
    expect(() =>
      readBillingConfig({
        ...enabled,
        BILLING_MODE: "test",
        STRIPE_SECRET_KEY: key,
      }),
    ).toThrow();
  });
  it.each(["LIVE", "sandbox", "true", "", "production"])(
    "rejects unknown mode %s",
    (BILLING_MODE) => {
      expect(() => readBillingConfig({ ...enabled, BILLING_MODE })).toThrow();
    },
  );
  it.each([
    "http://localhost:5176/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
  ])(
    "rejects live loopback even inside an explicit test harness: %s",
    (appUrl) => {
      expect(() =>
        validateBillingConfig(
          {
            ...BILLING_TEST_CONFIG,
            mode: "live",
            secretKey: "sk_live_local_mode_config_only",
            appUrl,
          },
          true,
        ),
      ).toThrow();
    },
  );
  it("applies configuration checks even when the real SDK gateway is constructed directly", () => {
    expect(() =>
      makeStripeBillingGateway({ ...BILLING_TEST_CONFIG, mode: "live" }),
    ).toThrow();
    expect(() =>
      makeStripeBillingGateway({
        ...BILLING_TEST_CONFIG,
        mode: "live",
        secretKey: "sk_live_local_mode_config_only",
      }),
    ).not.toThrow();
  });
});
