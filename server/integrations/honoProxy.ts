import { isCloudApiQuery, isCloudApiRoute } from '../../shared/honoBridge';

// Web APIs only: reusable in a TanStack Start/Workers server route. Never import
// this module into browser code. The caller supplies official server-side auth.
export interface HonoProxyOptions {
  baseUrl: string;
  /** Optional existing pilot transport credential, server-only username:password. */
  basicAuth?: string;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ accessToken: string } | null>;
  fetch?: typeof fetch;
}
const MAX_BODY = 8_000_000;
const MAX_RESPONSE = 16_000_000;
const PREFIX = '/api/hono/';

class ProxyFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function jsonError(code: string, status: number): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedBody(request: Request, signal: AbortSignal, limit = MAX_BODY): Promise<Uint8Array> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new ProxyFailure('invalid_content_length', 400);
    if (Number(contentLength) > limit) throw new ProxyFailure('request_too_large', 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0, done = false;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) { done = true; break; }
      bytes += result.value.byteLength;
      if (bytes > limit) throw new ProxyFailure('request_too_large', 413);
      chunks.push(result.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Browser URL /api/hono/projects maps only to the fixed upstream /api/projects. */
export function makeHonoProxy(options: HonoProxyOptions): (request: Request) => Promise<Response> {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('HONO_BASE_URL must be an HTTPS origin without credentials, path or query.');
  }
  if (options.basicAuth !== undefined && (options.basicAuth.length > 4096 || !/^[\x21-\x39\x3b-\x7e]+:[\x20-\x7e]+$/.test(options.basicAuth))) {
    throw new Error('HONO_BASIC_AUTH must contain server-only ASCII username:password.');
  }
  const upstreamFetch = options.fetch ?? fetch;
  return async request => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return jsonError('route_not_allowed', 404);
    const path = '/api/' + url.pathname.slice(PREFIX.length);
    if (!isCloudApiRoute(request.method, path) || !isCloudApiQuery(request.method, path, url.searchParams)) {
      return jsonError('route_not_allowed', 404);
    }
    if (request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return jsonError('origin_not_allowed', 403);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) return jsonError('json_required', 415);
    }

    const billing = path === '/api/billing' || path === '/api/billing/checkout' || path === '/api/billing/portal';
    const publishing = path === '/api/publish' || path.startsWith('/api/publish/');
    const closure = path === '/api/account/closure' || path === '/api/account/closure/cancel';
    const timeoutMs = path === '/api/agent/generate' || path === '/api/sandbox/autofix' ? 130_000 : path === '/api/sandbox/build' ? 35_000 : billing ? 60_000 : 20_000;
    const controller = new AbortController();
    const onClientAbort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
    request.signal.addEventListener('abort', onClientAbort, { once: true });
    if (request.signal.aborted) onClientAbort();
    const timer = setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onClientAbort);
    };
    let upstream: Response | undefined;
    let streaming = false;
    try {
      let session: { accessToken: string } | null;
      try { session = await abortable(options.authenticate(request, controller.signal), controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ProxyFailure('cloud_auth_unavailable', 503);
      }
      if (!session) return jsonError('unauthenticated', 401);
      if (!session.accessToken || session.accessToken.length > 16_384 || !/^[A-Za-z0-9_.-]+$/.test(session.accessToken)) return jsonError('cloud_auth_unavailable', 503);
      const bodyLimit = closure ? 512 : billing ? 8192 : publishing ? 4096 : MAX_BODY;
      const body = request.method === 'POST' ? await boundedBody(request, controller.signal, bodyLimit) : undefined;
      const headers = new Headers({ Authorization: 'Bearer ' + session.accessToken, Accept: path === '/api/agent/generate' ? 'text/event-stream' : 'application/json' });
      if (options.basicAuth !== undefined) {
        headers.set('Authorization', 'Basic ' + btoa(options.basicAuth));
        headers.set('X-LOV-Cloud-Authorization', 'Bearer ' + session.accessToken);
      }
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      upstream = await abortable(upstreamFetch(base.origin + path + url.search, {
        method: request.method, headers, ...(body === undefined ? {} : { body }),
        signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
      }), controller.signal);
      if (upstream.status >= 300 && upstream.status < 400) throw new ProxyFailure('upstream_redirect', 502);
      const type = upstream.headers.get('Content-Type') ?? '';
      const sse = path === '/api/agent/generate' && upstream.ok && /^text\/event-stream(?:\s*;|$)/i.test(type);
      if (!sse && !/^application\/json(?:\s*;|$)/i.test(type)) throw new ProxyFailure('upstream_protocol', 502);
      const responseHeaders = new Headers({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const retry = upstream.headers.get('Retry-After');
      if (retry) responseHeaders.set('Retry-After', retry);
      if (sse) responseHeaders.set('X-Accel-Buffering', 'no');
      if (!upstream.body) return new Response(null, { status: upstream.status, headers: responseHeaders });
      const reader = upstream.body.getReader();
      let ended = false, bytes = 0;
      const finish = () => { ended = true; cleanup(); controller.signal.removeEventListener('abort', abortStream); };
      let output: ReadableStreamDefaultController<Uint8Array>;
      const abortStream = () => {
        if (ended) return;
        finish();
        void reader.cancel().catch(() => {});
        output.error(controller.signal.reason);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(target) {
          output = target;
          controller.signal.addEventListener('abort', abortStream, { once: true });
          if (controller.signal.aborted) abortStream();
        },
        async pull(target) {
          try {
            const result = await reader.read();
            if (ended) return;
            if (result.done) { finish(); target.close(); return; }
            bytes += result.value.byteLength;
            if (bytes > MAX_RESPONSE) { controller.abort(new DOMException('Response limit exceeded', 'AbortError')); return; }
            target.enqueue(result.value);
          } catch {
            if (!ended) { finish(); controller.abort(); target.error(new Error('upstream_stream_failed')); }
          }
        },
        cancel() {
          if (!ended) { finish(); controller.abort(); void reader.cancel().catch(() => {}); }
        },
      });
      streaming = true;
      return new Response(stream, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      if (upstream?.body) void upstream.body.cancel().catch(() => {});
      if (controller.signal.aborted) return jsonError(request.signal.aborted ? 'request_cancelled' : 'upstream_timeout', request.signal.aborted ? 499 : 504);
      if (error instanceof ProxyFailure) return jsonError(error.code, error.status);
      return jsonError('upstream_unavailable', 502);
    } finally {
      if (!streaming) cleanup();
    }
  };
}
