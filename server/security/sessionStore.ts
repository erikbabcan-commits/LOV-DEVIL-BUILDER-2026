import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Single-host persistent encrypted sessions; multi-host use requires a shared store. */
export class EncryptedSessionStore<T extends { expiresAt: number }> {
  private key: Buffer;
  constructor(private directory: string, secretHex: string) {
    if (!path.isAbsolute(directory) || !/^[a-fA-F0-9]{64}$/.test(secretHex)) throw new Error("Session storage configuration required");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || (fs.statSync(directory).mode & 0o077) !== 0) throw new Error("Session directory must be private");
    this.key = Buffer.from(secretHex, "hex");
  }
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid session identifier");
    return path.join(this.directory, id + ".json");
  }
  set(id: string, value: T) {
    const destination = this.file(id);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const temp = destination + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: bytes.toString("base64")}), {mode: 0o600, flag: "wx"});
    fs.renameSync(temp, destination);
  }
  get(id: string): T | undefined {
    try {
      const descriptor = fs.openSync(this.file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let raw;
      try { if (fs.fstatSync(descriptor).size > 32_768) return undefined; raw = fs.readFileSync(descriptor, "utf8"); } finally { fs.closeSync(descriptor); }
      const value = JSON.parse(raw);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.nonce, "base64"));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      const session: T = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8"));
      if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) { this.delete(id); return undefined; }
      return session;
    } catch { return undefined; }
  }
  delete(id: string): boolean {
    try { fs.unlinkSync(this.file(id)); return true; } catch { return false; }
  }
}
export function makeSessionStore<T extends {expiresAt: number}>(): Map<string, T> | EncryptedSessionStore<T> {
  const directory = process.env.GITHUB_SESSION_DIR;
  const secret = process.env.GITHUB_SESSION_SECRET;
  if (directory && secret) return new EncryptedSessionStore<T>(directory, secret);
  if (process.env.NODE_ENV === "production") throw new Error("Persistent encrypted OAuth session store required");
  return new Map<string, T>();
}
