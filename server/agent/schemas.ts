import { z } from 'zod';

/* ---------- zod schémy: požiadavka, plán, súbory, udalosti (Workstream A/D/F) ---------- */

export const GenerateRequestSchema = z.object({
  projectId: z.string().min(1).max(64),
  prompt: z.string().min(1).max(4000),
  mode: z.enum(['create', 'iterate', 'fix']).default('create'),
  context: z.object({
    projectTitle: z.string().max(120).optional(),
    files: z.array(z.object({
      path: z.string().max(200),
      content: z.string().max(120_000),
    })).max(40).default([]),
    history: z.array(z.object({
      v: z.number(),
      prompt: z.string().max(300),
    })).max(20).default([]),
  }).default({ files: [], history: [] }),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/* Plán: model ho vracia pred generovaním súborov */
export const PlanStepSchema = z.object({
  id: z.string().max(40),
  title: z.string().max(120),
  detail: z.string().max(300).optional(),
});
export const PlanSchema = z.object({
  summary: z.string().max(500),
  steps: z.array(PlanStepSchema).min(1).max(10),
  filesPlanned: z.array(z.string().max(200)).max(20),
});
export type Plan = z.infer<typeof PlanSchema>;

/* Vygenerovaný súbor — cesta je RELATÍVNA, validácia cesty v security/pathGuard */
export const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(200_000),
  action: z.enum(['create', 'modify', 'delete']).default('create'),
});
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string().max(300),
    code: z.enum(['invalid_path', 'too_large', 'invalid_syntax', 'schema', 'empty']),
  })).default([]),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

/* ---------- SSE udalosti generovania (reálne, nie timery) ---------- */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string(), model: z.string() }),
  z.object({ type: z.literal('plan'), plan: PlanSchema }),
  z.object({ type: z.literal('plan_step'), stepId: z.string(), state: z.enum(['running', 'done']) }),
  z.object({ type: z.literal('file_started'), path: z.string(), action: GeneratedFileSchema.shape.action }),
  z.object({ type: z.literal('file_done'), path: z.string(), bytes: z.number(), action: GeneratedFileSchema.shape.action }),
  z.object({ type: z.literal('text_delta'), delta: z.string().max(2000) }),
  z.object({ type: z.literal('validation'), result: ValidationResultSchema }),
  z.object({ type: z.literal('stage'), files: z.array(GeneratedFileSchema).max(40) }),
  z.object({ type: z.literal('done'), runId: z.string(), summary: z.string().max(600) }),
  z.object({ type: z.literal('error'), code: z.string().max(40), message: z.string().max(400), retriable: z.boolean().default(false) }),
  z.object({ type: z.literal('cancelled'), runId: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const GenerateResponseSchema = z.object({
  runId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  plan: PlanSchema.nullable(),
  files: z.array(GeneratedFileSchema).max(40),
  validation: ValidationResultSchema.nullable(),
  errors: z.array(z.string().max(400)).default([]),
  model: z.string(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).default({ promptTokens: 0, completionTokens: 0 }),
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
