import { createHash, randomUUID } from "node:crypto";
import {
  BillingStatusSchema,
  type BillingStatus,
  type BillingInterval,
} from "../../shared/billing";
import { effectivePlan } from "../auth/plans";
import type { DbLike } from "../db/pool";
import {
  validateBillingConfig,
  billingMode,
  billingLivemode,
  type BillingMode,
} from "./config";
import { initializeBillingEnvironment } from "./environment";
export {
  initializeBillingEnvironment,
  assertBillingEnvironment,
} from "./environment";
import {
  BillingError,
  type BillingConfig,
  type BillingGateway,
  type BillingSession,
  type BillingSubscription,
} from "./types";
export { BillingError } from "./types";

type User = { id: string; plan: string; plan_expires_at: Date | string | null };
type Account = {
  user_id: string;
  customer_id: string | null;
  customer_key: string;
  created_at: Date | string;
  trial_attempted: boolean;
  has_open_subscription: boolean;
  subscription_id: string | null;
  subscription_status: BillingSubscription["status"] | null;
  subscription_interval: BillingInterval | null;
  period_end: Date | string | null;
  cancel_at_period_end: boolean;
};
type Attempt = {
  request_id: string;
  user_id: string;
  interval_name: BillingInterval;
  config_fingerprint: string;
  trial_days: number | null;
  created_at: Date | string;
  requested_expires_at: number | string;
  state: "pending" | "ready" | "expired" | "complete";
  session_id: string | null;
  session_url: string | null;
  expires_at: Date | string | null;
};
type Result<T> = T | BillingError;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
const id = (value: string, prefix: string) =>
  new RegExp("^" + prefix + "_[A-Za-z0-9_]{1,180}$").test(value);
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const returnUrl = (config: BillingConfig) => config.appUrl;
function trustedUrl(value: string | null, host: string): string {
  if (!value) throw new BillingError("billing_provider_unavailable");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BillingError("billing_provider_unavailable");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== host ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new BillingError("billing_provider_unavailable");
  return parsed.href;
}
function unwrap<T>(value: Result<T>): T {
  if (value instanceof BillingError) throw value;
  return value;
}

