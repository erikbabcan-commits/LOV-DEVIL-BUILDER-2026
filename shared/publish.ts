import { z } from "zod";
import { ProjectId } from "./projectSchema";
export const PublishRequest = z
  .object({
    requestId: z.uuid(),
    projectId: ProjectId,
    expectedRevision: z.number().int().positive().max(2147483647),
    snapshotId: ProjectId,
    publicConsent: z.literal(true),
  })
  .strict();
export type PublishSelection = z.infer<typeof PublishRequest>;
export const PublishWithdrawal = z.strictObject({ confirmed: z.literal(true) });
export const PublishProjectVersion = PublishRequest.pick({
  projectId: true,
  expectedRevision: true,
  snapshotId: true,
});
export type PublishProjectVersion = z.infer<typeof PublishProjectVersion>;
export const PublishJob = z
  .object({
    requestId: z.uuid(),
    projectId: ProjectId,
    revision: z.number().int().positive(),
    snapshotId: ProjectId,
    state: z.enum(["building", "published", "withdrawn", "failed"]),
    url: z.url().nullable(),
    error: z.string().max(100).nullable(),
    errors: z
      .array(z.object({ file: z.string(), message: z.string() }).strict())
      .max(100),
    artifactBytes: z.number().int().nonnegative().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PublishResult = z.infer<typeof PublishJob>;
export const PublishReadiness = z
  .object({
    enabled: z.boolean(),
    ready: z.boolean(),
    reason: z
      .enum(["disabled", "sandbox_unavailable", "storage_unavailable"])
      .nullable(),
    publicOrigin: z.string().nullable(),
  })
  .strict();
export type PublishReady = z.infer<typeof PublishReadiness>;
