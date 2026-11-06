import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DbLike } from '../db/pool';
import { githubPending } from './githubPending';

const connectionSchema = z.object({ token: z.string().min(1).max(4096), username: z.string().regex(/^[A-Za-z0-9-]{1,39}$/), id: z.number().int().positive() });
const tokenSchema = z.object({ access_token: z.string().min(1).max(4096), token_type: z.literal('bearer'), scope: z.string().max(2048), expires_in: z.number().int().positive().optional() });
const userSchema = z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/), id: z.number().int().positive() });
type Outcome = { ok: true } | { ok: false; error: 'invalid_flow' | 'github_unavailable' | 'github_permission_missing' | 'superseded' };

/** Server-only service. Not mounted until trusted BFF nonce + verified Cloud
 * owner wiring exists. Uses its own OAuth config; never changes legacy callback.
 * Caller supplies an encryption key from server secrets, not a client secret.
 */
export function githubCloud(db: DbLike, config: {
  clientId: string; clientSecret: string; callbackUrl: string;
  allowedOrigin: string; encryptionKey: string; fetch?: typeof fetch;
}) {
  const callback = new URL(config.callbackUrl);
  if (callback.protocol !== 'https:' || callback.origin !== config.allowedOrigin || callback.pathname !== '/github/callback' || callback.search || callback.hash || callback.username || callback.password ||
    !config.clientId || !config.clientSecret || !/^[a-f0-9]{64}$/i.test(config.encryptionKey)) throw new Error('invalid_github_cloud_configuration');
  const key = Buffer.from(config.encryptionKey, 'hex'), pending = githubPending(db);
  const encode = (owner: string, purpose: string, value: string) => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(owner + ':' + purpose));
    return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  };
  const decode = (owner: string, purpose: string, value: string) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 29 || bytes.length > 16384) throw new Error('invalid_cipher');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(owner + ':' + purpose));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  };
  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await (config.fetch ?? fetch)(url, { ...init, signal, redirect: 'error' });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('github_request_failed'); }
    const reader = response.body.getReader(); let size = 0; const chunks: Buffer[] = [];
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16384) throw new Error('github_response_too_large');
        chunks.push(Buffer.from(chunk.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => undefined); }
  }
  return {
    async start(ownerId: string, browserNonce: string) {
      const verifier = randomBytes(32).toString('base64url');
      const state = await pending.start(ownerId, browserNonce, encode(ownerId, 'pkce', verifier));
      const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback.href, scope: 'public_repo', state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', allow_signup: 'false' });
      return { authorizationUrl: 'https://github.com/login/oauth/authorize?' + params.toString() };
    },
    async finish(ownerId: string, state: string, browserNonce: string, code: string, signal?: AbortSignal): Promise<Outcome> {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(code)) return { ok: false, error: 'invalid_flow' };
      const claimed = await pending.claim(ownerId, state, browserNonce);
      if (!claimed?.verifier_cipher) return { ok: false, error: 'invalid_flow' };
      const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
      try {
        deadline.throwIfAborted();
        const verifier = decode(ownerId, 'pkce', claimed.verifier_cipher);
        const grant = tokenSchema.parse(await json('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: callback.href, code, code_verifier: verifier }) }, deadline));
        if (!grant.scope.split(/[\s,]+/).some(scope => scope === 'public_repo' || scope === 'repo')) return { ok: false, error: 'github_permission_missing' };
        const user = userSchema.parse(await json('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + grant.access_token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }, deadline));
        deadline.throwIfAborted();
        const cipher = encode(ownerId, 'connection', JSON.stringify({ token: grant.access_token, username: user.login, id: user.id }));
        const saved = await pending.publish(ownerId, state, cipher, new Date(Date.now() + Math.min(grant.expires_in ?? 86400, 86400) * 1000));
        return saved ? { ok: true } : { ok: false, error: 'superseded' };
      } catch { return { ok: false, error: 'github_unavailable' }; }
    },
    async status(ownerId: string) {
      const cipher = await pending.connection(ownerId);
      if (!cipher) return { connected: false } as const;
      // Authenticated ciphertext is bound to this owner and purpose.
      const data = connectionSchema.parse(JSON.parse(decode(ownerId, 'connection', cipher)));
      return { connected: true, username: data.username, githubId: data.id, scopes: ['public_repo'] } as const;
    },
    /** Server-only capability. HTTP handlers must never serialize credentials. */
    async exportAccess(ownerId: string) {
      const cipher = await pending.connection(ownerId);
      if (!cipher) return null;
      const data = connectionSchema.parse(JSON.parse(decode(ownerId, 'connection', cipher)));
      const assertAuthorized = async () => {
        if (await pending.connection(ownerId) !== cipher) throw new Error('github_connection_changed');
      };
      return { fingerprint: createHash('sha256').update(cipher).digest('hex'), username: data.username,
        run: async <T>(operation: (credentials: { token: string; githubId: number; username: string; assertAuthorized: () => Promise<void> }) => Promise<T>) => {
          await assertAuthorized();
          return operation({ token: data.token, githubId: data.id, username: data.username, assertAuthorized });
        } };
    },
    disconnect: pending.disconnect,
  };
}
