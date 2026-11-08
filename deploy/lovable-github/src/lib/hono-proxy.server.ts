// Server-only Hono proxy core. Pure logic with injected deps so it can be unit-tested.
// Never import from client code (the .server.ts suffix enforces this).
import "@tanstack/react-start/server-only";

export const MAX_REQUEST_BYTES = 8_000_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ID = "[A-Za-z0-9_-]{1,128}";
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type Kind = "crud" | "build" | "ai" | "billing" | "publish" | "closure";
const TIMEOUTS: Record<Kind, number> = {
  crud: 20_000,
  build: 35_000,
  ai: 130_000,
  billing: 60_000,
  publish: 20_000,
  closure: 20_000,
};

/** Bound account and billing mutations below the general project upload limit. */
function requestBudget(kind: Kind) {
  return kind === "closure"
    ? 512
    : kind === "billing"
      ? 8192
      : kind === "publish"
        ? 4096
        : MAX_REQUEST_BYTES;
}

interface RouteDef {
  method: "GET" | "POST";
  re: RegExp;
  upstream: (m: RegExpMatchArray) => string;
  kind: Kind;
  sse?: boolean;
  listing?: boolean;
}

const ROUTES: RouteDef[] = [
  { method: "GET", re: /^publish$/, upstream: () => "/api/publish", kind: "publish" },
  { method: "POST", re: /^publish$/, upstream: () => "/api/publish", kind: "publish" },
  {
    method: "POST",
    re: /^publish\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/withdraw$/i,
    upstream: (m) => `/api/publish/${m[1]}/withdraw`,
    kind: "publish",
  },
  {
    method: "GET",
    re: /^publish\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
    upstream: (m) => `/api/publish/${m[1]}`,
    kind: "publish",
  },
{
    method: "POST",
    re: /^publish\/project\/([A-Za-z0-9_-]{1,128})\/live$/,
    upstream: (m) => `/api/publish/project/${m[1]}/live`,
    kind: "publish",
  },
  {
    method: "GET",
    re: /^publish\/project\/([A-Za-z0-9_-]{1,128})\/(latest|releases|live)$/,
    upstream: (m) => `/api/publish/project/${m[1]}/${m[2]}`,
    kind: "publish",
  },
  {
    method: "GET",
    re: /^publish\/project\/([A-Za-z0-9_-]{1,128})\/([1-9][0-9]{0,9})\/([A-Za-z0-9_-]{1,128})$/,
    upstream: (m) => `/api/publish/project/${m[1]}/${m[2]}/${m[3]}`,
    kind: "publish",
  },
  { method: "GET", re: /^billing$/, upstream: () => "/api/billing", kind: "billing" },
  {
    method: "POST",
    re: /^billing\/checkout$/,
    upstream: () => "/api/billing/checkout",
    kind: "billing",
  },
  {
    method: "POST",
    re: /^billing\/portal$/,
    upstream: () => "/api/billing/portal",
    kind: "billing",
  },
  { method: "GET", re: /^ai-models$/, upstream: () => "/api/ai-models", kind: "crud" },
  { method: "GET", re: /^ai-usage$/, upstream: () => "/api/ai-usage", kind: "crud" },
  {
    method: "GET",
    re: /^account\/export\/(profile|(?:projects|auth|ai|publish|github|billing|closure)(?:\/[A-Za-z0-9_-]{1,512})?)$/,
    upstream: (m) => `/api/account/export/${m[1]}`,
    kind: "crud",
  },
  {
    method: "GET",
    re: /^account\/closure$/,
    upstream: () => "/api/account/closure",
    kind: "closure",
  },
  {
    method: "POST",
    re: /^account\/closure$/,
    upstream: () => "/api/account/closure",
    kind: "closure",
  },
  {
    method: "POST",
    re: /^account\/closure\/cancel$/,
    upstream: () => "/api/account/closure/cancel",
    kind: "closure",
  },
  { method: "GET", re: /^project-storage$/, upstream: () => "/api/project-storage", kind: "crud" },
  { method: "GET", re: /^auth\/me$/, upstream: () => "/api/auth/me", kind: "crud" },
  { method: "GET", re: /^projects$/, upstream: () => "/api/projects", kind: "crud", listing: true },
  {
    method: "GET",
    re: new RegExp(`^projects\\/(${ID})$`),
    upstream: (m) => `/api/projects/${m[1]}`,
    kind: "crud",
  },
  {
    method: "POST",
    re: new RegExp(`^projects\\/(${ID})$`),
    upstream: (m) => `/api/projects/${m[1]}`,
    kind: "crud",
  },
  {
    method: "POST",
    re: new RegExp(`^projects\\/(${ID})\\/delete$`),
    upstream: (m) => `/api/projects/${m[1]}/delete`,
    kind: "crud",
  },
  {
    method: "POST",
    re: new RegExp(`^projects\\/(${ID})\\/restore$`),
    upstream: (m) => `/api/projects/${m[1]}/restore`,
    kind: "crud",
  },
  { method: "GET", re: /^sandbox\/ready$/, upstream: () => "/api/sandbox/ready", kind: "crud" },
  { method: "POST", re: /^sandbox\/build$/, upstream: () => "/api/sandbox/build", kind: "build" },
  { method: "POST", re: /^sandbox\/autofix$/, upstream: () => "/api/sandbox/autofix", kind: "ai" },
  {
    method: "POST",
    re: /^agent\/generate$/,
    upstream: () => "/api/agent/generate",
    kind: "ai",
    sse: true,
  },
];

