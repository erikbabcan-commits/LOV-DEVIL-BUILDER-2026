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
  PublishLiveAddress,
  PublishRequest,
  type PublishPromotion,
  type PublishResult,
  type PublishProjectVersion,
  type PublishSelection,
  type PublishReady,
} from "../../shared/publish";
import { ArtifactStore } from "./artifacts";
import type { StorageOutcome } from "./storageGate";
import {
  PublishError,
  validatePublishConfig,
  type PublishConfig,
} from "./config";
export { PublishError } from "./config";
type StoragePhase = "legacy_unknown" | "compiling" | "writing" | "retained" | "empty";
type Receipt = { sha256: string; bytes: number };
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
  storage_phase: StoragePhase;
  state: "building" | "published" | "failed";
  withdrawn_at: Date | string | null;
  error_code: string | null;
  errors: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  claim_id: string;
}
type ViewRow = Pick<
  Row,
  | "request_id"
  | "project_id"
  | "project_revision"
  | "snapshot_id"
  | "state"
  | "withdrawn_at"
  | "artifact_id"
  | "artifact_bytes"
  | "storage_phase"
  | "error_code"
  | "errors"
  | "created_at"
>;
export class PublishService {
  readonly artifacts: ArtifactStore;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly now: () => number;
  constructor(
    private readonly db: DbLike,
    readonly config: PublishConfig,
    private readonly compiler: SandboxExecutor,
    options: { artifacts?: ArtifactStore; now?: () => number } = {},
  ) {
    validatePublishConfig(config);
    if (!db.transaction) throw new PublishError("publish_storage_unavailable");
    this.now = options.now ?? Date.now;
    this.artifacts = options.artifacts ?? new ArtifactStore(
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
  /** Translate the stored job without returning a public URL after withdrawal. */
  private view(row: ViewRow): PublishResult {
    return PublishJob.parse({
      requestId: row.request_id,
      projectId: row.project_id,
      revision: row.project_revision,
      snapshotId: row.snapshot_id,
      state: row.withdrawn_at ? "withdrawn" : row.state,
      url:
        row.state === "published" && !row.withdrawn_at
          ? new URL("p/" + row.artifact_id + "/", this.config.baseUrl).href
          : null,
      error: row.error_code,
      errors: row.errors ?? [],
      artifactBytes: row.state === "published" || row.storage_phase === "retained" ? row.artifact_bytes : null,
      createdAt: new Date(row.created_at).toISOString(),
    });
  }
  private async owner<T>(owner: string, work: (tx: DbLike) => Promise<T>): Promise<T> {
    return this.db.transaction!(async tx => {
      await tx.query("SET LOCAL lock_timeout='1000ms'");
      await tx.query("SET LOCAL statement_timeout='2000ms'");
      if (!(await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner])).rows.length)
        throw new PublishError("publish_unauthenticated", 401);
      return work(tx);
    });
  }
  private async expireCompiling(tx: DbLike, owner: string): Promise<void> {
    // Only this phase proves that no filesystem writer has been authorized.
    // State changes fence even an old compiler that survives its expired lease.
    await tx.query(
      "UPDATE publish_jobs SET state='failed',storage_phase='empty',artifact_bytes=0,artifact_sha256=NULL,error_code='publish_build_expired',errors='[]'::jsonb,updated_at=$3 WHERE owner_id=$1 AND state='building' AND storage_phase='compiling' AND updated_at<$2",
      [owner, new Date(this.now() - 120000).toISOString(), new Date(this.now()).toISOString()],
    );
  }
  async status(owner: string, requestId: string): Promise<PublishResult> {
    return this.owner(owner, async tx => {
      await this.expireCompiling(tx, owner);
      const row = (await tx.query("SELECT * FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", [owner, requestId])).rows[0] as Row | undefined;
      if (!row) throw new PublishError("publish_not_found", 404);
      return this.view(row);
    });
  }
  /** Revoke a published URL under the owner lock while retaining its bytes and history. */
  async withdraw(owner: string, requestId: string): Promise<PublishResult> {
    return this.owner(owner, async tx => {
      const row = (await tx.query(
        "SELECT * FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", [owner, requestId],
      )).rows[0] as Row | undefined;
      if (!row) throw new PublishError("publish_not_found", 404);
      if (row.state !== "published") throw new PublishError("publish_not_public", 409);
      if (row.withdrawn_at) return this.view(row);
      const result = await tx.query(
        "UPDATE publish_jobs SET withdrawn_at=now() WHERE owner_id=$1 AND request_id=$2 RETURNING *",
        [owner, requestId],
      );
      return this.view(result.rows[0]);
    });
  }
  /** Reads the newest successful publication for the owner's current saved revision. */
  async publishedVersion(
    owner: string,
    version: PublishProjectVersion,
  ): Promise<PublishResult | null> {
    const row = (
      await this.db.query(
        `SELECT j.request_id, j.project_id, j.project_revision, j.snapshot_id,
                j.state, j.withdrawn_at, j.artifact_id, j.artifact_bytes, j.storage_phase,
                j.error_code, j.errors, j.created_at
         FROM publish_jobs AS j
         JOIN builder_projects AS p
           ON p.owner_id = j.owner_id AND p.project_id = j.project_id
         WHERE j.owner_id = $1 AND j.project_id = $2 AND j.project_revision = $3
           AND j.snapshot_id = $4 AND j.state = 'published' AND j.withdrawn_at IS NULL
           AND p.revision = $3 AND p.deleted_at IS NULL
         ORDER BY j.updated_at DESC, j.request_id DESC LIMIT 1`,
        [owner, version.projectId, version.expectedRevision, version.snapshotId],
      )
    ).rows[0] as ViewRow | undefined;
    return row ? this.view(row) : null;
  }
  async latestPublished(owner: string, projectId: string): Promise<PublishResult | null> {
    const row = (
      await this.db.query(
        `SELECT j.request_id, j.project_id, j.project_revision, j.snapshot_id,
                j.state, j.withdrawn_at, j.artifact_id, j.artifact_bytes, j.storage_phase,
                j.error_code, j.errors, j.created_at
         FROM publish_jobs AS j
         JOIN builder_projects AS p
           ON p.owner_id = j.owner_id AND p.project_id = j.project_id
         WHERE j.owner_id = $1 AND j.project_id = $2
           AND j.state = 'published' AND j.withdrawn_at IS NULL AND p.deleted_at IS NULL
         ORDER BY j.project_revision DESC, j.updated_at DESC, j.request_id DESC LIMIT 1`,
        [owner, projectId],
      )
    ).rows[0] as ViewRow | undefined;
    return row ? this.view(row) : null;
  }
  /** Return at most two distinct, still-public snapshots in release order. */
  async recentPublications(owner: string, projectId: string): Promise<PublishResult[]> {
    const rows = (await this.db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (j.snapshot_id)
                j.request_id, j.project_id, j.project_revision, j.snapshot_id,
                j.state, j.withdrawn_at, j.artifact_id, j.artifact_bytes, j.storage_phase,
                j.error_code, j.errors, j.created_at, j.updated_at
         FROM publish_jobs AS j
         JOIN builder_projects AS p
           ON p.owner_id = j.owner_id AND p.project_id = j.project_id
         WHERE j.owner_id = $1 AND j.project_id = $2
           AND j.state = 'published' AND j.withdrawn_at IS NULL AND p.deleted_at IS NULL
         ORDER BY j.snapshot_id, j.project_revision DESC, j.updated_at DESC, j.request_id DESC
       ) AS releases
       ORDER BY project_revision DESC, updated_at DESC, request_id DESC LIMIT 2`,
      [owner, projectId],
    )).rows as ViewRow[];
    return rows.map((row) => this.view(row));
  }
  /** Read the active and previous live releases for a non-deleted project owned by this account. */
  async liveAddress(owner: string, projectId: string, db = this.db): Promise<PublishLiveAddress | null> {
    const row = (await db.query(
      `SELECT a.alias_id, a.version,
              j.request_id, j.project_revision,
              prev.request_id AS previous_request_id, prev.project_revision AS previous_revision
       FROM publish_live_addresses AS a
       JOIN builder_projects AS p USING (owner_id, project_id)
       LEFT JOIN publish_jobs AS j
         ON j.owner_id = a.owner_id AND j.project_id = a.project_id AND j.request_id = a.request_id
         AND j.state = 'published' AND j.withdrawn_at IS NULL
       LEFT JOIN publish_jobs AS prev
         ON prev.owner_id = a.owner_id AND prev.project_id = a.project_id
         AND prev.request_id = a.previous_request_id AND prev.state = 'published' AND prev.withdrawn_at IS NULL
       WHERE a.owner_id = $1 AND a.project_id = $2 AND p.deleted_at IS NULL`,
      [owner, projectId],
    )).rows[0];
    if (!row) return null;
    return PublishLiveAddress.parse({
      url: new URL("p/live/" + row.alias_id + "/", this.config.baseUrl).href,
      version: row.version,
      current: row.request_id ? { requestId: row.request_id, revision: row.project_revision } : null,
      previous: row.previous_request_id
        ? { requestId: row.previous_request_id, revision: row.previous_revision }
        : null,
    });
  }
  /** Read the receipt only for an active publication belonging to this project. */
  private async promotionTarget(db: DbLike, owner: string, projectId: string, requestId: string) {
    return (await db.query(
      `SELECT j.artifact_id, j.artifact_sha256, j.artifact_bytes
       FROM publish_jobs AS j JOIN builder_projects AS p USING (owner_id, project_id)
       WHERE j.owner_id=$1 AND j.project_id=$2 AND j.request_id=$3
         AND j.state='published' AND j.withdrawn_at IS NULL AND p.deleted_at IS NULL`,
      [owner, projectId, requestId],
    )).rows[0];
  }
  /** Point the stable address at an existing artifact without starting a build. */
  async promote(owner: string, projectId: string, selection: PublishPromotion): Promise<PublishLiveAddress> {
    const verified = await this.promotionTarget(this.db, owner, projectId, selection.requestId);
    if (!verified) throw new PublishError("publish_not_found", 404);
    try {
      await this.artifacts.verifyForPromotion(verified.artifact_id, verified.artifact_sha256, Number(verified.artifact_bytes));
    } catch {
      throw new PublishError("publish_live_artifact_unavailable", 503);
    }
    return this.owner(owner, async tx => {
      const project = await tx.query(
        "SELECT project_id FROM builder_projects WHERE owner_id=$1 AND project_id=$2 AND deleted_at IS NULL FOR UPDATE",
        [owner, projectId],
      );
      if (!project.rows.length) throw new PublishError("publish_project_not_found", 404);
      const current = await this.liveAddress(owner, projectId, tx);
      if ((current?.version ?? null) !== selection.expectedVersion)
        throw new PublishError("publish_live_conflict", 409);
      // Withdrawal, deletion or a newer selection can win while verification is in flight.
      const target = await this.promotionTarget(tx, owner, projectId, selection.requestId);
      if (!target) throw new PublishError("publish_not_found", 404);
      if (target.artifact_id !== verified.artifact_id || target.artifact_sha256 !== verified.artifact_sha256 ||
          target.artifact_bytes !== verified.artifact_bytes)
        throw new PublishError("publish_live_artifact_unavailable", 503);
      if (current?.current?.requestId === selection.requestId) return current;
      const previous = current?.current?.requestId ?? current?.previous?.requestId;
      await tx.query(
        `INSERT INTO publish_live_addresses (owner_id, project_id, alias_id, version, request_id, previous_request_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_id, project_id) DO UPDATE SET version = EXCLUDED.version,
           request_id = EXCLUDED.request_id, previous_request_id = EXCLUDED.previous_request_id`,
        [owner, projectId, randomUUID(), randomUUID(), selection.requestId,
          previous === selection.requestId ? null : previous ?? null],
      );
      const address = await this.liveAddress(owner, projectId, tx);
      if (!address) throw new PublishError("publish_unavailable");
      return address;
    });
  }
  private reservedBytes(row: Pick<Row, "state" | "storage_phase" | "artifact_bytes">): number {
    if (row.storage_phase === "empty" && row.state === "failed") return 0;
    if (row.storage_phase === "legacy_unknown")
      throw new PublishError("publish_storage_recovery_required");
    if (!["compiling", "writing", "retained"].includes(row.storage_phase) ||
        !Number.isSafeInteger(row.artifact_bytes) || row.artifact_bytes! < 1)
      throw new PublishError("publish_storage_recovery_required");
    return row.artifact_bytes!;
  }
  async start(
    owner: string,
    selection: PublishSelection,
  ): Promise<PublishResult> {
    const parsed = PublishRequest.safeParse(selection);
    if (!parsed.success) throw new PublishError("publish_invalid_request", 400);
    // Reclaim a lost-receipt compile lease even when storage readiness is stalled.
    await this.owner(owner, tx => this.expireCompiling(tx, owner));
    const readiness = await this.ready();
    if (!readiness.ready)
      throw new PublishError(
        readiness.reason === "storage_unavailable"
          ? "publish_storage_unavailable"
          : "publish_sandbox_unavailable",
      );
    const key = owner + ":" + selection.requestId;
    const prepared = await this.owner(owner, async tx => {
      await this.expireCompiling(tx, owner);
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
        return { row: existing, launch: false };
      }
      if (this.jobs.size >= 8) throw new PublishError("publish_busy", 429);
      const maxAttempts = this.config.maxArtifacts;
      const usage = (
        await tx.query(
          "SELECT state,storage_phase,artifact_bytes FROM publish_jobs WHERE owner_id=$1 LIMIT $2",
          [owner, maxAttempts],
        )
      ).rows as Array<Pick<Row, "state" | "storage_phase" | "artifact_bytes">>;
      // Failed attempts still count against the durable abuse limit.
      if (usage.length >= maxAttempts)
        throw new PublishError("publish_capacity", 413);
      // Capacity is durable metadata only. No disk inspection can pin this pool.
      const usedBytes = usage.reduce((total, row) => total + this.reservedBytes(row), 0);
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
      const at = new Date(this.now()).toISOString(),
        artifact = randomUUID(),
        claim = randomUUID();
      await tx.query(
        "INSERT INTO publish_jobs(owner_id,request_id,project_id,project_revision,snapshot_id,source_fingerprint,source_files,artifact_id,state,created_at,updated_at,claim_id,artifact_bytes,storage_phase) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'building',$9,$9,$10,$11,'compiling')",
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
          this.config.maxArtifactBytes,
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
  private async claim(
    row: Row,
    work: (tx: DbLike, current: Row) => Promise<void>,
  ): Promise<void> {
    await this.owner(row.owner_id, async tx => {
      const current = (await tx.query("SELECT * FROM publish_jobs WHERE owner_id=$1 AND request_id=$2", [row.owner_id, row.request_id])).rows[0] as Row | undefined;
      if (current?.claim_id !== row.claim_id) return;
      await work(tx, current);
    });
  }
  private async markWriting(row: Row, sha: string, bytes: number): Promise<boolean> {
    let armed = false;
    await this.claim(row, async (tx, current) => {
      if (current.state !== "building" || current.storage_phase !== "compiling") return;
      if (bytes > this.reservedBytes(current)) throw new PublishError("publish_artifact_limit", 413);
      await tx.query("UPDATE publish_jobs SET storage_phase='writing',artifact_sha256=$4,updated_at=$5 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3", [row.owner_id, row.request_id, row.claim_id, sha, new Date(this.now()).toISOString()]);
      armed = true;
    });
    return armed;
  }
  private checkedReceipt(receipt: Receipt, sha: string, bytes: number): Receipt {
    if (receipt.sha256 !== sha || receipt.bytes !== bytes) throw new PublishError("publish_storage_unavailable");
    return receipt;
  }
  private async publish(row: Row, receipt: Receipt): Promise<void> {
    await this.claim(row, async (tx, current) => {
      if (current.state !== "building" || current.storage_phase !== "writing") return;
      if (current.artifact_sha256 !== receipt.sha256 || receipt.bytes > this.reservedBytes(current))
        throw new PublishError("publish_storage_unavailable");
      await tx.query("UPDATE publish_jobs SET state='published',storage_phase='retained',artifact_bytes=$4,error_code=NULL,errors='[]'::jsonb,updated_at=$5 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3", [row.owner_id, row.request_id, row.claim_id, receipt.bytes, new Date(this.now()).toISOString()]);
    });
  }
  private async fail(row: Row, error: unknown, errors: Array<{file: string; message: string}>, receipt?: Receipt): Promise<void> {
    await this.claim(row, async (tx, current) => {
      if (current.state !== "building") return;
      const empty = current.storage_phase === "compiling";
      const known = receipt && current.artifact_sha256 === receipt.sha256 && receipt.bytes <= this.reservedBytes(current);
      const phase: StoragePhase = empty ? "empty" : known ? "retained" : current.storage_phase;
      const bytes = empty ? 0 : known ? receipt.bytes : current.artifact_bytes;
      const code = error instanceof PublishError ? error.code : "publish_build_unavailable";
      await tx.query("UPDATE publish_jobs SET state='failed',storage_phase=$4,artifact_bytes=$5,error_code=$6,errors=$7::jsonb,updated_at=$8 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3", [row.owner_id, row.request_id, row.claim_id, phase, bytes, code, JSON.stringify(errors.map(e => ({ file: redactSecrets(e.file).slice(0,200), message: redactSecrets(e.message).slice(0,800) }))), new Date(this.now()).toISOString()]);
    });
  }
  private async afterStorageFailure(row: Row, outcome: StorageOutcome<Receipt>, sha: string, bytes: number): Promise<void> {
    await this.claim(row, async (tx, current) => {
      if (!["building", "failed"].includes(current.state) || !["compiling", "writing"].includes(current.storage_phase)) return;
      if (!outcome.ioStarted) {
        // The gate proves this cancelled callback will NEVER start filesystem I/O.
        await tx.query("UPDATE publish_jobs SET state='failed',storage_phase='empty',artifact_bytes=0,artifact_sha256=NULL,error_code=COALESCE(error_code,'publish_storage_cancelled'),updated_at=$4 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3", [row.owner_id,row.request_id,row.claim_id,new Date(this.now()).toISOString()]);
      } else if (outcome.ok) {
        const receipt = this.checkedReceipt(outcome.value!, sha, bytes);
        if (current.artifact_sha256 !== sha || receipt.bytes > this.reservedBytes(current)) throw new PublishError("publish_storage_unavailable");
        // Late completion may record retained bytes, but cannot make a public URL.
        await tx.query("UPDATE publish_jobs SET state='failed',storage_phase='retained',artifact_bytes=$4,error_code=COALESCE(error_code,'publish_storage_result_unconfirmed'),updated_at=$5 WHERE owner_id=$1 AND request_id=$2 AND claim_id=$3", [row.owner_id,row.request_id,row.claim_id,receipt.bytes,new Date(this.now()).toISOString()]);
      }
      // A settled write error can still have a partial temp/final inode. Its full
      // durable reservation stays charged; never inspect/free it in this pool.
    });
  }
  private async run(row: Row): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors: Array<{file: string; message: string}> = [];
    let receipt: Receipt | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PublishError("publish_timeout")); }, 100000); });
      const result = parseBuildResult(await Promise.race([this.compiler.execute(row.source_files as SandboxFile[], controller.signal), timeout]));
      if (!result.ok || !result.html) { errors = result.errors; throw new PublishError("publish_build_failed",400); }
      const bytes = Buffer.byteLength(result.html);
      if (bytes > this.config.maxArtifactBytes) throw new PublishError("publish_artifact_limit",413);
      const sha = createHash("sha256").update(result.html).digest("hex");
      const operation = this.artifacts.writeOperation(row.artifact_id, result.html, () => this.markWriting(row,sha,bytes));
      try { receipt = this.checkedReceipt(await operation.result,sha,bytes); }
      catch (error) {
        await this.fail(row,error,errors).catch(() => {});
        void operation.settled.then(outcome => this.afterStorageFailure(row,outcome,sha,bytes)).catch(() => {});
        return;
      }
      await this.publish(row,receipt);
    } catch (error) {
      await this.fail(row,error,errors,receipt).catch(() => {});
    } finally { if (timer) clearTimeout(timer); }
  }
  async settled(): Promise<void> {
    await Promise.all([...this.jobs.values()]);
  }
}
/** Refuse to start publication without its storage, lease and withdrawal columns. */
export async function probePublishSchema(db: DbLike): Promise<boolean> {
  try {
    await db.query(
      "SELECT owner_id,request_id,artifact_id,claim_id,storage_phase,artifact_bytes,artifact_sha256,withdrawn_at FROM publish_jobs LIMIT 0",
    );
    return !!db.transaction;
  } catch {
    return false;
  }
}
