import path from "node:path";
export class PublishError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503 = 503,
  ) {
    super(code);
  }
}
export interface PublishConfig {
  baseUrl: string;
  appUrl: string;
  artifactDir: string;
  bind: string;
  port: number;
  maxArtifacts: number;
  maxOwnerBytes: number;
  maxArtifactBytes: number;
  allowHostTest?: boolean;
  minFreeBytes?: number;
}
export function validatePublishConfig(c: PublishConfig) {
  const base = new URL(c.baseUrl),
    app = new URL(c.appUrl);
  const loopback = (url: URL) =>
    c.allowHostTest === true &&
    process.env.NODE_ENV === "test" &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.protocol === "http:";
  for (const url of [base, app])
    if (
      (url.protocol !== "https:" && !loopback(url)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.href !== (url === base ? c.baseUrl : c.appUrl)
    )
      throw new PublishError("publish_configuration");
  if (base.origin === app.origin || base.hostname === app.hostname)
    throw new PublishError("publish_origin_isolation");
  const root = path.resolve(c.artifactDir),
    repo = path.resolve(process.cwd());
  if (
    !path.isAbsolute(c.artifactDir) ||
    root === path.parse(root).root ||
    root === repo ||
    root.startsWith(repo + path.sep)
  )
    throw new PublishError("publish_artifact_directory");
  if (
    !Number.isSafeInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    !["127.0.0.1", "0.0.0.0", "::1"].includes(c.bind)
  )
    throw new PublishError("publish_configuration");
  if (
    c.minFreeBytes !== undefined &&
    (!Number.isSafeInteger(c.minFreeBytes) || c.minFreeBytes < 0)
  )
    throw new PublishError("publish_configuration");
  if (
    !Number.isSafeInteger(c.maxArtifacts) ||
    c.maxArtifacts < 1 ||
    c.maxArtifacts > 100 ||
    !Number.isSafeInteger(c.maxArtifactBytes) ||
    c.maxArtifactBytes < 1 ||
    c.maxArtifactBytes > 3000000 ||
    !Number.isSafeInteger(c.maxOwnerBytes) ||
    c.maxOwnerBytes < c.maxArtifactBytes ||
    c.maxOwnerBytes > 300000000
  )
    throw new PublishError("publish_configuration");
}
export function readPublishConfig(
  env: Record<string, string | undefined>,
): PublishConfig | null {
  if (
    env.PUBLICPUBLISH_ENABLED !== undefined &&
    !["0", "1"].includes(env.PUBLICPUBLISH_ENABLED)
  )
    throw new PublishError("publish_configuration");
  if (env.PUBLICPUBLISH_ENABLED !== "1") return null;
  if (env.AUTH_ENABLED !== "1") throw new PublishError("publish_requires_auth");
  const config: PublishConfig = {
    baseUrl: env.PUBLICPUBLISH_BASE_URL ?? "",
    appUrl: env.PUBLICPUBLISH_APP_URL ?? "",
    artifactDir: env.PUBLICPUBLISH_ARTIFACT_DIR ?? "",
    bind: env.PUBLICPUBLISH_BIND ?? "127.0.0.1",
    port: Number(env.PUBLICPUBLISH_PORT ?? 8791),
    maxArtifacts: 20,
    maxOwnerBytes: 30000000,
    maxArtifactBytes: 3000000,
    allowHostTest: env.NODE_ENV === "test",
    minFreeBytes:
      env.PUBLICPUBLISH_MIN_FREE_BYTES === undefined
        ? 1073741824
        : /^(0|[1-9][0-9]*)$/.test(env.PUBLICPUBLISH_MIN_FREE_BYTES)
          ? Number(env.PUBLICPUBLISH_MIN_FREE_BYTES)
          : NaN,
  };
  validatePublishConfig(config);
  return config;
}
