import { createHash, randomBytes } from "node:crypto";
import type { DbLike } from "../db/pool";
import { PublishError } from "./config";

/** Injected DNS lookup. Production wires a real resolver; tests use a fake. Never call the network from here. */
export type DnsLookup = (hostname: string) => Promise<{
  cname: string[];
  txt: string[];
}>;

export const RESERVED_SLUGS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "static",
  "assets",
  "cdn",
  "mail",
  "ftp",
  "localhost",
  "staging",
  "dev",
  "test",
  "status",
  "docs",
  "help",
  "support",
  "billing",
  "auth",
  "oauth",
  "login",
  "logout",
  "dashboard",
  "console",
  "internal",
  "private",
  "public",
  "live",
  "p",
  "s",
  "lov-devil",
  "lovdevil",
]);

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Strip combining marks after NFD so "ľúbosť" → "lubost". */
function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Deterministic DNS-label slug from a project title (or any seed).
 * a–z0–9-, max 63 chars, no leading/trailing hyphen. Empty → "project".
 */
export function normalizeSlug(seed: string): string {
  const base = stripDiacritics(seed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  if (!base) return "project";
  if (!DNS_LABEL.test(base)) {
    const trimmed = base.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 63);
    return trimmed && DNS_LABEL.test(trimmed) ? trimmed : "project";
  }
  return base;
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

export function isValidSlug(slug: string): boolean {
  return DNS_LABEL.test(slug) && slug.length <= 63 && !isReservedSlug(slug);
}

/** Append -2, -3, … while staying within 63 chars until `taken` returns false. */
export async function uniqueSlug(
  seed: string,
  taken: (candidate: string) => Promise<boolean>,
  maxAttempts = 100,
): Promise<string> {
  const root = normalizeSlug(seed);
  if (isReservedSlug(root)) {
    return uniqueSlug(root + "-site", taken, maxAttempts);
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const budget = 63 - suffix.length;
    const candidate =
      (root.length <= budget ? root : root.slice(0, budget).replace(/-+$/g, "")) +
      suffix;
    if (!isValidSlug(candidate)) continue;
    if (!(await taken(candidate))) return candidate;
  }
  throw new PublishError("publish_slug_exhausted", 409);
}

export type PublishHostBinding =
  | { kind: "slug"; slug: string; ownerId: string; projectId: string }
  | {
      kind: "domain";
      domain: string;
      ownerId: string;
      projectId: string;
      status: "pending_verification" | "verified";
    };

export function publishBaseDomain(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = (env.PUBLISH_BASE_DOMAIN ?? "lov-devil.app").trim().toLowerCase();
  if (!raw || raw.includes("/") || raw.includes(" ") || raw.startsWith(".")) {
    throw new PublishError("publish_configuration");
  }
  return raw;
}

/** Resolve Host header to an owned project binding. Unverified custom domains return the row but callers must not serve. */
export async function resolvePublishHost(
  db: DbLike,
  hostHeader: string,
  baseDomain = publishBaseDomain(),
): Promise<PublishHostBinding | null> {
  const host = hostHeader.split(":")[0]!.toLowerCase();
  if (!host) return null;
  if (host === baseDomain || host === `www.${baseDomain}`) return null;

  const suffix = `.${baseDomain}`;
  if (host.endsWith(suffix)) {
    const slug = host.slice(0, -suffix.length);
    if (!slug || slug.includes(".") || !isValidSlug(slug)) return null;
    const row = (
      await db.query(
        "SELECT owner_id, project_id, slug FROM publish_project_slugs WHERE slug=$1",
        [slug],
      )
    ).rows[0] as { owner_id: string; project_id: string; slug: string } | undefined;
    if (!row) return null;
    return {
      kind: "slug",
      slug: row.slug,
      ownerId: row.owner_id,
      projectId: row.project_id,
    };
  }

  const domain = (
    await db.query(
      "SELECT owner_id, project_id, domain, status FROM publish_custom_domains WHERE domain=$1",
      [host],
    )
  ).rows[0] as
    | {
        owner_id: string;
        project_id: string;
        domain: string;
        status: "pending_verification" | "verified";
      }
    | undefined;
  if (!domain) return null;
  return {
    kind: "domain",
    domain: domain.domain,
    ownerId: domain.owner_id,
    projectId: domain.project_id,
    status: domain.status,
  };
}

/** Artifact row for the project's current live address, or null. */
export async function liveArtifactForProject(
  db: DbLike,
  ownerId: string,
  projectId: string,
): Promise<{
  artifact_id: string;
  artifact_sha256: string;
  artifact_bytes: number;
} | null> {
  const row = (
    await db.query(
      `SELECT j.artifact_id, j.artifact_sha256, j.artifact_bytes
       FROM publish_live_addresses AS a
       JOIN builder_projects AS p USING (owner_id, project_id)
       JOIN publish_jobs AS j
         ON j.owner_id=a.owner_id AND j.project_id=a.project_id AND j.request_id=a.request_id
       WHERE a.owner_id=$1 AND a.project_id=$2
         AND p.deleted_at IS NULL AND j.state='published' AND j.withdrawn_at IS NULL`,
      [ownerId, projectId],
    )
  ).rows[0] as
    | {
        artifact_id: string;
        artifact_sha256: string;
        artifact_bytes: number;
      }
    | undefined;
  return row ?? null;
}

export function newVerificationToken(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 32);
}

