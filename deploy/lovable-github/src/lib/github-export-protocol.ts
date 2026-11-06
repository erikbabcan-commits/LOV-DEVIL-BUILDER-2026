import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const GitHubRepoName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/);
export const GitHubSnapshotSelection = z
  .object({
    projectId: id,
    snapshotId: id,
    expectedRevision: z.number().int().positive().max(2_147_483_646),
  })
  .strict();
export const PrepareGitHubExport = z
  .object({
    requestId: z.string().uuid(),
    repoName: GitHubRepoName,
    selection: GitHubSnapshotSelection,
  })
  .strict();
export const ConfirmGitHubExport = z
  .object({ requestId: z.string().uuid(), fingerprint: hash, publicConfirmed: z.literal(true) })
  .strict();
export const CancelGitHubExport = ConfirmGitHubExport.omit({ publicConfirmed: true });
export const ReadGitHubExport = z.object({ requestId: z.string().uuid() }).strict();
const repository = z.object({
  repositoryId: z.number().int().positive(),
  repoFullName: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  repoUrl: z
    .string()
    .url()
    .refine((value) => {
      const u = new URL(value);
      return (
        u.origin === "https://github.com" && !u.username && !u.password && !u.search && !u.hash
      );
    }),
});
const result = z.union([
  repository.extend({
    ok: z.literal(true),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    filesUploaded: z.number().int().min(1).max(40),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(["invalid_export", "repository_exists", "github_write_failed"]),
    repository: repository.optional(),
  }),
]);
export const GitHubExportJob = z.object({
  requestId: z.string().uuid(),
  repoName: GitHubRepoName,
  username: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  fingerprint: hash,
  status: z.enum(["prepared", "running", "succeeded", "failed", "cancelled", "expired"]),
  result: result.nullable(),
});
export const GitHubExportReview = GitHubExportJob.extend({
  username: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  visibility: z.literal("public"),
  selection: GitHubSnapshotSelection,
  title: z.string().max(200),
  version: z.number().int().positive(),
  files: z
    .array(
      z.object({ path: z.string().min(1).max(200), bytes: z.number().int().min(0).max(200_000) }),
    )
    .min(1)
    .max(40),
});
export const GitHubExportError = z.enum([
  "invalid_export_request",
  "public_confirmation_required",
  "export_not_found",
  "export_request_conflict",
  "export_expired",
  "export_not_prepared",
  "export_already_started",
  "export_recovery_unavailable",
  "export_not_verified",
  "github_recovery_unavailable",
  "invalid_selection",
  "project_not_found",
  "project_deleted",
  "project_conflict",
  "snapshot_not_found",
  "invalid_sources",
  "github_not_connected",
  "github_export_not_configured",
]);
