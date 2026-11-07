import { afterEach, describe, it, expect, vi } from "vitest";
import { handleHonoProxy, MAX_REQUEST_BYTES, type ProxyDeps } from "./hono-proxy.server";

const O = "https://app.test";
const BASE = "https://hono.test";

function deps(over: Partial<ProxyDeps> = {}): ProxyDeps & { fetch: ReturnType<typeof vi.fn> } {
  return {
    baseUrl: BASE,
    verifyToken: vi.fn(async () => true),
    fetch: vi.fn(async () => json({ ok: true })),
    ...over,
  } as never;
}
function json(b: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return new Request(`${O}/api/hono/${path}`, {
    ...init,
    headers: { authorization: "Bearer tok.en.x", ...(init.headers ?? {}) },
  });
}
const post = (path: string, body = "{}", h: Record<string, string> = {}) =>
  req(path, {
    method: "POST",
    body,
    headers: { origin: O, "content-type": "application/json", ...h },
  });
const run = (r: Request, d = deps()) =>
  handleHonoProxy(r, new URL(r.url).pathname.replace("/api/hono/", ""), d);
afterEach(() => vi.useRealTimers());

describe("routing", () => {
  it("allows authenticated publish preparation and UUID status without proxying public artifacts", async () => {
    const d = deps(),
      id = "dd4ec3fc-a77b-4af7-baa5-f25ac7228221";
    const versionPath = "publish/project/demo-project/2/snapshot_one";
    for (const request of [
      req("publish"),
      post("publish", "{}"),
      req("publish/" + id),
      req(versionPath),
    ]) {
      expect((await run(request, d)).status).toBe(200);
      expect(d.fetch.mock.calls.at(-1)![0]).toBe(
        BASE + new URL(request.url).pathname.replace("/api/hono/", "/api/"),
      );
    }
    d.fetch.mockClear();
    expect((await run(req("publish?url=https://evil.test"), d)).status).toBe(400);
    for (const path of [
      "publish/not-a-uuid",
      "publish/project/demo-project/0/snapshot_one",
      versionPath + "/artifact",
      "publish/" + id + "/artifact",
      "published/" + id + "/index.html",
    ])
      expect((await run(req(path), d)).status).toBe(404);
    expect((await run(post("publish/" + id), d)).status).toBe(405);
    expect((await run(post(versionPath), d)).status).toBe(405);
    expect((await run(req(versionPath + "?owner=bob"), d)).status).toBe(400);
    expect((await run(post("publish", " ".repeat(4097)), d)).status).toBe(413);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("maps only the three fixed billing routes and strips caller ownership/credentials", async () => {
    const d = deps();
    for (const [path, method] of [
      ["billing", "GET"],
      ["billing/checkout", "POST"],
      ["billing/portal", "POST"],
    ]) {
      const response = await run(
        method === "GET"
          ? req(path!)
          : post(path!, JSON.stringify({ requestId: "fixture" }), { cookie: "private=secret" }),
        d,
      );
      expect(response.status).toBe(200);
      const [url, init] = d.fetch.mock.calls.at(-1)!;
      expect(url).toBe(BASE + "/api/" + path);
      expect(new Headers(init.headers).get("cookie")).toBeNull();
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok.en.x");
    }
    d.fetch.mockClear();
    expect((await run(req("billing?owner=bob"), d)).status).toBe(400);
    expect((await run(post("billing"), d)).status).toBe(405);
    expect((await run(req("billing/portal"), d)).status).toBe(405);
    for (const path of [
      "billing/webhook",
      "billing/customers",
      "billing/invoices",
      "billing/checkout/session",
    ])
      expect((await run(post(path), d)).status).toBe(404);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("bounds billing JSON to 8KiB and requires the same-origin verified session", async () => {
    const d = deps();
    expect((await run(post("billing/checkout", " ".repeat(8193)), d)).status).toBe(413);
    expect(
      (await run(post("billing/portal", "{}", { origin: "https://evil.test" }), d)).status,
    ).toBe(403);
    expect(
      (await run(post("billing/portal"), deps({ verifyToken: async () => false }))).status,
    ).toBe(401);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("maps only fixed GET model catalog without query or write overrides", async () => {
    const d = deps();
    expect((await run(req("ai-models"), d)).status).toBe(200);
    expect(d.fetch.mock.calls[0]![0]).toBe(`${BASE}/api/ai-models`);
    d.fetch.mockClear();
    expect((await run(req("ai-models?url=https://other.test"), d)).status).toBe(400);
    expect((await run(post("ai-models"), d)).status).toBe(405);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("maps read-only AI usage without caller ownership or write overrides", async () => {
    const d = deps();
    expect((await run(req("ai-usage"), d)).status).toBe(200);
    expect(d.fetch.mock.calls[0]![0]).toBe(`${BASE}/api/ai-usage`);
    d.fetch.mockClear();
    expect((await run(req("ai-usage?owner=bob"), d)).status).toBe(400);
    expect((await run(post("ai-usage"), d)).status).toBe(405);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("maps read-only account storage without caller-supplied ownership", async () => {
    const d = deps();
    expect((await run(req("project-storage"), d)).status).toBe(200);
    expect(d.fetch.mock.calls[0]![0]).toBe(`${BASE}/api/project-storage`);
    d.fetch.mockClear();
    expect((await run(req("project-storage?owner=bob"), d)).status).toBe(400);
    expect((await run(post("project-storage"), d)).status).toBe(405);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("maps projects to /api/projects with allowed query", async () => {
    const d = deps();
    const r = await run(req("projects?deleted=1&cursor=abc_1"), d);
    expect(r.status).toBe(200);
    expect(d.fetch.mock.calls[0]![0]).toBe(`${BASE}/api/projects?deleted=1&cursor=abc_1`);
  });
  it("maps auth/me", async () => {
    const d = deps();
    await run(req("auth/me"), d);
    expect(d.fetch.mock.calls[0]![0]).toBe(`${BASE}/api/auth/me`);
  });
  it("allows only read-only account export sections and fixed cursor paths", async () => {
    const d = deps();
    expect((await run(req("account/export/projects/cHJvamVjdA"), d)).status).toBe(200);
    expect(d.fetch.mock.calls[0]![0]).toBe(`${BASE}/api/account/export/projects/cHJvamVjdA`);
    expect((await run(req("account/export/profile?owner=bob"), d)).status).toBe(400);
    expect((await run(post("account/export/profile"), d)).status).toBe(405);
    expect((await run(req("account/export/tokens"), d)).status).toBe(404);
    expect(d.fetch).toHaveBeenCalledOnce();
  });
  it("proxies only the fixed account closure operations and caps their input", async () => {
    const d = deps();
    expect((await run(req("account/closure"), d)).status).toBe(200);
    expect((await run(post("account/closure/cancel"), d)).status).toBe(200);
    expect(d.fetch.mock.calls[1]![0]).toBe(`${BASE}/api/account/closure/cancel`);
    expect((await run(post("account/closure", "{}", { origin: "https://other.test" }), d)).status).toBe(403);
    expect((await run(post("account/closure", "x".repeat(513)), d)).status).toBe(413);
    expect((await run(post("account/closure/apply"), d)).status).toBe(404);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });
  it("unknown path 404, wrong method 405", async () => {
    expect((await run(req("agent/autofix"))).status).toBe(404);
    expect((await run(req("sandbox/build"))).status).toBe(405);
  });
  it("rejects bad ids and traversal", async () => {
    expect((await run(req("projects/a.b"))).status).toBe(404);
    expect((await run(req("projects/%2e%2e"))).status).toBe(404);
    expect((await run(req("projects/" + "a".repeat(129)))).status).toBe(404);
  });
  it("rejects duplicate, unknown and invalid query", async () => {
    expect((await run(req("projects?deleted=0&deleted=1"))).status).toBe(400);
    expect((await run(req("projects?x=1"))).status).toBe(400);
    expect((await run(req("projects?deleted=2"))).status).toBe(400);
    expect((await run(req("projects?cursor=a/b"))).status).toBe(400);
    expect((await run(req("auth/me?a=1"))).status).toBe(400);
  });
  it("503 when HONO_BASE_URL missing or not https", async () => {
    expect((await run(req("auth/me"), deps({ baseUrl: undefined }))).status).toBe(503);
    expect((await run(req("auth/me"), deps({ baseUrl: "http://x.test" }))).status).toBe(503);
  });
});

describe("auth", () => {
  it("401 without bearer, no upstream call", async () => {
    const d = deps();
    const r = await run(new Request(`${O}/api/hono/auth/me`), d);
    expect(r.status).toBe(401);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("401 when getUser rejects token, no upstream call", async () => {
    const d = deps({ verifyToken: vi.fn(async () => false) });
    expect((await run(req("auth/me"), d)).status).toBe(401);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  const spoof = {
    cookie: "a=b",
    "x-forwarded-for": "1.2.3.4",
    "x-lov-cloud-authorization": "Bearer evil",
  };
  it("without HONO_BASIC_AUTH: only user Bearer, spoofed headers dropped", async () => {
    const d = deps();
    await run(req("auth/me", { headers: spoof }), d);
    const h = d.fetch.mock.calls[0]![1].headers as Headers;
    expect(h.get("authorization")).toBe("Bearer tok.en.x");
    expect(h.get("x-lov-cloud-authorization")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(d.fetch.mock.calls[0]![1].redirect).toBe("manual");
  });
  it("with HONO_BASIC_AUTH: Basic for Nginx + verified token in X-LOV-Cloud-Authorization", async () => {
    const d = deps({ basicAuth: "user:p:ss" });
    await run(req("auth/me", { headers: spoof }), d);
    const h = d.fetch.mock.calls[0]![1].headers as Headers;
    expect(h.get("authorization")).toBe(`Basic ${btoa("user:p:ss")}`);
    expect(h.get("x-lov-cloud-authorization")).toBe("Bearer tok.en.x");
    expect(h.get("cookie")).toBeNull();
  });
  it("client Basic Authorization is not a valid user token", async () => {
    const d = deps({ basicAuth: "user:pw" });
    const r = await run(
      req("auth/me", {
        headers: {
          authorization: "Basic dXNlcjpwdw==",
          "x-lov-cloud-authorization": "Bearer tok.en.x",
        },
      }),
      d,
    );
    expect(r.status).toBe(401);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("malformed HONO_BASIC_AUTH -> 503 without upstream call or token check", async () => {
    for (const v of ["nocolon", ":pw", "u:p\n"]) {
      const d = deps({ basicAuth: v });
      const r = await run(req("auth/me"), d);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "hono_basic_auth_invalid" });
      expect(d.fetch).not.toHaveBeenCalled();
      expect(d.verifyToken).not.toHaveBeenCalled();
    }
  });
  it("mutation with dual transport keeps both headers", async () => {
    const d = deps({ basicAuth: "u:p" });
    await run(post("sandbox/build", "{}", { "x-lov-cloud-authorization": "Bearer evil" }), d);
    const h = d.fetch.mock.calls[0]![1].headers as Headers;
    expect(h.get("authorization")).toBe(`Basic ${btoa("u:p")}`);
    expect(h.get("x-lov-cloud-authorization")).toBe("Bearer tok.en.x");
  });
});

describe("mutations", () => {
  it("403 on missing or foreign Origin", async () => {
    expect(
      (
        await run(
          req("sandbox/build", {
            method: "POST",
            body: "{}",
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(403);
    expect((await run(post("sandbox/build", "{}", { origin: "https://evil.test" }))).status).toBe(
      403,
    );
  });
  it("415 without application/json", async () => {
    expect((await run(post("sandbox/build", "{}", { "content-type": "text/plain" }))).status).toBe(
      415,
    );
  });
  it("413 by content-length and by streamed size", async () => {
    expect(
      (await run(post("projects/p1", "{}", { "content-length": String(MAX_REQUEST_BYTES + 1) })))
        .status,
    ).toBe(413);
    const big = "x".repeat(MAX_REQUEST_BYTES + 1);
    const d = deps();
    expect((await run(post("projects/p1", big), d)).status).toBe(413);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("preserves 409 conflict JSON", async () => {
    const d = deps({ fetch: vi.fn(async () => json({ error: "conflict" }, 409)) as never });
    const r = await run(post("projects/p1", '{"expectedRevision":1}'), d);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "conflict" });
  });
});

describe("responses", () => {
  it("keeps the deadline active after headers and cancels a stalled SSE stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const d = deps({
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ) as never,
    });
    const response = await run(post("agent/generate"), d);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    const pending = reader.read().catch((error) => error);
    await vi.advanceTimersByTimeAsync(130_001);
    expect((await pending).name).toBe("TimeoutError");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an already disconnected client before upstream work", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const d = deps();
    const response = await run(req("auth/me", { signal: ctrl.signal }), d);
    expect(response.status).toBe(504);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("bounds fetch implementations that ignore abort signals", async () => {
    vi.useFakeTimers();
    const d = deps({ fetch: vi.fn(async () => new Promise(() => {})) as never });
    const pending = run(req("auth/me"), d);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending).status).toBe(504);
  });
  it("3xx -> 502 and strips Location", async () => {
    const d = deps({
      fetch: vi.fn(
        async () => new Response(null, { status: 302, headers: { location: "https://x" } }),
      ) as never,
    });
    const r = await run(req("auth/me"), d);
    expect(r.status).toBe(502);
    expect(r.headers.get("location")).toBeNull();
  });
  it("strips Set-Cookie and CORS, adds no-store/nosniff", async () => {
    const d = deps({
      fetch: vi.fn(async () =>
        json({}, 429, { "set-cookie": "a=b", "access-control-allow-origin": "*" }),
      ) as never,
    });
    const r = await run(req("auth/me"), d);
    expect(r.status).toBe(429);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("non-JSON -> 502, Basic Auth challenge reported", async () => {
    const html = vi.fn(
      async () => new Response("<h1>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect((await run(req("auth/me"), deps({ fetch: html as never }))).status).toBe(502);
    const basic = vi.fn(
      async () =>
        new Response("no", {
          status: 401,
          headers: { "content-type": "text/plain", "www-authenticate": "Basic realm=x" },
        }),
    );
    const r = await run(req("sandbox/ready"), deps({ fetch: basic as never }));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "upstream_basic_auth" });
  });
  it("SSE only allowed for generate", async () => {
    const sse = vi.fn(
      async () => new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    const ok = await run(post("agent/generate"), deps({ fetch: sse as never }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    expect(await ok.text()).toBe("data: x\n\n");
    expect((await run(post("sandbox/build"), deps({ fetch: sse as never }))).status).toBe(502);
  });
  it("network error -> 502", async () => {
    const d = deps({
      fetch: vi.fn(async () => {
        throw new TypeError("net");
      }) as never,
    });
    expect((await run(req("auth/me"), d)).status).toBe(502);
  });
  it("timeout -> 504 and aborts upstream", async () => {
    vi.useFakeTimers();
    let sig: AbortSignal | undefined;
    const d = deps({
      fetch: vi.fn((_u: string, init: RequestInit) => {
        sig = init.signal!;
        return new Promise((_r, rej) =>
          init.signal!.addEventListener("abort", () => rej(new Error("abort"))),
        );
      }) as never,
    });
    const p = run(req("auth/me"), d);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await p).status).toBe(504);
    expect(sig?.aborted).toBe(true);
    vi.useRealTimers();
  });
  it("response over 16MB by content-length -> 502", async () => {
    const d = deps({
      fetch: vi.fn(async () =>
        json({}, 200, { "content-length": String(17 * 1024 * 1024) }),
      ) as never,
    });
    expect((await run(req("auth/me"), d)).status).toBe(502);
  });
});
