import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { makeGitHubBff } from '../integrations/githubBff';
import { verifyToken } from '../auth/tokens';
import { TOKEN_COOKIE } from '../auth/routes';

/* /api/github-connect/* — same-origin BFF bridge pre Cloud GitHub flow.
 *
 * Keď sú prítomné HONO_BASE_URL + GITHUB_CLOUD_CALLBACK_URL + GITHUB_CLOUD_CLIENT_ID
 * + GITHUB_BRIDGE_SECRET (+ voliteľné HONO_BASIC_AUTH), request sa prepošle cez
 * makeGitHubBff na Hono bridge (/api/cloud-github/*). Cookie relácia (lov_token)
 * sa pritom interne premapuje na Bearer token — klient nikdy nevidí JWT.
 *
 * Bez bridge konfigurácie nedávame 503 ani HTML 404: GET status vráti
 * 200 { connected:false, configured:false } a ostatné akcie JSON 404.
 * Frontend na základe toho prepne na lokálny /api/github/* konektor.
 */

export interface GitHubBridgeEnv {
  baseUrl: string;
  callbackUrl: string;
  clientId: string;
  bridgeSecret: string;
  basicAuth?: string;
}

export function readGitHubBridgeEnv(
  env: Record<string, string | undefined> = process.env
): GitHubBridgeEnv | undefined {
  const baseUrl = env.HONO_BASE_URL?.trim();
  const callbackUrl = env.GITHUB_CLOUD_CALLBACK_URL?.trim();
  const clientId = env.GITHUB_CLOUD_CLIENT_ID?.trim();
  const bridgeSecret = env.GITHUB_BRIDGE_SECRET?.trim();
  if (!baseUrl || !callbackUrl || !clientId || !bridgeSecret) return undefined;
  const basicAuth = env.HONO_BASIC_AUTH?.trim();
  return { baseUrl, callbackUrl, clientId, bridgeSecret, ...(basicAuth ? { basicAuth } : {}) };
}

const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;

export function githubConnectRouter(
  opts: {
    jwtSecret?: string;
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {}
) {
  const router = new Hono();
  const bridgeEnv = readGitHubBridgeEnv(opts.env);
  const jwtSecret = opts.jwtSecret;

  let bff: ((request: Request) => Promise<Response>) | undefined;
  if (bridgeEnv) {
    try {
      bff = makeGitHubBff({
        baseUrl: bridgeEnv.baseUrl,
        callbackUrl: bridgeEnv.callbackUrl,
        clientId: bridgeEnv.clientId,
        bridgeSecret: bridgeEnv.bridgeSecret,
        ...(bridgeEnv.basicAuth ? { basicAuth: bridgeEnv.basicAuth } : {}),
        fetch: opts.fetch ?? fetch,
        verifyToken: async (token) => {
          if (!jwtSecret) return false;
          return (await verifyToken(token, jwtSecret)) !== null;
        }
      });
    } catch {
      /* Neplatná bridge konfigurácia → tichý fallback, žiadny 503 pri štarte. */
      bff = undefined;
    }
  }

  const fallback = (c: Context) => {
    if (c.req.method === 'GET' && c.req.path === '/api/github-connect/status')
      return c.json({ connected: false, configured: false }, 200, SAFE_HEADERS);
    return c.json({ error: 'github_route_unavailable' }, 404, SAFE_HEADERS);
  };

  router.all('/api/github-connect/*', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (!bff || !bridgeEnv) return fallback(c);

    const req = c.req.raw;
    /* Za reverse proxy je viditeľná http URL — BFF kontroluje verejnú https origin,
       preto request prepiseme na origin z GITHUB_CLOUD_CALLBACK_URL. */
    const callbackOrigin = new URL(bridgeEnv.callbackUrl).origin;
    const incoming = new URL(req.url);
    const target = new URL(incoming.pathname + incoming.search, callbackOrigin);
    const headers = new Headers(req.headers);
    /* Cookie auth → Bearer pre BFF core (klient JWT nikdy nepozná). */
    if (!headers.has('Authorization') && jwtSecret) {
      const cookieToken = getCookie(c, TOKEN_COOKIE);
      if (cookieToken && (await verifyToken(cookieToken, jwtSecret)))
        headers.set('Authorization', `Bearer ${cookieToken}`);
    }
    const adapted = new Request(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      // @ts-expect-error Node stream duplex
      duplex: 'half',
      signal: req.signal
    });
    return bff(adapted);
  });

  return router;
}
