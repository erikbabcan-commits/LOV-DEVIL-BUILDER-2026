import { z } from "zod";
export const PlanStepSchema = z.object({
  id: z.string().max(40),
  title: z.string().max(120),
  detail: z.string().max(600).optional(),
});
export const PlanSchema = z.object({
  summary: z.string().max(800),
  steps: z.array(PlanStepSchema).min(1).max(10),
  filesPlanned: z.array(z.string().max(200)).max(32),
});
export type Plan = z.infer<typeof PlanSchema>;

/* Vygenerovaný súbor — cesta je RELATÍVNA, validácia cesty v security/pathGuard */
export const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(200_000),
  action: z.enum(["create", "modify", "delete"]).default("create"),
});
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string().max(300),
        code: z.enum(["invalid_path", "too_large", "invalid_syntax", "schema", "empty"]),
      }),
    )
    .default([]),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

/* ---------- SSE udalosti generovania (reálne, nie timery) ---------- */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), runId: z.string(), model: z.string() }),
  z.object({
    type: z.literal("provider_update"),
    reason: z.enum(["retry", "fallback"]),
    provider: z.string().max(128),
    model: z.string().max(128),
    attempt: z.number().int().min(2).max(4),
    maxAttempts: z.number().int().min(2).max(4),
    message: z.string().max(250),
  }),
  z.object({
    type: z.literal("context_update"),
    state: z.enum(["summarizing", "ready"]),
    summarizedTurns: z.number().int().min(0).max(512),
    summaryCalls: z.number().int().min(0).max(200),
  }),
  z.object({
    type: z.literal("intent_selected"),
    intent: z.enum(["create", "iterate", "fix", "explain"]),
  }),
  z.object({ type: z.literal("plan"), plan: PlanSchema }),
  z.object({
    type: z.literal("plan_step"),
    stepId: z.string(),
    state: z.enum(["running", "done"]),
  }),
  z.object({
    type: z.literal("file_started"),
    path: z.string(),
    action: GeneratedFileSchema.shape.action,
  }),
  z.object({
    type: z.literal("file_done"),
    path: z.string(),
    bytes: z.number(),
    action: GeneratedFileSchema.shape.action,
  }),
  z.object({ type: z.literal("text_delta"), delta: z.string().max(2000) }),
  z.object({ type: z.literal("validation"), result: ValidationResultSchema }),
  z.object({
    type: z.literal("stage"),
    files: z.array(GeneratedFileSchema).max(40),
    editMode: z.literal("patch").optional(),
    summary: z.string().max(600).optional(),
  }),
  z.object({ type: z.literal("done"), runId: z.string(), summary: z.string().max(600) }),
  z.object({
    type: z.literal("error"),
    code: z.string().max(40),
    message: z.string().max(400),
    retriable: z.boolean().default(false),
  }),
  z.object({ type: z.literal("cancelled"), runId: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