export interface ProxyDeps {
  baseUrl: string | undefined;
  /** Validates the user's access token (e.g. supabase.auth.getUser). Returns true only for a real user. */
  verifyToken: (token: string, signal: AbortSignal) => Promise<boolean>;
  fetch: typeof fetch;
  /**
   * Optional HONO_BASIC_AUTH ("username:password") for the existing Nginx auth_basic.
   * When set: Authorization: Basic <b64>, and the verified user token goes in X-LOV-Cloud-Authorization.
   */
  basicAuth?: string | undefined;
}

export const CLOUD_AUTH_HEADER = "x-lov-cloud-authorization";

/** Returns base64 of a valid "user:pass" (UTF-8), null when unset, or "invalid". */
export function encodeBasic(raw: string | undefined): string | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  const i = raw.indexOf(":");
  if (
    i < 1 ||
    i === raw.length - 1 ||
    raw.length > 4096 ||
    Array.from(raw).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return "invalid";
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const SAFE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...SAFE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

class ProxyError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export interface Match {
  def: RouteDef;
  upstreamPath: string;
  query: string;
}

/** Resolve path + query against the allowlist. Returns a Response for rejections. */
export function matchRoute(
  method: string,
  splat: string,
  search: URLSearchParams,
): Match | Response {
  if (/%|\.\.|\/\/|\\/.test(splat) || splat.startsWith("/") || splat.endsWith("/")) {
    return jsonError(404, "not_found");
  }
  const candidates = ROUTES.map((d) => ({ d, m: splat.match(d.re) })).filter((x) => x.m);
  if (candidates.length === 0) return jsonError(404, "not_found");
  const hit = candidates.find((x) => x.d.method === method);
  if (!hit) return jsonError(405, "method_not_allowed");
  const { d, m } = hit;

  const keys = [...search.keys()];
  let query = "";
  if (!d.listing) {
    if (keys.length > 0) return jsonError(400, "unknown_query");
  } else {
    const seen = new Set<string>();
    const out = new URLSearchParams();
    for (const k of keys) {
      if (seen.has(k)) return jsonError(400, "duplicate_query");
      seen.add(k);
      const v = search.get(k) ?? "";
      if (k === "deleted") {
        if (v !== "0" && v !== "1") return jsonError(400, "invalid_query");
      } else if (k === "cursor") {
        if (!ID_RE.test(v)) return jsonError(400, "invalid_query");
      } else return jsonError(400, "unknown_query");
      out.set(k, v);
    }
    query = out.toString();
  }
  return { def: d, upstreamPath: d.upstream(m!), query };
}

async function readLimited(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = MAX_REQUEST_BYTES,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    if (signal.aborted) throw new ProxyError(504, "timeout");
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new ProxyError(504, "timeout");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new ProxyError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function withDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      void p.catch(() => {});
      return reject(new ProxyError(504, "timeout"));
    }
    const onAbort = () => reject(new ProxyError(504, "timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Forward allowlisted requests after verifying the Cloud token and applying route limits. */
export async function handleHonoProxy(
  request: Request,
  splat: string,
  deps: ProxyDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const matched = matchRoute(request.method, splat, url.searchParams);
  if (matched instanceof Response) return matched;
  const { def, upstreamPath, query } = matched;

  const base = deps.baseUrl?.trim();
  if (!base) return jsonError(503, "hono_not_configured");
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return jsonError(503, "hono_not_configured");
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== "/"
  ) {
    return jsonError(503, "hono_not_configured");
  }

  const basic = encodeBasic(deps.basicAuth);
  if (basic === "invalid") return jsonError(503, "hono_basic_auth_invalid");

  if (def.method === "POST") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")
      return jsonError(403, "forbidden_origin");
    const ct = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") return jsonError(415, "unsupported_media_type");
    const cl = request.headers.get("content-length");
    if (cl !== null && !/^\d+$/.test(cl)) return jsonError(400, "invalid_content_length");
    if (cl && Number(cl) > requestBudget(def.kind)) return jsonError(413, "payload_too_large");
  }

  const auth = request.headers.get("authorization") ?? "";
  const tm = auth.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/);
  if (!tm) return jsonError(401, "unauthorized");
  const token = tm[1]!;

  // One overall deadline covering verification, body read, upstream and stream.
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Deadline exceeded", "TimeoutError")),
    TIMEOUTS[def.kind],
  );
  const onClientAbort = () => ctrl.abort(new DOMException("Client disconnected", "AbortError"));
  request.signal?.addEventListener("abort", onClientAbort);
  if (request.signal.aborted) onClientAbort();
  let streaming = false;
  const cleanup = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onClientAbort);
  };

  try {
    let ok = false;
    try {
      ok = await withDeadline(deps.verifyToken(token, ctrl.signal), ctrl.signal);
    } catch (e) {
      if (e instanceof ProxyError) throw e;
      throw new ProxyError(503, "auth_unavailable");
    }
    if (!ok) throw new ProxyError(401, "unauthorized");

    let body: Uint8Array | undefined;
    if (def.method === "POST") {
      body = request.body
        ? await readLimited(request.body, ctrl.signal, requestBudget(def.kind))
        : new Uint8Array();
    }

    // Headers are built only from the verified token and server config; nothing from the browser
    // (Authorization, Cookie, X-LOV-Cloud-Authorization, ...) is copied.
    const headers = new Headers();
    if (basic) {
      headers.set("authorization", `Basic ${basic}`);
      headers.set(CLOUD_AUTH_HEADER, `Bearer ${token}`);
    } else {
      headers.set("authorization", `Bearer ${token}`);
    }
    headers.set("accept", def.sse ? "text/event-stream, application/json" : "application/json");
    if (body) headers.set("content-type", "application/json");
    const rid = request.headers.get("x-request-id");
    if (rid && /^[A-Za-z0-9._-]{1,128}$/.test(rid)) headers.set("x-request-id", rid);

    const target = new URL(upstreamPath, baseUrl);
    target.search = query;

    let up: Response;
    try {
      up = await withDeadline(
        deps.fetch(target.toString(), {
          method: def.method,
          headers,
          body: (body ?? null) as BodyInit | null,
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: ctrl.signal,
        }),
        ctrl.signal,
      );
    } catch {
      if (ctrl.signal.aborted) throw new ProxyError(504, "timeout");
      throw new ProxyError(502, "upstream_unreachable");
    }

    if ((up.status >= 300 && up.status < 400) || up.type === "opaqueredirect") {
      up.body?.cancel().catch(() => {});
      throw new ProxyError(502, "upstream_redirect");
    }
    const ct = (up.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const isJson = ct === "application/json";
    const isSse = def.sse && ct === "text/event-stream";
    if (!isJson && !isSse) {
      const basic = up.status === 401 && /^basic/i.test(up.headers.get("www-authenticate") ?? "");
      up.body?.cancel().catch(() => {});
      throw new ProxyError(502, basic ? "upstream_basic_auth" : "upstream_bad_content_type");
    }
    const len = up.headers.get("content-length");
    if (len && Number(len) > MAX_RESPONSE_BYTES) {
      up.body?.cancel().catch(() => {});
      throw new ProxyError(502, "upstream_too_large");
    }

    const outHeaders = new Headers({
      ...SAFE_HEADERS,
      "content-type": isSse
        ? "text/event-stream; charset=utf-8"
        : "application/json; charset=utf-8",
    });
    const retryAfter = up.headers.get("retry-after");
    if (retryAfter) outHeaders.set("retry-after", retryAfter);
    const publishStage = up.headers.get("x-lov-publish-stage");
    if (
      up.ok &&
      def.method === "GET" &&
      /^\/api\/publish\/[0-9a-f-]{36}$/i.test(upstreamPath) &&
      (publishStage === "compiling" || publishStage === "writing")
    )
      outHeaders.set("x-lov-publish-stage", publishStage);
    if (isSse) outHeaders.set("x-accel-buffering", "no");
    if (!up.body) {
      cleanup();
      return new Response(null, { status: up.status, headers: outHeaders });
    }

    const reader = up.body.getReader();
    let total = 0,
      ended = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      ended = true;
      cleanup();
      ctrl.signal.removeEventListener("abort", abortStream);
    };
    const abortStream = () => {
      if (ended) return;
      finish();
      void reader.cancel().catch(() => {});
      output.error(ctrl.signal.reason);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        output = c;
        ctrl.signal.addEventListener("abort", abortStream, { once: true });
        if (ctrl.signal.aborted) abortStream();
      },
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (ended) return;
          if (done) {
            finish();
            c.close();
            return;
          }
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            ctrl.abort(new Error("response_too_large"));
            return;
          }
          c.enqueue(value);
        } catch {
          if (!ended) {
            finish();
            ctrl.abort();
            c.error(new Error("upstream_stream_failed"));
          }
        }
      },
      cancel() {
        if (!ended) {
          finish();
          ctrl.abort();
          void reader.cancel().catch(() => {});
        }
      },
    });
    streaming = true;
    return new Response(stream, { status: up.status, headers: outHeaders });
  } catch (e) {
    if (e instanceof ProxyError) return jsonError(e.status, e.code);
    return jsonError(502, "proxy_error");
  } finally {
    if (!streaming) cleanup();
  }
}
