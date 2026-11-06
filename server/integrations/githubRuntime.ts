import { validateCloudIssuer } from '../auth/cloud';
import type { DbLike } from '../db/pool';
import { githubCloud } from './githubCloud';
import { githubExporter } from './githubExporter';
import { writeGitHubRepository } from './githubWriter';
import { verifyGitHubExport } from './githubRecovery';
import type { CloudGitHubWiring } from '../routes/githubCloud';

type Environment = Record<string, string | undefined>;
export interface CloudGitHubConfig {
  issuer: string; clientId: string; clientSecret: string; callbackUrl: string;
  allowedOrigin: string; encryptionKey: string; bridgeSecret: string; exportsEnabled: boolean;
}
export class CloudGitHubConfigurationError extends Error {
  constructor(public readonly fields: string[]) {
    super('Invalid Cloud GitHub configuration: ' + fields.join(', '));
    this.name = 'CloudGitHubConfigurationError';
  }
}

/** Pure configuration validation. No dotenv, DB, network or implicit activation.
 * Errors contain controlled field names only, never supplied values. */
export function readCloudGitHubConfig(env: Environment): CloudGitHubConfig | undefined {
  const invalid = new Set<string>();
  const flag = (name: string) => {
    if (![undefined, '', '0', '1'].includes(env[name])) invalid.add(name);
    return env[name] === '1';
  };
  const enabled = flag('GITHUB_CLOUD_ENABLED'), exportsEnabled = flag('GITHUB_CLOUD_EXPORT_ENABLED');
  const fail = () => { if (invalid.size) throw new CloudGitHubConfigurationError([...invalid].sort()); };
  if (!enabled) {
    if (exportsEnabled) invalid.add('GITHUB_CLOUD_ENABLED');
    fail(); return undefined;
  }
  if (env.AUTH_ENABLED !== '1') invalid.add('AUTH_ENABLED');
  // Existing public-deployment guard is deliberately not lifted by this feature.
  if (env.NODE_ENV === 'production') invalid.add('NODE_ENV');
  if (!env.DATABASE_URL) invalid.add('DATABASE_URL');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) invalid.add('JWT_SECRET');
  const issuer = env.CLOUD_AUTH_ISSUER ?? '';
  try { validateCloudIssuer(issuer); } catch { invalid.add('CLOUD_AUTH_ISSUER'); }
  const clientId = env.GITHUB_CLOUD_CLIENT_ID ?? '', clientSecret = env.GITHUB_CLOUD_CLIENT_SECRET ?? '';
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(clientId)) invalid.add('GITHUB_CLOUD_CLIENT_ID');
  if (clientSecret.length < 16 || clientSecret.length > 512 || /\s/.test(clientSecret) ||
    Array.from(clientSecret).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid.add('GITHUB_CLOUD_CLIENT_SECRET');
  const callbackUrl = env.GITHUB_CLOUD_CALLBACK_URL ?? '', allowedOrigin = env.GITHUB_CLOUD_ALLOWED_ORIGIN ?? '';
  try {
    const url = new URL(allowedOrigin);
    if (url.protocol !== 'https:' || url.origin !== allowedOrigin) invalid.add('GITHUB_CLOUD_ALLOWED_ORIGIN');
  } catch { invalid.add('GITHUB_CLOUD_ALLOWED_ORIGIN'); }
  try {
    const url = new URL(callbackUrl);
    if (url.protocol !== 'https:' || url.href !== callbackUrl || url.pathname !== '/github/callback' || url.search || url.hash || url.username || url.password || url.origin !== allowedOrigin)
      invalid.add('GITHUB_CLOUD_CALLBACK_URL');
  } catch { invalid.add('GITHUB_CLOUD_CALLBACK_URL'); }
  const encryptionKey = env.GITHUB_CLOUD_ENCRYPTION_KEY ?? '', bridgeSecret = env.GITHUB_BRIDGE_SECRET ?? '';
  for (const [name, value] of [['GITHUB_CLOUD_ENCRYPTION_KEY', encryptionKey], ['GITHUB_BRIDGE_SECRET', bridgeSecret]]) {
    if (!/^[a-f0-9]{64}$/i.test(value)) invalid.add(name);
    if (value && [env.JWT_SECRET, env.GITHUB_SESSION_SECRET, env.SANDBOX_RUNNER_TOKEN, clientSecret].some(other => other && value.toLowerCase() === other.toLowerCase())) invalid.add(name);
  }
  if (encryptionKey && encryptionKey.toLowerCase() === bridgeSecret.toLowerCase()) {
    invalid.add('GITHUB_CLOUD_ENCRYPTION_KEY'); invalid.add('GITHUB_BRIDGE_SECRET');
  }
  fail();
  return { issuer, clientId, clientSecret, callbackUrl, allowedOrigin, encryptionKey, bridgeSecret, exportsEnabled };
}

/** No service action or provider request occurs until a verified HTTP action.
 * The optional transport is for deterministic local tests only. */
export function makeCloudGitHubWiring(db: DbLike, config: CloudGitHubConfig | undefined, transport?: typeof fetch): CloudGitHubWiring | undefined {
  if (!config) return undefined;
  const service = githubCloud(db, { ...config, ...(transport ? { fetch: transport } : {}) });
  return { service, bridgeSecret: config.bridgeSecret,
    ...(config.exportsEnabled ? { exporter: githubExporter(db, service,
      args => writeGitHubRepository({ ...args, ...(transport ? { fetch: transport } : {}) }),
      args => verifyGitHubExport({ ...args, ...(transport ? { fetch: transport } : {}) })) } : {}) };
}
