import { constants } from "node:fs";
import {
  mkdir,
  realpath,
  lstat,
  open,
  link,
  unlink,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PublishError } from "./config";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class ArtifactStore {
  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly minFreeBytes = 0,
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
  async put(
    id: string,
    html: string,
  ): Promise<{ sha256: string; bytes: number }> {
    if (!uuid.test(id)) throw new PublishError("publish_storage_unavailable");
    const data = Buffer.from(html),
      sha256 = createHash("sha256").update(data).digest("hex");
    if (data.length > this.maxBytes)
      throw new PublishError("publish_artifact_limit", 413);
    if (!(await this.ready()))
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
      const current = await this.read(id, sha256, data.length);
      if (!current.equals(data))
        throw new PublishError("publish_storage_unavailable");
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return { sha256, bytes: data.length };
  }
  async read(id: string, sha256: string, size: number): Promise<Buffer> {
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