/** Durable provider operations and canonical reconciliation serialize with AI admission on users. */
export class BillingService {
  private readonly fingerprint: string;
  private readonly mode: BillingMode;
  private readonly expectedLivemode: boolean;
  constructor(
    private readonly db: DbLike,
    private readonly config: BillingConfig,
    private readonly gateway: BillingGateway,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateBillingConfig(config, process.env.NODE_ENV === "test");
    this.mode = billingMode(config);
    this.expectedLivemode = billingLivemode(config);
    if (!db.transaction) throw new BillingError("billing_storage_unavailable");
    this.fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          mode: this.mode,
          appUrl: config.appUrl,
          prices: config.prices,
        }),
      )
      .digest("hex");
  }
  private async locked<T>(
    userId: string,
    work: (tx: DbLike, user: User) => Promise<T>,
  ): Promise<T> {
    if (!this.db.transaction)
      throw new BillingError("billing_storage_unavailable");
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        "SELECT id,plan,plan_expires_at FROM users WHERE id=$1 FOR UPDATE",
        [userId],
      );
      if (!result.rows[0])
        throw new BillingError("billing_user_unavailable", 401);
      return work(tx, result.rows[0] as User);
    });
  }
  private async account(tx: DbLike, userId: string): Promise<Account | null> {
    return (
      (
        await tx.query("SELECT * FROM billing_accounts WHERE user_id=$1", [
          userId,
        ])
      ).rows[0] ?? null
    );
  }
  async status(userId: string): Promise<BillingStatus> {
    await initializeBillingEnvironment(this.db, this.mode);
    const user = (
      await this.db.query(
        "SELECT id,plan,plan_expires_at FROM users WHERE id=$1",
        [userId],
      )
    ).rows[0] as User | undefined;
    if (!user) throw new BillingError("billing_user_unavailable", 401);
    const account = await this.account(this.db, userId);
    const pending = await this.db.query(
      "SELECT request_id FROM billing_checkout_attempts WHERE user_id=$1 AND state IN ('pending','ready')",
      [userId],
    );
    const plan = effectivePlan(user, this.now());
    return BillingStatusSchema.parse({
      userId,
      enabled: true,
      mode: this.expectedLivemode ? "live" : "sandbox",
      plan,
      subscription: account?.subscription_status
        ? {
            status: account.subscription_status,
            interval: account.subscription_interval,
            periodEnd: iso(account.period_end),
            cancelAtPeriodEnd: account.cancel_at_period_end,
          }
        : null,
      prices: {
        month: { amount: this.config.prices.month.amount, currency: "eur" },
        year: { amount: this.config.prices.year.amount, currency: "eur" },
      },
      trialDays: 14,
      checkoutAvailable: plan !== "pro" && !account?.has_open_subscription,
      portalAvailable: !!account?.customer_id,
      pendingCheckout: pending.rows.length > 0,
    });
  }
  private async verifyPrice(
    interval: BillingInterval,
    requireActive = true,
  ): Promise<void> {
    const expected = this.config.prices[interval];
    let price: Awaited<ReturnType<BillingGateway["price"]>>;
    try {
      price = await this.gateway.price(expected.priceId);
    } catch {
      throw new BillingError("billing_provider_unavailable");
    }
    if (
      price.id !== expected.priceId ||
      price.amount !== expected.amount ||
      price.currency !== "eur" ||
      price.interval !== interval ||
      price.intervalCount !== 1 ||
      (requireActive && !price.active) ||
      price.livemode !== this.expectedLivemode
    )
      throw new BillingError("billing_price_unavailable");
  }
  private async ensureCustomer(userId: string): Promise<string> {
    // Commit recovery identity BEFORE any irreversible provider call.
    await this.locked(userId, async (tx) => {
      if (!(await this.account(tx, userId)))
        await tx.query(
          "INSERT INTO billing_accounts(user_id,customer_key,created_at) VALUES($1,$2,$3)",
          [userId, randomUUID(), this.now().toISOString()],
        );
    });
    return unwrap(
      await this.locked(userId, async (tx: DbLike): Promise<Result<string>> => {
        const account = (await this.account(tx, userId))!;
        if (account.customer_id) return account.customer_id;
        if (
          this.now().getTime() - new Date(account.created_at).getTime() >
          23 * 3600_000
        )
          return new BillingError("billing_reconciliation_required", 409);
        try {
          const customer = await this.gateway.createCustomer(
            userId,
            "forge-" + this.mode + "-customer:" + account.customer_key,
          );
          if (
            !id(customer.id, "cus") ||
            customer.livemode !== this.expectedLivemode
          )
            return new BillingError("billing_provider_unavailable");
          await tx.query(
            "UPDATE billing_accounts SET customer_id=$2 WHERE user_id=$1",
            [userId, customer.id],
          );
          return customer.id;
        } catch {
          return new BillingError("billing_provider_unavailable");
        }
      }),
    );
  }
  /** Call ONLY with the owner lock held; never fetch then acquire the lock. */
  private async reconcile(
    tx: DbLike,
    userId: string,
    customerId: string,
  ): Promise<{ paid: boolean; hasNonterminal: boolean }> {
    let list: Awaited<ReturnType<BillingGateway["subscriptions"]>>;
    try {
      list = await this.gateway.subscriptions(customerId);
    } catch {
      throw new BillingError("billing_provider_unavailable");
    }
    const statuses = [
      "active",
      "trialing",
      "canceled",
      "past_due",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ];
    const timestamp = (value: number | null) =>
      value === null ||
      (Number.isSafeInteger(value) && value > 0 && value < 253402300800);
    if (
      typeof list.hasMore !== "boolean" ||
      list.hasMore ||
      list.data.length > 100 ||
      list.data.some(
        (sub) =>
          sub.customerId !== customerId ||
          sub.livemode !== this.expectedLivemode ||
          !id(sub.id, "sub") ||
          !statuses.includes(sub.status) ||
          !Number.isSafeInteger(sub.itemsCount) ||
          sub.itemsCount < 0 ||
          (sub.quantity !== null &&
            (!Number.isSafeInteger(sub.quantity) || sub.quantity < 1)) ||
          !timestamp(sub.periodEnd) ||
          !timestamp(sub.trialEnd) ||
          typeof sub.cancelAtPeriodEnd !== "boolean" ||
          typeof sub.collectionPaused !== "boolean",
      )
    )
      throw new BillingError("billing_provider_unavailable");
    const recognized = list.data.filter(
      (sub) =>
        sub.itemsCount === 1 &&
        sub.quantity === 1 &&
        Object.values(this.config.prices).some(
          (price) => price.priceId === sub.priceId,
        ),
    );
    const endFor = (sub: BillingSubscription) =>
      sub.status === "trialing"
        ? Math.min(sub.trialEnd ?? 0, sub.periodEnd ?? 0)
        : (sub.periodEnd ?? 0);
    const eligible = recognized.filter(
      (sub) =>
        ["active", "trialing"].includes(sub.status) &&
        !sub.collectionPaused &&
        Number.isSafeInteger(endFor(sub)) &&
        endFor(sub) > seconds(this.now()),
    );
    for (const interval of new Set(
      eligible.map((sub) =>
        sub.priceId === this.config.prices.month.priceId ? "month" : "year",
      ),
    ))
      await this.verifyPrice(interval, false);
    const picked =
      eligible.sort((a, b) => endFor(b) - endFor(a))[0] ??
      recognized.sort((a, b) => (b.periodEnd ?? 0) - (a.periodEnd ?? 0))[0];
    const paid = eligible.length > 0;
    const hasNonterminal = list.data.some(
      (sub) => !["canceled", "incomplete_expired"].includes(sub.status),
    );
    const end = paid ? new Date(endFor(picked) * 1000).toISOString() : null;
    const displayEnd = picked ? endFor(picked) : 0;
    const interval = picked
      ? picked.priceId === this.config.prices.month.priceId
        ? "month"
        : "year"
      : null;
    await tx.query(
      "UPDATE billing_accounts SET subscription_id=$2,subscription_status=$3,subscription_interval=$4,period_end=$5,cancel_at_period_end=$6 WHERE user_id=$1",
      [
        userId,
        picked?.id ?? null,
        picked?.status ?? null,
        interval,
        displayEnd > 0 ? new Date(displayEnd * 1000).toISOString() : null,
        picked?.cancelAtPeriodEnd ?? false,
      ],
    );
    await tx.query(
      "UPDATE billing_accounts SET has_open_subscription=$2 WHERE user_id=$1",
      [userId, hasNonterminal],
    );
    await tx.query("UPDATE users SET plan=$2,plan_expires_at=$3 WHERE id=$1", [
      userId,
      paid ? "pro" : "free",
      end,
    ]);
    if (hasNonterminal)
      await tx.query(
        "UPDATE billing_checkout_attempts SET state='complete',session_url=NULL WHERE user_id=$1 AND state IN ('pending','ready')",
        [userId],
      );
    return { paid, hasNonterminal };
  }
  async checkout(
    userId: string,
    interval: BillingInterval,
    requestId: string,
  ): Promise<{ url: string }> {
    if (!uuid(requestId) || !["month", "year"].includes(interval))
      throw new BillingError("billing_invalid_request", 400);
    await initializeBillingEnvironment(this.db, this.mode);
    await this.verifyPrice(interval);
    const customer = await this.ensureCustomer(userId);
    const prepared = unwrap(
      await this.locked(userId, async (tx, user): Promise<Result<Attempt>> => {
        const foreign = (
          await tx.query(
            "SELECT user_id FROM billing_checkout_attempts WHERE request_id=$1",
            [requestId],
          )
        ).rows[0];
        if (foreign && foreign.user_id !== userId)
          return new BillingError("billing_invalid_request", 409);
        if (
          effectivePlan(user, this.now()) === "pro" &&
          user.plan_expires_at === null
        )
          return new BillingError("billing_subscription_exists", 409);
        if ((await this.reconcile(tx, userId, customer)).hasNonterminal)
          return new BillingError("billing_subscription_exists", 409);
        const same = (
          await tx.query(
            "SELECT * FROM billing_checkout_attempts WHERE request_id=$1",
            [requestId],
          )
        ).rows[0] as Attempt | undefined;
        if (same && same.interval_name !== interval)
          return new BillingError("billing_invalid_request", 409);
        if (same?.state === "expired")
          return new BillingError("billing_checkout_expired", 409);
        if (same?.state === "complete")
          return new BillingError("billing_subscription_exists", 409);
        const active = (
          await tx.query(
            "SELECT * FROM billing_checkout_attempts WHERE user_id=$1 AND state IN ('pending','ready') ORDER BY created_at DESC",
            [userId],
          )
        ).rows as Attempt[];
        if (active.length > 1)
          return new BillingError("billing_reconciliation_required", 409);
        if (active[0]) {
          if (active[0].interval_name !== interval)
            return new BillingError("billing_checkout_pending", 409);
          if (active[0].config_fingerprint !== this.fingerprint)
            return new BillingError("billing_configuration_changed", 409);
          return active[0];
        }
        const account = (await this.account(tx, userId))!;
        const trialDays = account.trial_attempted ? null : 14;
        const at = this.now(),
          expires = seconds(at) + 3600;
        await tx.query(
          "INSERT INTO billing_checkout_attempts(request_id,user_id,interval_name,config_fingerprint,trial_days,created_at,requested_expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,'pending')",
          [
            requestId,
            userId,
            interval,
            this.fingerprint,
            trialDays,
            at.toISOString(),
            expires,
          ],
        );
        await tx.query(
          "UPDATE billing_accounts SET trial_attempted=TRUE WHERE user_id=$1",
          [userId],
        );
        return (
          await tx.query(
            "SELECT * FROM billing_checkout_attempts WHERE request_id=$1",
            [requestId],
          )
        ).rows[0] as Attempt;
      }),
    );
    return unwrap(
      await this.locked(
        userId,
        async (tx: DbLike): Promise<Result<{ url: string }>> => {
          if ((await this.reconcile(tx, userId, customer)).hasNonterminal)
            return new BillingError("billing_subscription_exists", 409);
          const attempt = (
            await tx.query(
              "SELECT * FROM billing_checkout_attempts WHERE request_id=$1 AND user_id=$2",
              [prepared.request_id, userId],
            )
          ).rows[0] as Attempt | undefined;
          if (!attempt || attempt.config_fingerprint !== this.fingerprint)
            return new BillingError("billing_configuration_changed", 409);
          if (attempt.state === "expired")
            return new BillingError("billing_checkout_expired", 409);
          if (attempt.state === "complete")
            return new BillingError("billing_subscription_exists", 409);
          if (
            this.now().getTime() - new Date(attempt.created_at).getTime() >
              23 * 3600_000 &&
            !attempt.session_id
          )
            return new BillingError("billing_reconciliation_required", 409);
          if (
            !attempt.session_id &&
            Number(attempt.requested_expires_at) < seconds(this.now()) + 1800
          )
            return new BillingError("billing_reconciliation_required", 409);
          try {
            const value = attempt.session_id
              ? await this.gateway.checkout(attempt.session_id)
              : await this.gateway.createCheckout(
                  {
                    customerId: customer,
                    priceId: this.config.prices[attempt.interval_name].priceId,
                    trialDays: attempt.trial_days,
                    successUrl: returnUrl(this.config),
                    cancelUrl: returnUrl(this.config),
                    expiresAt: Number(attempt.requested_expires_at),
                  },
                  "forge-" + this.mode + "-checkout:" + attempt.request_id,
                );
            this.validateSession(value, customer);
            if (
              value.status === "expired" ||
              value.expiresAt <= seconds(this.now())
            ) {
              await tx.query(
                "UPDATE billing_checkout_attempts SET state='expired',session_id=$2,session_url=NULL WHERE request_id=$1",
                [attempt.request_id, value.id],
              );
              return new BillingError("billing_checkout_expired", 409);
            }
            if (value.status === "complete") {
              await tx.query(
                "UPDATE billing_checkout_attempts SET state='complete',session_id=$2,session_url=NULL WHERE request_id=$1",
                [attempt.request_id, value.id],
              );
              await this.reconcile(tx, userId, customer);
              return new BillingError("billing_subscription_exists", 409);
            }
            const url = trustedUrl(value.url, "checkout.stripe.com");
            await tx.query(
              "UPDATE billing_checkout_attempts SET state='ready',session_id=$2,session_url=$3,expires_at=$4 WHERE request_id=$1",
              [
                attempt.request_id,
                value.id,
                url,
                new Date(value.expiresAt * 1000).toISOString(),
              ],
            );
            return { url };
          } catch (error) {
            return error instanceof BillingError
              ? error
              : new BillingError("billing_provider_unavailable");
          }
        },
      ),
    );
  }
  private validateSession(value: BillingSession, customer: string): void {
    if (
      !id(value.id, "cs") ||
      value.customerId !== customer ||
      value.livemode !== this.expectedLivemode ||
      !["open", "complete", "expired"].includes(value.status) ||
      !Number.isSafeInteger(value.expiresAt)
    )
      throw new BillingError("billing_provider_unavailable");
  }
  async portal(userId: string, requestId: string): Promise<{ url: string }> {
    if (!uuid(requestId))
      throw new BillingError("billing_invalid_request", 400);
    await initializeBillingEnvironment(this.db, this.mode);
    const prepared = unwrap(
      await this.locked(userId, async (tx: DbLike): Promise<Result<string>> => {
        const account = await this.account(tx, userId);
        if (!account?.customer_id)
          return new BillingError("billing_customer_unavailable", 409);
        const prior = (
          await tx.query(
            "SELECT * FROM billing_portal_attempts WHERE request_id=$1",
            [requestId],
          )
        ).rows[0];
        if (prior && prior.user_id !== userId)
          return new BillingError("billing_invalid_request", 409);
        if (prior && prior.config_fingerprint !== this.fingerprint)
          return new BillingError("billing_configuration_changed", 409);
        if (!prior)
          await tx.query(
            "INSERT INTO billing_portal_attempts(request_id,user_id,config_fingerprint,created_at) VALUES($1,$2,$3,$4)",
            [requestId, userId, this.fingerprint, this.now().toISOString()],
          );
        return account.customer_id;
      }),
    );
    return unwrap(
      await this.locked(
        userId,
        async (tx: DbLike): Promise<Result<{ url: string }>> => {
          const prior = (
            await tx.query(
              "SELECT * FROM billing_portal_attempts WHERE request_id=$1 AND user_id=$2",
              [requestId, userId],
            )
          ).rows[0];
          if (!prior) return new BillingError("billing_storage_unavailable");
          if (prior.session_url)
            return { url: trustedUrl(prior.session_url, "billing.stripe.com") };
          if (
            this.now().getTime() - new Date(prior.created_at).getTime() >
            23 * 3600_000
          )
            return new BillingError("billing_reconciliation_required", 409);
          try {
            const result = await this.gateway.createPortal(
              { customerId: prepared, returnUrl: returnUrl(this.config) },
              "forge-" + this.mode + "-portal:" + requestId,
            );
            const url = trustedUrl(result.url, "billing.stripe.com");
            await tx.query(
              "UPDATE billing_portal_attempts SET session_url=$2 WHERE request_id=$1",
              [requestId, url],
            );
            return { url };
          } catch {
            return new BillingError("billing_provider_unavailable");
          }
        },
      ),
    );
  }
  async webhook(raw: Buffer, signature: string): Promise<void> {
    if (raw.byteLength > 256 * 1024)
      throw new BillingError("billing_webhook_size", 413);
    const event = this.gateway.verifyEvent(raw, signature);
    if (
      !id(event.id, "evt") ||
      event.livemode !== this.expectedLivemode ||
      event.account
    )
      throw new BillingError("billing_webhook_environment", 400);
    if (
      ![
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.paused",
        "customer.subscription.resumed",
        "customer.subscription.trial_will_end",
        "checkout.session.completed",
        "checkout.session.expired",
        "invoice.paid",
        "invoice.payment_failed",
      ].includes(event.type)
    )
      return;
    if (!event.customerId || !id(event.customerId, "cus")) return;
    await initializeBillingEnvironment(this.db, this.mode);
    const account = (
      await this.db.query(
        "SELECT user_id FROM billing_accounts WHERE customer_id=$1",
        [event.customerId],
      )
    ).rows[0];
    if (!account) return;
    await this.locked(account.user_id, async (tx) => {
      const current = await this.account(tx, account.user_id);
      if (current?.customer_id !== event.customerId)
        throw new BillingError("billing_webhook_environment", 400);
      if (
        (
          await tx.query(
            "SELECT event_id FROM billing_events WHERE event_id=$1",
            [event.id],
          )
        ).rows.length
      )
        return;
      if (event.checkoutSessionId) {
        const attempt = (
          await tx.query(
            "SELECT * FROM billing_checkout_attempts WHERE user_id=$1 AND session_id=$2",
            [account.user_id, event.checkoutSessionId],
          )
        ).rows[0] as Attempt | undefined;
        if (attempt) {
          const actual = await this.gateway.checkout(event.checkoutSessionId);
          this.validateSession(actual, event.customerId!);
          if (actual.status !== "open")
            await tx.query(
              "UPDATE billing_checkout_attempts SET state=$2,session_url=NULL WHERE request_id=$1",
              [
                attempt.request_id,
                actual.status === "complete" ? "complete" : "expired",
              ],
            );
        }
      }
      await this.reconcile(tx, account.user_id, event.customerId!);
      await tx.query(
        "INSERT INTO billing_events(event_id,user_id,event_type,processed_at) VALUES($1,$2,$3,$4)",
        [event.id, account.user_id, event.type, this.now().toISOString()],
      );
    });
  }
}