/**
 * Verify a pending custom domain via the injected resolver.
 * Accepts either a CNAME to `<slug>.<baseDomain>` or a TXT record containing the token.
 */
export async function verifyCustomDomain(
  db: DbLike,
  ownerId: string,
  domain: string,
  lookup: DnsLookup,
  baseDomain = publishBaseDomain(),
): Promise<"pending_verification" | "verified"> {
  const row = (
    await db.query(
      `SELECT d.domain, d.status, d.verification_token, d.project_id, s.slug
       FROM publish_custom_domains AS d
       LEFT JOIN publish_project_slugs AS s
         ON s.owner_id=d.owner_id AND s.project_id=d.project_id
       WHERE d.owner_id=$1 AND d.domain=$2`,
      [ownerId, domain.toLowerCase()],
    )
  ).rows[0] as
    | {
        domain: string;
        status: "pending_verification" | "verified";
        verification_token: string;
        project_id: string;
        slug: string | null;
      }
    | undefined;
  if (!row) throw new PublishError("publish_domain_not_found", 404);
  if (row.status === "verified") return "verified";

  const records = await lookup(row.domain);
  const expectedCname = row.slug ? `${row.slug}.${baseDomain}` : null;
  const cnameOk =
    expectedCname !== null &&
    records.cname.some(
      (value) => value.replace(/\.$/, "").toLowerCase() === expectedCname,
    );
  const txtOk = records.txt.some((value) =>
    value.includes(`lov-devil-verify=${row.verification_token}`),
  );
  if (!cnameOk && !txtOk) return "pending_verification";

  await db.query(
    `UPDATE publish_custom_domains
     SET status='verified', verified_at=now()
     WHERE owner_id=$1 AND domain=$2 AND status='pending_verification'`,
    [ownerId, row.domain],
  );
  return "verified";
}

/** Cache-Control for a public publish path. Errors/non-public keep no-store elsewhere. */
export function publishCacheControl(pathname: string): string {
  const leaf = pathname.split("/").filter(Boolean).pop() ?? "";
  // content-hashed static asset: name.<hash>.ext or <hash>.ext (hash ≥ 8 hex)
  if (
    /^[a-z0-9._-]+\.[a-f0-9]{8,}\.[a-z0-9]+$/i.test(leaf) ||
    /^[a-f0-9]{8,}\.[a-z0-9]+$/i.test(leaf)
  ) {
    return "public, max-age=31536000, immutable";
  }
  if (
    leaf === "" ||
    /\.html?$/i.test(leaf) ||
    leaf === "index.html" ||
    // bare artifact / live / slug roots serve HTML
    /^[0-9a-f-]{36}$/i.test(leaf)
  ) {
    return "no-cache";
  }
  return "no-store";
}
