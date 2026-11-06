import { z } from "zod";
export const ModelSelectionSchema = z.object({
  modelId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  allowFallback: z.boolean().optional(),
  fallbackIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/))
    .max(2)
    .optional(),
});
export const AiModelsSchema = z
  .object({
    defaultId: z.string().nullable(),
    models: z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
          label: z.string().min(1).max(180),
          provider: z.string().min(1).max(128),
          model: z.string().min(1).max(128),
          fallbackIds: z.array(z.string()).max(2),
        }),
      )
      .max(3),
  })
  .refine(
    (data) =>
      new Set(data.models.map((m) => m.id)).size === data.models.length &&
      (data.defaultId === null
        ? data.models.length === 0
        : data.models.some((m) => m.id === data.defaultId)) &&
      data.models.every((m) =>
        m.fallbackIds.every((id) => id !== m.id && data.models.some((other) => other.id === id)),
      ),
  );
export type AiModels = z.infer<typeof AiModelsSchema>;
