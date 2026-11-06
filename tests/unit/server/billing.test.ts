// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { makeStripeBillingGateway } from "../../../server/billing/gateway";
import { newDb } from "pg-mem";
import {
  billingContract,
  BILLING_TEST_CONFIG,
} from "../../helpers/billingContract";
import { dbFromPool } from "../../../server/db/pool";
import { registerProjectByteLength } from "../../helpers/projectMemoryDb";
import {
  readBillingConfig,
  validateBillingConfig,
} from "../../../server/billing/config";

billingContract("billing HTTP → signed Stripe boundary → pg-mem", async () => {
  const mem = newDb();
  registerProjectByteLength(mem);
  const pool = new (mem.adapters.createPg().Pool)();
  return {
    db: dbFromPool(pool),
    close: async () => {
      await pool.end();
    },
  };
});
describe("explicit default-off sandbox configuration", () => {
  it("leaves billing off without reading or requiring credentials", () => {
    expect(readBillingConfig({})).toBeNull();
    expect(
      readBillingConfig({
        BILLING_ENABLED: "0",
        STRIPE_SECRET_KEY: "sk_live_unused",
      }),
    ).toBeNull();
  });
  it.each(["yes", "true", "2"])(
    "rejects ambiguous enable value %s",
    (BILLING_ENABLED) =>
      expect(() => readBillingConfig({ BILLING_ENABLED })).toThrow(),
  );
  it("loads only a complete explicit sandbox configuration", () => {
    expect(
      readBillingConfig({
        BILLING_ENABLED: "1",
        AUTH_ENABLED: "1",
        STRIPE_SECRET_KEY: BILLING_TEST_CONFIG.secretKey,
        STRIPE_WEBHOOK_SECRET: BILLING_TEST_CONFIG.webhookSecret,
        BILLING_APP_URL: BILLING_TEST_CONFIG.appUrl,
        STRIPE_PRO_MONTHLY_PRICE_ID: BILLING_TEST_CONFIG.prices.month.priceId,
        STRIPE_PRO_YEARLY_PRICE_ID: BILLING_TEST_CONFIG.prices.year.priceId,
        BILLING_PRO_MONTHLY_EUR_CENTS: "2000",
        BILLING_PRO_YEARLY_EUR_CENTS: "20000",
      }),
    ).toEqual(BILLING_TEST_CONFIG);
  });
  it("requires authentication and rejects live credentials", () => {
    expect(() => readBillingConfig({ BILLING_ENABLED: "1" })).toThrow();
    expect(() =>
      validateBillingConfig({
        ...BILLING_TEST_CONFIG,
        secretKey: "sk_live_not_authorized",
      }),
    ).toThrow();
  });
  it.each([
    "https://builder.example.test/path",
    "https://user:pass@builder.example.test/",
    "https://builder.example.test/?return=evil",
    "http://builder.example.test/",
    "https://builder.example.test/#x",
  ])("rejects unsafe or non-canonical app return URL %s", (appUrl) =>
    expect(() =>
      validateBillingConfig({ ...BILLING_TEST_CONFIG, appUrl }),
    ).toThrow(),
  );
  it("accepts loopback only through the explicit test option", () => {
    const config = { ...BILLING_TEST_CONFIG, appUrl: "http://localhost:5176/" };
    expect(() => validateBillingConfig(config)).toThrow();
    expect(() => validateBillingConfig(config, true)).not.toThrow();
  });
});

describe("official SDK response normalization without HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const subscription = () => ({
    id: "sub_sdk",
    customer: "cus_sdk",
    livemode: false,
    status: "active",
    trial_end: null,
    cancel_at: null as number | null,
    cancel_at_period_end: false,
    pause_collection: null,
    items: {
      has_more: false,
      data: [
        {
          price: { id: BILLING_TEST_CONFIG.prices.month.priceId },
          quantity: 1,
          current_period_end: 5000,
        },
      ],
    },
  });
  it("bounds entitlement by an earlier cancel_at and requests the complete canonical customer list", async () => {
    const sdk = new Stripe(BILLING_TEST_CONFIG.secretKey);
    const list = vi
      .spyOn(Object.getPrototypeOf(sdk.subscriptions), "list")
      .mockResolvedValue({
        has_more: false,
        data: [{ ...subscription(), cancel_at: 3000 }],
      });
    expect(
      (
        await makeStripeBillingGateway(BILLING_TEST_CONFIG).subscriptions(
          "cus_sdk",
        )
      ).data[0],
    ).toMatchObject({
      periodEnd: 3000,
      cancelAtPeriodEnd: true,
      itemsCount: 1,
      status: "active",
    });
    expect(list).toHaveBeenCalledExactlyOnceWith({
      customer: "cus_sdk",
      status: "all",
      limit: 100,
    });
  });
  it("makes a truncated item list ineligible instead of treating its first item as the whole subscription", async () => {
    const sdk = new Stripe(BILLING_TEST_CONFIG.secretKey),
      value = subscription();
    value.items.has_more = true;
    vi.spyOn(
      Object.getPrototypeOf(sdk.subscriptions),
      "list",
    ).mockResolvedValue({ has_more: false, data: [value] });
    expect(
      (
        await makeStripeBillingGateway(BILLING_TEST_CONFIG).subscriptions(
          "cus_sdk",
        )
      ).data[0].itemsCount,
    ).toBe(-1);
  });
  it("fails closed for a future subscription status outside the supported lifecycle", async () => {
    const sdk = new Stripe(BILLING_TEST_CONFIG.secretKey);
    vi.spyOn(
      Object.getPrototypeOf(sdk.subscriptions),
      "list",
    ).mockResolvedValue({
      has_more: false,
      data: [{ ...subscription(), status: "future_status" }],
    });
    await expect(
      makeStripeBillingGateway(BILLING_TEST_CONFIG).subscriptions("cus_sdk"),
    ).rejects.toMatchObject({ code: "billing_provider_unavailable" });
  });
  it("fails closed for a future Checkout status outside open, complete and expired", async () => {
    const sdk = new Stripe(BILLING_TEST_CONFIG.secretKey);
    vi.spyOn(
      Object.getPrototypeOf(sdk.checkout.sessions),
      "retrieve",
    ).mockResolvedValue({
      id: "cs_test_sdk",
      customer: "cus_sdk",
      livemode: false,
      status: "future_status",
      url: "https://checkout.stripe.com/c/pay/test",
      expires_at: 5000,
    });
    await expect(
      makeStripeBillingGateway(BILLING_TEST_CONFIG).checkout("cs_test_sdk"),
    ).rejects.toMatchObject({ code: "billing_provider_unavailable" });
  });
});
