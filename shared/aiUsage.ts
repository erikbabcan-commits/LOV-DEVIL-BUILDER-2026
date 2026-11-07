import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Reported tokens are a lower bound whenever unknownCalls > 0. */
export const AiUsageSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-01$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-01$/),
  calls: count, reportedCalls: count, unknownCalls: count, pendingCalls: count,
  promptTokens: count, completionTokens: count,
  publishedDeployments: count.optional(),
}).refine(v => v.reportedCalls + v.unknownCalls === v.calls && v.pendingCalls <= v.unknownCalls && Number.isSafeInteger(v.promptTokens + v.completionTokens));
export type AiUsage = z.infer<typeof AiUsageSchema>;