export async function probeBillingSchema(
  db: DbLike,
  expectedMode?: BillingMode,
): Promise<{ ready: boolean }> {
  if (!db.transaction) return { ready: false };
  try {
    await db.query("SELECT plan_expires_at FROM users LIMIT 0");
    await db.query("SELECT id,mode FROM billing_environment LIMIT 0");
    await db.query(
      "SELECT user_id,customer_id,customer_key,created_at,trial_attempted,has_open_subscription,subscription_id,subscription_status,subscription_interval,period_end,cancel_at_period_end FROM billing_accounts LIMIT 0",
    );
    await db.query(
      "SELECT request_id,user_id,interval_name,config_fingerprint,trial_days,created_at,requested_expires_at,state,session_id,session_url,expires_at FROM billing_checkout_attempts LIMIT 0",
    );
    await db.query(
      "SELECT request_id,user_id,config_fingerprint,created_at,session_url FROM billing_portal_attempts LIMIT 0",
    );
    await db.query(
      "SELECT event_id,user_id,event_type,processed_at FROM billing_events LIMIT 0",
    );
    if (expectedMode) {
      const pin = (
        await db.query("SELECT mode FROM billing_environment WHERE id='stripe'")
      ).rows[0]?.mode;
      if (pin && pin !== expectedMode) return { ready: false };
      if (
        !pin &&
        expectedMode === "live" &&
        (await db.query("SELECT user_id FROM billing_accounts LIMIT 1")).rows
          .length
      )
        return { ready: false };
    }
    return { ready: true };
  } catch {
    return { ready: false };
  }
}
