import "@tanstack/react-start/server-only";
import { z } from "zod";
import {
  PrepareGitHubExport,
  ConfirmGitHubExport,
  CancelGitHubExport,
  ReadGitHubExport,
  GitHubExportJob,
  GitHubExportReview,
  GitHubExportError,
} from "./github-export-protocol";
// Standalone BFF core: no Hono or JOSE runtime dependency in the UI server.
const CLOUD_AUTH_HEADER = "X-LOV-Cloud-Authorization";
const GITHUB_BRIDGE_HEADER = "X-LOV-GitHub-Bridge";
const bearerToken = (header: string | undefined) =>
  header?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1] ?? null;

const COOKIE = "__Host-lov-github-nonce";
const ROOT = "/api/github-connect/";
const finish = z
  .object({
    state: z.string().regex(/^[a-f0-9]{64}$/),
    code: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
  })
  .strict();
const status = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    username: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
    githubId: z.number().int().positive(),
    scopes: z.tuple([z.literal("public_repo")]),
  }),
]);
const safeHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const reply = (body: unknown, code = 200) =>
  Response.json(body, { status: code, headers: safeHeaders });

/** Server-only same-origin BFF core; not wired into the hosted Lovable project.
 * Its route must run on HTTPS. Never accept browser nonce/owner/bridge headers
 * from the caller. verifyToken must validate the token with the auth service.
 */
