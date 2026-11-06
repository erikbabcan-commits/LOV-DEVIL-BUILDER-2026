import { z } from "zod";

export const BillingIntervalSchema = z.enum(["month", "year"]);
export const BillingStatusSchema = z
  .object({
    userId: z.string().min(1).max(128),
    enabled: z.boolean(),
    mode: z.enum(["disabled", "sandbox", "live"]),
    plan: z.enum(["free", "pro"]),
    subscription: z
      .object({
        status: z.enum([
          "active",
          "trialing",
          "canceled",
          "past_due",
          "unpaid",
          "incomplete",
          "incomplete_expired",
          "paused",
        ]),
        interval: BillingIntervalSchema.nullable(),
        periodEnd: z.iso.datetime().nullable(),
        cancelAtPeriodEnd: z.boolean(),
      })
      .strict()
      .nullable(),
    prices: z
      .object({
        month: z
          .object({
            amount: z.number().int().positive(),
            currency: z.literal("eur"),
          })
          .strict()
          .nullable(),
        year: z
          .object({
            amount: z.number().int().positive(),
            currency: z.literal("eur"),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    trialDays: z.literal(14),
    checkoutAvailable: z.boolean(),
    portalAvailable: z.boolean(),
    pendingCheckout: z.boolean(),
  })
  .strict();
export type BillingStatus = z.infer<typeof BillingStatusSchema>;
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;
export const BillingCheckoutSchema = z
  .object({ interval: BillingIntervalSchema, requestId: z.uuid() })
  .strict();
export const BillingPortalSchema = z.object({ requestId: z.uuid() }).strict();
export const BillingRedirectSchema = z
  .object({ userId: z.string().min(1), url: z.url() })
  .strict();
