/* Workstream D: bezpečnosť ciest a limitov — vygenerované cesty sú NESPOĽAHODIVÉ. */

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 200_000;
export const MAX_TOTAL_BYTES = 2_000_000;

const ALLOWED_ROOTS = ["src/", "public/"] as const;
const ALLOWED_ROOT_FILES = new Set([
  "package.json",
  "index.html",
  "tsconfig.json",
  "vite.config.ts",
  "README.md",
  ".gitignore",
]);

/** Path traversal + whitelist ochrana. Vracia true ak je cesta bezpečná pre aplikovanie. */
export function isSafePath(p: string): boolean {
  if (!p || p.length > 200) return false;
  if (p.includes("\0")) return false;
  // normalizácia: žiadne .. segmenty, žiadne absolútne cesty, žiadne windows drive
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) return false;
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "")) return false;
  // hidden files (okrem povolených) zakázané
  if (segs.some((s) => s.startsWith(".") && !ALLOWED_ROOT_FILES.has(p))) return false;
  const isRootFile = ALLOWED_ROOT_FILES.has(p);
  const inAllowedRoot =
    segs.length > 1 && (ALLOWED_ROOTS as readonly string[]).some((r) => p.startsWith(r));
  return isRootFile || inAllowedRoot;
}

/** Veľkostné limity výstupu modelu. */
export function withinSizeLimits(files: { path: string; content: string }[]): {
  ok: boolean;
  reason?: string;
} {
  if (files.length > MAX_FILES)
    return { ok: false, reason: `file count ${files.length} > ${MAX_FILES}` };
  let total = 0;
  for (const f of files) {
    const bytes = new TextEncoder().encode(f.content).byteLength;
    if (bytes > MAX_FILE_BYTES)
      return { ok: false, reason: `${f.path}: ${bytes} > ${MAX_FILE_BYTES} B` };
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES)
    return { ok: false, reason: `total ${total} > ${MAX_TOTAL_BYTES} B` };
  return { ok: true };
}

import { z } from "zod";
const ConversationSchema = z
  .array(
    z
      .object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })
      .strict(),
  )
  .max(512);

export const ProjectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const File = z
  .object({
    name: z.string().max(200),
    content: z.string().max(200_000),
    modified: z.boolean().optional(),
  })
  .strict();
const filesValid = (files: z.infer<typeof File>[]) =>
  new Set(files.map((file) => file.name)).size === files.length &&
  files.every((file) => isSafePath(file.name) || ["styles.css", "app.js"].includes(file.name)) &&
  withinSizeLimits(files.map((file) => ({ path: file.name, content: file.content }))).ok;
export const Files = File.array().max(40).refine(filesValid, "invalid_files");
export const SnapshotSchema = z
  .object({
    id: ProjectId,
    v: z.number().int().positive(),
    prompt: z.string().max(20_000),
    kind: z.string().max(50),
    time: z.string().max(100),
    html: z.string().max(2_000_000),
    pinned: z.boolean().optional(),
    msg: z.string().max(2000).optional(),
    parentId: ProjectId.nullable().optional(),
    sourceFiles: z.string().max(3_000_000).optional(),
  })
  .strict()
  .refine((snapshot) => {
    if (snapshot.sourceFiles === undefined) return true;
    try {
      return Files.safeParse(JSON.parse(snapshot.sourceFiles)).success;
    } catch {
      return false;
    }
  }, "invalid_snapshot_sources");
export const WorkspaceSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    isPublic: z.boolean(),
    liveId: ProjectId.nullable(),
    snapshots: SnapshotSchema.array().max(100),
    files: Files,
    conversation: ConversationSchema.optional(),
  })
  .strict()
  .refine((workspace) => {
    const ids = new Set<string>(),
      versions = new Set<number>();
    let lastVersion = 0;
    for (const snapshot of workspace.snapshots) {
      if (
        snapshot.v <= lastVersion ||
        ids.has(snapshot.id) ||
        versions.has(snapshot.v) ||
        (snapshot.parentId && !ids.has(snapshot.parentId))
      )
        return false;
      lastVersion = snapshot.v;
      ids.add(snapshot.id);
      versions.add(snapshot.v);
    }
    return workspace.liveId === null ? workspace.files.length === 0 : ids.has(workspace.liveId);
  }, "invalid_history");
export type ServerWorkspace = z.infer<typeof WorkspaceSchema>;
