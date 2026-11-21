import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbLike } from "../db/pool";
import { PublishLiveAddress } from "../../shared/publish";
import { PublishError } from "./config";
import type { PublishService } from "./service";

export const PublishRollbackRequest = z.strictObject({
  requestId: z.uuid(),
  expectedVersion: z.uuid().nullable(),
  confirmed: z.literal(true),
});
export type PublishRollbackRequest = z.infer<typeof PublishRollbackRequest>;

export const PublishVersionSummary = z.strictObject({
  requestId: z.uuid(),
  revision: z.number().int().positive(),
  snapshotId: z.string().min(1),
  createdAt: z.string(),
  artifactBytes: z.number().int().nonnegative().nullable(),
  isLive: z.boolean(),
});
export type PublishVersionSummary = z.infer<typeof PublishVersionSummary>;

/**
 * GET …/versions response. `liveVersion` is the optimistic-concurrency token of
 * the live address (publish_live_addresses.version, null when nothing is live);
 * the rollback UI sends it back as `expectedVersion` (Bora W2 P2-1).
 */
export const PublishVersionList = z.strictObject({
  liveVersion: z.uuid().nullable(),
  versions: z.array(PublishVersionSummary),
});
export type PublishVersionList = z.infer<typeof PublishVersionList>;

/**
 * List immutable published (non-withdrawn) versions for an owned project.
 * Archive rows are never mutated here — only listed for the rollback UI.
 */
export async function listPublishVersions(
  db: DbLike,
  ownerId: string,
  projectId: string,
  limit = 50,
): Promise<PublishVersionSummary[]> {
  const live = (
    await db.query(
      `SELECT request_id FROM publish_live_addresses
       WHERE owner_id=$1 AND project_id=$2`,
      [ownerId, projectId],
    )
  ).rows[0] as { request_id: string } | undefined;

  const rows = (
    await db.query(
      `SELECT j.request_id, j.project_revision, j.snapshot_id, j.created_at, j.artifact_bytes
       FROM publish_jobs AS j
       JOIN builder_projects AS p USING (owner_id, project_id)
       WHERE j.owner_id=$1 AND j.project_id=$2
         AND j.state='published' AND j.withdrawn_at IS NULL AND p.deleted_at IS NULL
       ORDER BY j.project_revision DESC, j.updated_at DESC, j.request_id DESC
       LIMIT $3`,
      [ownerId, projectId, Math.min(Math.max(limit, 1), 100)],
    )
  ).rows as Array<{
    request_id: string;
    project_revision: number;
    snapshot_id: string;
    created_at: Date | string;
    artifact_bytes: number | null;
  }>;

  return rows.map((row) =>
    PublishVersionSummary.parse({
      requestId: row.request_id,
      revision: row.project_revision,
      snapshotId: row.snapshot_id,
      createdAt: new Date(row.created_at).toISOString(),
      artifactBytes: row.artifact_bytes,
      isLive: live?.request_id === row.request_id,
    }),
  );
}

/**
 * Atomically point the live address at an older (or any) published version.
 * One owner-scoped transaction with a single UPSERT. Does not mutate the
 * immutable publish_jobs archive — only publish_live_addresses.
 *
 * Returns the new live address and the wall-clock duration of the switch (ms).
 */
export async function rollbackLiveAddress(
  service: PublishService,
  ownerId: string,
  projectId: string,
  selection: PublishRollbackRequest,
): Promise<{ address: z.infer<typeof PublishLiveAddress>; elapsedMs: number }> {
  const started = performance.now();
  // Reuse the existing promote path: verifies artifact bytes, owner lock,
  // expectedVersion conflict check, and a single UPSERT of the live row.
  const address = await service.promote(ownerId, projectId, {
    requestId: selection.requestId,
    expectedVersion: selection.expectedVersion,
    confirmed: true,
  });
  const elapsedMs = performance.now() - started;
  return { address, elapsedMs };
}

/**
 * Low-level atomic switch of publish_live_addresses. App code uses
 * rollbackLiveAddress (via PublishService.promote, which also verifies artifact
 * bytes and the optimistic version token).
 *
 * Defense in depth (Bora W2 P3-7): inside the caller's transaction it locks the
 * owner's non-deleted project row and requires the target to be a published,
 * non-withdrawn version of that same owner + project, else 404
 * publish_not_found. A previousRequestId that does not belong to the same owner
 * + project is dropped (stored as NULL). Then exactly one UPSERT.
 */
export async function atomicLiveSwitch(
  tx: DbLike,
  ownerId: string,
  projectId: string,
  requestId: string,
  previousRequestId: string | null,
): Promise<void> {
  const project = await tx.query(
    "SELECT project_id FROM builder_projects WHERE owner_id=$1 AND project_id=$2 AND deleted_at IS NULL FOR UPDATE",
    [ownerId, projectId],
  );
  if (!project.rows.length) throw new PublishError("publish_not_found", 404);
  const owned = async (candidate: string) =>
    (
      await tx.query(
        `SELECT request_id FROM publish_jobs
         WHERE owner_id=$1 AND project_id=$2 AND request_id=$3
           AND state='published' AND withdrawn_at IS NULL`,
        [ownerId, projectId, candidate],
      )
    ).rows.length > 0;
  if (!(await owned(requestId))) throw new PublishError("publish_not_found", 404);
  const previous =
    previousRequestId && previousRequestId !== requestId && (await owned(previousRequestId))
      ? previousRequestId
      : null;
  await tx.query(
    `INSERT INTO publish_live_addresses (owner_id, project_id, alias_id, version, request_id, previous_request_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_id, project_id) DO UPDATE SET
       version = EXCLUDED.version,
       request_id = EXCLUDED.request_id,
       previous_request_id = EXCLUDED.previous_request_id`,
    [ownerId, projectId, randomUUID(), randomUUID(), requestId, previous],
  );
}

export { PublishError };
