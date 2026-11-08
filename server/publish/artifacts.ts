import { constants } from "node:fs";
import {
  mkdir,
  realpath,
  lstat,
  open,
  link,
  unlink,
  statfs,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PublishError } from "./config";
import { FilesystemGate, publishFilesystemGate, publicArtifactReadGate, promotionArtifactReadGate, type StorageOperation } from "./storageGate";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class ArtifactStore {
  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly minFreeBytes = 0,
    readonly gate: FilesystemGate = publishFilesystemGate,
    readonly readGate: FilesystemGate = publicArtifactReadGate,
  ) {}
  private async root() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(this.directory)).isDirectory() ||
      (await lstat(this.directory)).isSymbolicLink()
    )
      throw new PublishError("publish_storage_unavailable");
    const root = await realpath(this.directory),
      repo = await realpath(process.cwd());
    if (root === repo || root.startsWith(repo + path.sep))
      throw new PublishError("publish_artifact_directory");
    return root;
  }
  async ready() {
    try { return await this.gate.submit(async lease => {
      if (!lease.beginIO()) throw new PublishError("publish_storage_timeout");
      return this.physicalReady();
    }).result; } catch { return false; }
  }
  private async physicalReady() {
    try {
      const info = await statfs(await this.root());
      return (
        Number(info.bavail) * Number(info.bsize) >=
        this.minFreeBytes + this.maxBytes
      );
    } catch {
      return false;
    }
  }
  writeOperation(
    id: string,
    html: string,
    prepare: () => Promise<boolean>,
  ): StorageOperation<{ sha256: string; bytes: number }> {
    return this.gate.submit(async lease => {
      // Acquire the real slot first. The callback commits a short claim CAS;
      // the following filesystem work never owns a database connection.
      if (!(await prepare()) || !lease.beginIO())
        throw new PublishError("publish_storage_cancelled");
      return this.physicalPut(id, html);
    });
  }
  async put(id: string, html: string): Promise<{ sha256: string; bytes: number }> {
    return this.writeOperation(id, html, async () => true).result;
  }
  private async physicalPut(
    id: string,
    html: string,
  ): Promise<{ sha256: string; bytes: number }> {
    if (!uuid.test(id)) throw new PublishError("publish_storage_unavailable");
    const data = Buffer.from(html),
      sha256 = createHash("sha256").update(data).digest("hex");
    if (data.length > this.maxBytes)
      throw new PublishError("publish_artifact_limit", 413);
    if (!(await this.physicalReady()))
      throw new PublishError("publish_storage_unavailable");
    const root = await this.root(),
      target = path.join(root, id + ".html"),
      temporary = path.join(root, "." + id + "." + randomUUID() + ".tmp");
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, target);
        const dir = await open(root, constants.O_RDONLY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new PublishError("publish_storage_unavailable");
        const current = await this.physicalRead(id, sha256, data.length);
        if (!current.equals(data))
          throw new PublishError("publish_storage_unavailable");
      }
    } finally {
      // Only this invocation's O_EXCL-created temporary file is removed. Any
      // failed cleanup remains visible to retainedBytes; final files never move.
      await unlink(temporary).catch(() => {});
    }
    return { sha256, bytes: data.length };
  }
  /** Diagnostic only: never run in a DB transaction or free an unsettled writer. */
  async retainedBytes(ids: readonly string[]): Promise<Map<string, number>> {
    return this.gate.submit(async lease => {
      if (!lease.beginIO()) throw new PublishError("publish_storage_timeout");
      return this.physicalRetainedBytes(ids);
    }).result;
  }
  private async physicalRetainedBytes(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length > 100 || ids.some(id => !uuid.test(id)))
      throw new PublishError("publish_storage_unavailable");
    const bytes = new Map(ids.map(id => [id.toLowerCase(), 0]));
    if (!bytes.size) return bytes;
    try {
      const root = await this.root();
      const seen = new Map<string, Set<string>>();
      for (const name of await readdir(root)) {
        const finalId = name.endsWith(".html") ? name.slice(0, -5).toLowerCase() : "";
        const temporaryId = name.startsWith(".") ? name.slice(1, 37).toLowerCase() : "";
        let id: string;
        if (bytes.has(finalId)) id = finalId;
        else if (bytes.has(temporaryId)) {
          if (name[37] !== "." || !name.endsWith(".tmp") || !uuid.test(name.slice(38, -4)))
            throw new PublishError("publish_storage_unavailable");
          id = temporaryId;
        } else continue; // Never inspect another owner's UUID or file contents.
        const stat = await lstat(path.join(root, name), { bigint: true });
        if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
          throw new PublishError("publish_storage_unavailable");
        const inode = stat.dev + ":" + stat.ino;
        const own = seen.get(id) ?? new Set<string>();
        if (!own.has(inode)) {
          const total = bytes.get(id)! + Number(stat.size);
          if (!Number.isSafeInteger(total)) throw new PublishError("publish_storage_unavailable");
          bytes.set(id, total); own.add(inode); seen.set(id, own);
        }
      }
      return bytes;
    } catch { throw new PublishError("publish_storage_unavailable"); }
  }
  /** Read and verify an artifact on the anonymous download queue. */
  read(id: string, sha256: string, size: number): Promise<Buffer> {
    return this.readVerified(this.readGate, id, sha256, size);
  }
  /** Verify a selected release without using anonymous download slots. */
  async verifyForPromotion(id: string, sha256: string, size: number): Promise<void> {
    await this.readVerified(promotionArtifactReadGate, id, sha256, size);
  }
  /** Use the same size and hash validation for public and owner-controlled reads. */
  private readVerified(gate: FilesystemGate, id: string, sha256: string, size: number): Promise<Buffer> {
    return gate.submit(async lease => {
      if (!lease.beginIO()) throw new PublishError("publish_storage_timeout");
      return this.physicalRead(id, sha256, size);
    }).result;
  }
  /** Open the artifact without following symlinks and verify its receipt. */
  private async physicalRead(id: string, sha256: string, size: number): Promise<Buffer> {
    if (
      !uuid.test(id) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > this.maxBytes
    )
      throw new PublishError("publish_artifact_not_found", 404);
    let handle;
    try {
      handle = await open(
        path.join(await this.root(), id + ".html"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== size)
        throw new Error("artifact size");
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== sha256)
        throw new Error("artifact hash");
      return bytes;
    } catch {
      throw new PublishError("publish_artifact_not_found", 404);
    } finally {
      await handle?.close();
    }
  }
}
