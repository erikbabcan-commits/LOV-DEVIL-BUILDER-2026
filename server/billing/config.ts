import { BillingError, type BillingConfig } from "./types";
export type { BillingConfig } from "./types";

export type BillingMode = "test" | "live";
export function billingMode(config: BillingConfig): BillingMode {
  return config.mode ?? "test";
}
export function billingLivemode(config: BillingConfig): boolean {
  return billingMode(config) === "live";
}

export function readBillingConfig(
  env: Record<string, string | undefined>,
): BillingConfig | null {
  if (
    env.BILLING_ENABLED !== undefined &&
    !["0", "1"].includes(env.BILLING_ENABLED)
  )
    throw new Error("BILLING_ENABLED must be 0 or 1.");
  if (env.BILLING_ENABLED !== "1") return null;
  if (env.AUTH_ENABLED !== "1")
    throw new Error("Billing requires AUTH_ENABLED=1.");
  const mode = env.BILLING_MODE;
  if (mode !== undefined && mode !== "test" && mode !== "live")
    throw new BillingError("billing_configuration");
  const integer = (value: string | undefined) =>
    value && /^[1-9]\d{0,7}$/.test(value) ? Number(value) : NaN;
  const config: BillingConfig = {
    ...(mode !== undefined ? { mode } : {}),
    secretKey: env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
    appUrl: env.BILLING_APP_URL ?? "",
    prices: {
      month: {
        priceId: env.STRIPE_PRO_MONTHLY_PRICE_ID ?? "",
        amount: integer(env.BILLING_PRO_MONTHLY_EUR_CENTS),
      },
      year: {
        priceId: env.STRIPE_PRO_YEARLY_PRICE_ID ?? "",
        amount: integer(env.BILLING_PRO_YEARLY_EUR_CENTS),
      },
    },
  };
  validateBillingConfig(config, env.NODE_ENV === "test");
  return config;
}
export function validateBillingConfig(
  config: BillingConfig,
  allowLoopback = false,
): void {
  if (config.mode !== undefined && !["test", "live"].includes(config.mode))
    throw new BillingError("billing_configuration");
  const live = billingLivemode(config);
  let url: URL;
  try {
    url = new URL(config.appUrl);
  } catch {
    throw new BillingError("billing_configuration");
  }
  const loopback =
    !live &&
    allowLoopback &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.protocol === "http:";
  if (
    (!loopback && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== config.appUrl ||
    url.pathname !== "/"
  )
    throw new BillingError("billing_configuration");
  if (
    live &&
    (url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "[::1]" ||
      /^127\./.test(url.hostname))
  )
    throw new BillingError("billing_configuration");
  if (
    !new RegExp("^sk_" + billingMode(config) + "_[A-Za-z0-9_]{8,}$").test(
      config.secretKey,
    ) ||
    !/^whsec_[A-Za-z0-9_]{8,}$/.test(config.webhookSecret)
  )
    throw new BillingError("billing_configuration");
  for (const price of Object.values(config.prices))
    if (
      !/^price_[A-Za-z0-9_]{1,128}$/.test(price.priceId) ||
      !Number.isSafeInteger(price.amount) ||
      price.amount <= 0 ||
      price.amount > 99_999_999
    )
      throw new BillingError("billing_configuration");
  if (config.prices.month.priceId === config.prices.year.priceId)
    throw new BillingError("billing_configuration");
}
