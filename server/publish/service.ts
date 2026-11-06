import { createHash, randomUUID } from "node:crypto";
import type { DbLike } from "../db/pool";
import type { SandboxExecutor } from "../sandbox/executor";
import {
  parseBuildResult,
  validateFiles,
  type SandboxFile,
} from "../sandbox/policy";
import { redactSecrets } from "../security/secrets";
import { WorkspaceSchema } from "../../shared/projectSchema";
import {
  PublishJob,
  PublishRequest,
  type PublishResult,
  type PublishSelection,
  type PublishReady,
} from "../../shared/publish";
import { ArtifactStore } from "./artifacts";
import {
  PublishError,
  validatePublishConfig,
  type PublishConfig,
} from "./config";
export { PublishError } from "./config";
interface Row {
  owner_id: string;
  request_id: string;
  project_id: string;
  project_revision: number;
  snapshot_id: string;
  source_files: unknown;
  artifact_id: string;
  artifact_sha256: string | null;
  artifact_bytes: number | null;
  state: "building" | "published" | "failed";
  error_code: string | null;
  errors: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  claim_id: string;
}
export class PublishService {
  readonly artifacts: ArtifactStore;
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(
    private readonly db: DbLike,
    readonly config: PublishConfig,
    private readonly compiler: SandboxExecutor,
  ) {
    validatePublishConfig(config);
    if (!db.transaction) throw new PublishError("publish_storage_unavailable");
    this.artifacts = new ArtifactStore(
      config.artifactDir,
      config.maxArtifactBytes,
      config.minFreeBytes ?? 1073741824,
    );
  }
  async ready(): Promise<PublishReady> {
    if (!(await this.artifacts.ready()))
      return {
        enabled: true,
        ready: false,
        reason: "storage_unavailable",
        publicOrigin: new URL(this.config.baseUrl).origin,
      };
    const status = await this.compiler
      .ready()
      .catch(() => ({ ready: false, mode: "isolated" as const }));
    const ready =
      status.ready &&
      (status.mode === "isolated" ||
        (this.config.allowHostTest === true &&
          process.env.NODE_ENV === "test"));
    return {
      enabled: true,
      ready,
      reason: ready ? null : "sandbox_unavailable",
      publicOrigin: new URL(this.config.baseUrl).origin,
    };
  }
  private view(row: Row): PublishResult {
    return PublishJob.parse({
      requestId: row.request_id,
      projectId: row.project_id,
      revision: row.project_revision,
      snapshotId: row.snapshot_id,
      state: row.state,
      url:
        row.state === "published"
          ? new URL("p/" + row.artifact_id + "/", this.config.baseUrl).href
          : null,
      error: row.error_code,
      errors: row.errors ?? [],
      artifactBytes: row.artifact_bytes,
      createdAt: new Date(row.created_at).toISOString(),
    });
  }
  async status(owner: string, requestId: string): Promise<PublishResult> {
    const row = (
      await this.db.query(
        "SELECT * FROM publish_jobs WHERE owner_id=$1 AND request_id=$2",
        [owner, requestId],
      )
    ).rows[0] as Row | undefined;
    if (!row) throw new PublishError("publish_not_found", 404);
    return this.view(row);
  }
  async start(
    owner: string,
    selection: PublishSelection,
  ): Promise<PublishResult> {
    const parsed = PublishRequest.safeParse(selection);
    if (!parsed.success) throw new PublishError("publish_invalid_request", 400);
    const readiness = await this.ready();
    if (!readiness.ready)
      throw new PublishError(
        readiness.reason === "storage_unavailable"
          ? "publish_storage_unavailable"
          : "publish_sandbox_unavailable",
      );
    const key = owner + ":" + selection.requestId;
    const prepared = await this.db.transaction!(async (tx) => {
      if (
        !(
          await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner])
        ).rows.length
      )
        throw new PublishError("publish_unauthenticated", 401);
      const existing = (
        await tx.query(
          "SELECT * FROM publish_jobs WHERE owner_id=$1 AND request_id=$2",
          [owner, selection.requestId],
        )
      ).rows[0] as Row | undefined;
      if (existing) {
        if (
          existing.project_id !== selection.projectId ||
          existing.project_revision !== selection.expectedRevision ||
          existing.snapshot_id !== selection.snapshotId
        )
          throw new PublishError("publish_request_conflict", 409);
        if (
          existing.state === "building" &&
          !this.jobs.has(key) &&
          Date.now() - new Date(existing.updated_at).getTime() > 120000
        ) {
          const claim = randomUUID();
          await tx.query(
            "UPDATE publish_jobs SET claim_id=$3,updated_at=$4 WHERE owner_id=$1 AND request_id=$2",
            [owner, selection.requestId, claim, new Date().toISOString()],
          );
          return { row: { ...existing, claim_id: claim }, launch: true };
        }
        return { row: existing, launch: false };
      }
      if (this.jobs.size >= 8) throw new PublishError("publish_busy", 429);
      const maxAttempts = this.config.maxArtifacts;
      const usage = (
        await tx.query(
          "SELECT state,artifact_id,artifact_bytes FROM publish_jobs WHERE owner_id=$1 LIMIT $2",
          [owner, maxAttempts],
        )
      ).rows as Array<Pick<Row, "state" | "artifact_id" | "artifact_bytes">>;
      // Failed attempts still count against the durable abuse limit.
      if (usage.length >= maxAttempts)
        throw new PublishError("publish_capacity", 413);
      // The owner lock also fences every artifact writer. A terminal failure's
      // confirmed empty storage cannot later acquire files from a stale claim.
      const retained = await this.artifacts.retainedBytes(usage.map(row => row.artifact_id));
      const usedBytes = usage.reduce((total, row) => {
        const diskBytes = retained.get(row.artifact_id.toLowerCase())!;
        if (row.state === "failed") return total + diskBytes;
        const reservation = row.state === "building"
          ? this.config.maxArtifactBytes
          : Number(row.artifact_bytes ?? this.config.maxArtifactBytes);
        if (!Number.isSafeInteger(reservation) || reservation < 0)
          throw new PublishError("publish_storage_unavailable");
        return total + Math.max(reservation, diskBytes);
      }, 0);
      if (!Number.isSafeInteger(usedBytes) || usedBytes + this.config.maxArtifactBytes > this.config.maxOwnerBytes)
        throw new PublishError("publish_capacity", 413);
      const project = (
        await tx.query(
          "SELECT revision,workspace,deleted_at FROM builder_projects WHERE owner_id=$1 AND project_id=$2",
          [owner, selection.projectId],
        )
      ).rows[0];
      if (!project || project.deleted_at)
        throw new PublishError("publish_project_not_found", 404);
      if (project.revision !== selection.expectedRevision)
        throw new PublishError("publish_project_conflict", 409);
      const workspace = WorkspaceSchema.safeParse(project.workspace);
      if (!workspace.success)
        throw new PublishError("publish_project_invalid", 409);
      const snapshot = workspace.data.snapshots.find(
        (s) => s.id === selection.snapshotId,
      );
      if (!snapshot?.sourceFiles)
        throw new PublishError("publish_snapshot_sources_required", 409);
      const source = JSON.parse(snapshot.sourceFiles) as Array<{
        name: string;
        content: string;
      }>;
      const files = source.map(({ name, content }) => ({
        path: name,
        content,
      }));
      if (
        validateFiles(files).length ||
        !files.some((f) => f.path === "src/main.tsx")
      )
        throw new PublishError("publish_sources_unsupported", 400);
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify(
            [...files].sort((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
            ),
          ),
        )
        .digest("hex");
      const at = new Date().toISOString(),
        artifact = randomUUID(),
        claim = randomUUID();
      await tx.query(
        "INSERT INTO publish_jobs(owner_id,request_id,project_id,project_revision,snapshot_id,source_fingerprint,source_files,artifact_id,state,created_at,updated_at,claim_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'building',$9,$9,$10)",
        [
          owner,
          selection.requestId,
          selection.projectId,
          selection.expectedRevision,
          selection.snapshotId,
          fingerprint,
          JSON.stringify(files),
          artifact,
          at,
          claim,
        ],
      );
      return {
        row: (
          await tx.query(
            "SELECT * FROM publish_jobs WHERE owner_id=$1 AND request_id=$2",
            [owner, selection.requestId],
          )
        ).rows[0] as Row,
        launch: true,
      };
    });
    if (prepared.launch) {
      const pending = this.run(prepared.row).finally(() => {
        if (this.jobs.get(key) === pending) this.jobs.delete(key);
      });
      this.jobs.set(key, pending);
    }
    return this.view(prepared.row);
  }
  /** Same lock order as start: owner first, then the exact durable claim. */
  private async withClaim(
    row: Row,
    work: (tx: DbLike) => Promise<void>,
  ): Promise<void> {
    await this.db.transaction!(async tx => {
      if (!(await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [row.owner_id])).rows.length) return;
      const current = (await tx.query(
        "SELECT claim_id,state FROM publish_jobs WHERE owner_id=$1 AND request_id=$2",
        [row.owner_id, row.request_id],
      )).rows[0];
      if (current?.state !== "building" || current.claim_id !== row.claim_id) return;
      await work(tx);
    });
  }
  private async run(row: Row): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors: Array<{ file: string; message: string }> = [];
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PublishError("publish_timeout"));
        }, 100000);
      });
      const result = parseBuildResult(
        await Promise.race([
          this.compiler.execute(
            row.source_files as SandboxFile[],
            controller.signal,
          ),
          timeout,
        ]),
      );
      if (!result.ok || !result.html) {
        errors = result.errors;
        throw new PublishError("publish_build_failed", 400);
      }
      await this.withClaim(row, async tx => {
        // Bounded <=3MB I/O stays inside the owner lock, before publication.
        // Stale or already terminal workers never create even a private orphan.
        const artifact = await this.artifacts.put(row.artifact_id, result.html!);
        await tx.query(
          "UPDATE publish_jobs SET state='published',artifact_sha256=$4,artifact_bytes=$5,error_code=NULL,errors='[]'::jsonb,updated_at=$6 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3 AND state='building'",
          [row.owner_id, row.request_id, row.claim_id, artifact.sha256, artifact.bytes, new Date().toISOString()],
        );
      });
    } catch (error) {
      const code =
        error instanceof PublishError
          ? error.code
          : "publish_build_unavailable";
      try {
        await this.withClaim(row, async tx => {
          await tx.query(
            "UPDATE publish_jobs SET state='failed',error_code=$4,errors=$5::jsonb,updated_at=$6 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3 AND state='building'",
            [
              row.owner_id, row.request_id, row.claim_id, code,
              JSON.stringify(errors.map(e => ({
                file: redactSecrets(e.file).slice(0, 200),
                message: redactSecrets(e.message).slice(0, 800),
              }))),
              new Date().toISOString(),
            ],
          );
        });
      } catch {
        /* Durable building state is recoverable after the bounded build lease. */
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async settled(): Promise<void> {
    await Promise.all([...this.jobs.values()]);
  }
}
export async function probePublishSchema(db: DbLike): Promise<boolean> {
  try {
    await db.query(
      "SELECT owner_id,request_id,artifact_id,claim_id FROM publish_jobs LIMIT 0",
    );
    return !!db.transaction;
  } catch {
    return false;
  }
}
