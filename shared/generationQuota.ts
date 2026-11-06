import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const GenerationQuotaSchema = z.object({
  used: count, limit: count.positive(), remaining: count, plan: z.enum(['free', 'pro']),
}).refine(value => value.remaining === Math.max(0, value.limit - value.used));
export const GenerationQuotaUpdateSchema = z.object({ userId: z.string().min(1).max(256), quota: GenerationQuotaSchema });
export type GenerationQuotaUpdate = z.infer<typeof GenerationQuotaUpdateSchema>;
