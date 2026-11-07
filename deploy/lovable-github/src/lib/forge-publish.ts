import { z } from "zod";
export const PublishReady = z
  .object({
    enabled: z.boolean(),
    ready: z.boolean(),
    reason: z.enum(["disabled", "sandbox_unavailable", "storage_unavailable"]).nullable(),
    publicOrigin: z.string().nullable(),
  })
  .strict();
export const PublishJob = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    revision: z.number().int().positive(),
    snapshotId: z.string(),
    state: z.enum(["building", "published", "withdrawn", "failed"]),
    url: z.string().url().nullable(),
    error: z.string().nullable(),
    errors: z.array(z.object({ file: z.string(), message: z.string() }).strict()),
    artifactBytes: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PublishedJob = z.infer<typeof PublishJob>;
export type PublishSelection = {
  requestId: string;
  projectId: string;
  expectedRevision: number;
  snapshotId: string;
  publicConsent: true;
};
export function publicationUrl(value: PublishedJob, publicOrigin: string) {
  if (!value.url || value.state !== "published") return null;
  const url = new URL(value.url),
    base = new URL(publicOrigin);
  if (
    url.origin !== base.origin ||
    url.origin === window.location.origin ||
    url.hostname === window.location.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/p\/[0-9a-f-]{36}\/$/i.test(url.pathname)
  )
    throw new Error("Publikácia vrátila neplatnú adresu.");
  return url.href;
}
export function readPendingPublish(key: string): PublishSelection | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return z
      .object({
        requestId: z.string().uuid(),
        projectId: z.string(),
        expectedRevision: z.number().int().positive(),
        snapshotId: z.string(),
        publicConsent: z.literal(true),
      })
      .strict()
      .parse(parsed);
  } catch {
    return null;
  }
}