export function makeGitHubBff(deps: {
  baseUrl: string;
  callbackUrl: string;
  clientId: string;
  bridgeSecret: string;
  basicAuth?: string;
  verifyToken: (token: string, signal: AbortSignal) => Promise<boolean>;
  fetch: typeof fetch;
}) {
  const base = new URL(deps.baseUrl),
    callback = new URL(deps.callbackUrl);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password ||
    callback.protocol !== "https:" ||
    callback.pathname !== "/github/callback" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password ||
    !/^[a-f0-9]{64}$/i.test(deps.bridgeSecret) ||
    !deps.clientId
  )
    throw new Error("invalid_github_bff_configuration");
  if (deps.basicAuth !== undefined) {
    const separator = deps.basicAuth.indexOf(":");
    if (
      separator < 1 ||
      separator === deps.basicAuth.length - 1 ||
      deps.basicAuth.length > 4096 ||
      /\s/.test(deps.basicAuth.slice(0, separator)) ||
      Array.from(deps.basicAuth).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error("invalid_github_bff_transport");
  }

  async function readJson(
    body: ReadableStream<Uint8Array> | null,
    max: number,
    signal: AbortSignal,
  ) {
    if (!body) throw new Error("invalid_body");
    const reader = body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > max) throw new Error("body_too_large");
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } finally {
      signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => undefined);
    }
  }
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      action = url.pathname.slice(ROOT.length);
    if (
      url.protocol !== "https:" ||
      url.origin !== callback.origin ||
      !url.pathname.startsWith(ROOT) ||
      url.search ||
      ![
        "start",
        "finish",
        "status",
        "disconnect",
        "export/prepare",
        "export/confirm",
        "export/status",
        "export/review",
        "export/cancel",
        "export/reconcile",
      ].includes(action) ||
      request.method !== (action === "status" ? "GET" : "POST")
    )
      return reply({ error: "github_route_unavailable" }, 404);
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) ||
      (request.method === "POST" && request.headers.get("Origin") !== url.origin)
    )
      return reply({ error: "origin_not_allowed" }, 403);
    if (
      request.method === "POST" &&
      request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
    )
      return reply({ error: "json_required" }, 415);
    const token = bearerToken(request.headers.get("Authorization") ?? undefined);
    if (!token) return reply({ error: "cloud_identity_required" }, 401);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(
        action === "export/confirm" ? 75_000 : action === "export/reconcile" ? 35_000 : 15_000,
      ),
    ]);
    let nonce: string | undefined;
    try {
      // The deadline also covers providers that don't themselves honor AbortSignal.
      let rejectVerification: () => void = () => undefined;
      let verified: boolean;
      try {
        verified = await Promise.race([
          deps.verifyToken(token, signal),
          new Promise<never>((_, reject) => {
            rejectVerification = () => reject(new Error("deadline"));
            signal.addEventListener("abort", rejectVerification, { once: true });
            if (signal.aborted) rejectVerification();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", rejectVerification);
      }
      if (!verified) return reply({ error: "cloud_identity_required" }, 401);
      let body: unknown;
      if (request.method === "POST") {
        const input = await readJson(request.body, 2048, signal);
        if (action.startsWith("export/")) {
          const schema =
            action === "export/prepare"
              ? PrepareGitHubExport
              : action === "export/confirm"
                ? ConfirmGitHubExport
                : action === "export/cancel"
                  ? CancelGitHubExport
                  : ReadGitHubExport;
          const parsed = schema.safeParse(input);
          if (!parsed.success) return reply({ error: "invalid_export_request" }, 400);
          body = parsed.data;
        } else if (action === "finish") {
          const parsed = finish.safeParse(input);
          if (!parsed.success) return reply({ error: "invalid_github_request" }, 400);
          const values = (request.headers.get("Cookie") ?? "")
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part.startsWith(COOKIE + "="));
          nonce = values.length === 1 ? values[0]?.slice(COOKIE.length + 1) : undefined;
          if (!nonce || !/^[a-f0-9]{64}$/.test(nonce))
            return reply({ error: "github_nonce_required" }, 409);
          body = { ...parsed.data, browserNonce: nonce };
        } else {
          if (!z.object({}).strict().safeParse(input).success)
            return reply({ error: "invalid_github_request" }, 400);
          if (action === "start") {
            nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
              n.toString(16).padStart(2, "0"),
            ).join("");
            body = { browserNonce: nonce };
          } else body = {};
        }
      }
      const headers: Record<string, string> = {
        Authorization: "Bearer " + token,
        [GITHUB_BRIDGE_HEADER]: deps.bridgeSecret,
        Accept: "application/json",
      };
      if (deps.basicAuth) {
        const bytes = new TextEncoder().encode(deps.basicAuth);
        headers["Authorization"] =
          "Basic " + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
        headers[CLOUD_AUTH_HEADER] = "Bearer " + token;
      }
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const upstream = await deps.fetch(new URL("/api/cloud-github/" + action, base), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      });
      if (!upstream.ok) {
        let error = "github_connection_failed";
        if (action.startsWith("export/")) {
          const parsed = z
            .object({ error: GitHubExportError })
            .safeParse(await readJson(upstream.body, 16384, signal));
          if (parsed.success) error = parsed.data.error;
        } else void upstream.body?.cancel().catch(() => undefined);
        return reply(
          { error },
          [400, 401, 403, 404, 409, 410, 413, 422, 429, 502, 503].includes(upstream.status)
            ? upstream.status
            : 502,
        );
      }
      const isReview = action === "export/prepare" || action === "export/review";
      const data = await readJson(upstream.body, isReview ? 65536 : 16384, signal);
      let result: Response;
      if (action.startsWith("export/"))
        result = reply(isReview ? GitHubExportReview.parse(data) : GitHubExportJob.parse(data));
      else if (action === "status") result = reply(status.parse(data));
      else if (action === "start") {
        const value = z.object({ authorizationUrl: z.string() }).parse(data);
        const auth = new URL(value.authorizationUrl);
        if (
          auth.origin !== "https://github.com" ||
          auth.pathname !== "/login/oauth/authorize" ||
          auth.username ||
          auth.password ||
          auth.hash ||
          auth.searchParams.get("client_id") !== deps.clientId ||
          auth.searchParams.get("redirect_uri") !== callback.href ||
          auth.searchParams.get("scope") !== "public_repo" ||
          !/^[a-f0-9]{64}$/.test(auth.searchParams.get("state") ?? "")
        )
          throw new Error("invalid_authorization_url");
        result = reply(value);
        result.headers.set(
          "Set-Cookie",
          `${COOKIE}=${nonce}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        );
      } else {
        result = reply(z.object({ ok: z.literal(true) }).parse(data));
        result.headers.set(
          "Set-Cookie",
          `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        );
      }
      return result;
    } catch (error) {
      const invalid =
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === "invalid_body");
      return reply(
        { error: "github_connection_unavailable" },
        signal.aborted
          ? 504
          : error instanceof Error && error.message === "body_too_large"
            ? 413
            : invalid
              ? 400
              : 503,
      );
    }
  };
}
