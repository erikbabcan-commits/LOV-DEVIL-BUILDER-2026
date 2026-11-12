/** Portable source-only export. Mirrored byte-for-byte into the Lovable overlay. */
export interface ProjectSource {
  name: string;
  content: string;
}
export interface ProjectZip {
  bytes: Uint8Array;
  filename: string;
  fileCount: number;
}
export const ZIP_MAX_FILES = 200;
export const ZIP_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ZIP_MAX_BYTES = 50 * 1024 * 1024;
const forbidden =
  /^(?:\.env.*|\.git|\.npmrc|\.yarnrc(?:\.yml)?|\.ssh|node_modules|dist|\.output)$/i;
const credentials = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:mstrl|sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{16,}\b/,
  /\bsk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{12,}\b/,
  /\bwhsec_[A-Za-z0-9_]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:MISTRAL_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
];
export function inspectProjectSources(files: readonly ProjectSource[]): {
  errors: string[];
  warnings: string[];
  totalBytes: number;
} {
  const errors: string[] = [],
    warnings: string[] = [],
    paths = new Set<string>();
  const encoder = new TextEncoder();
  let totalBytes = 0;
  if (!files.length) errors.push("Projekt nemá súbory na export.");
  if (files.length > ZIP_MAX_FILES) errors.push("Projekt prekračuje limit 200 súborov.");
  for (const file of files) {
    const parts = file.name.split("/");
    if (
      !file.name ||
      file.name.length > 255 ||
      file.name.includes("\\") ||
      /[\p{Cc}\p{Cf}:]/u.test(file.name) ||
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          encoder.encode(p).byteLength > 255 ||
          forbidden.test(p) ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
    ) {
      errors.push("Súbor má nepovolenú cestu. Export nebol vytvorený.");
    }
    const key = file.name.normalize("NFC").toLowerCase();
    if (paths.has(key)) errors.push("Cesty súborov sa prekrývajú. Export nebol vytvorený.");
    paths.add(key);
    const bytes = encoder.encode(file.content).byteLength;
    totalBytes += bytes;
    if (bytes > ZIP_MAX_FILE_BYTES) errors.push("Súbor prekračuje limit 10 MiB.");
    if (credentials.some((pattern) => pattern.test(file.content)))
      errors.push("Súbory môžu obsahovať prihlasovací kľúč. Pred exportom ho odstráň.");
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/"))) errors.push("Súbor koliduje s adresárom.");
  }
  if (totalBytes > ZIP_MAX_BYTES) errors.push("Projekt prekračuje limit 50 MiB.");
  if (!files.some((file) => file.name === "package.json"))
    warnings.push(
      "Projekt nemá package.json. Môže ísť o statickú stránku; npm príkazy nemusia fungovať.",
    );
  if (!files.some((file) => file.name === "index.html"))
    warnings.push("Projekt nemá index.html. Archív obsahuje iba dostupné zdroje.");
  return { errors: [...new Set(errors)], warnings, totalBytes };
}
export async function createProjectZip(
  sources: readonly ProjectSource[],
  title: string,
  version?: number,
): Promise<ProjectZip> {
  // Capture inputs before the asynchronous module load. Never mutate or omit source files.
  const files = sources.map((file) => ({ name: file.name, content: file.content }));
  const { errors } = inspectProjectSources(files);
  if (errors.length) throw new Error(errors.join(" "));
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.content, { createFolders: false });
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const slug =
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "vorkei-projekt";
  return {
    bytes,
    filename: `${slug}${version ? "-v" + version : ""}.zip`,
    fileCount: files.length,
  };
}
/** User-triggered local download; no project data or credentials leave the browser. */
export function downloadProjectZip(archive: ProjectZip): void {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(archive.bytes)], { type: "application/zip" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = archive.filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
