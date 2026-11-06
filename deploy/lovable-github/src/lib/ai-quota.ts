import { z } from "zod";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AiQuotaSchema = z
  .object({ used: count, limit: count.positive(), remaining: count, plan: z.enum(["free", "pro"]) })
  .refine((quota) => quota.remaining === Math.max(0, quota.limit - quota.used));
export type AiQuota = z.infer<typeof AiQuotaSchema>;
