import { afterEach, describe, expect, it, vi } from "vitest";
import { honoFetch } from "./hono-client";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
describe("workspace transport owner binding", () => {
  it("does not prepare billing under a refreshed or switched token", async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: "new-alice", user: { id: "alice" } } },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await honoFetch("billing/checkout", {
      expectedUserId: "alice",
      expectedAccessToken: "old-alice",
      method: "POST",
      body: { requestId: "fixture" },
    });
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send a previous account source under a newer account token", async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: "synthetic-bob", user: { id: "bob" } } },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await honoFetch("agent/generate", {
      expectedUserId: "alice",
      method: "POST",
      body: { privateSource: "alice-code" },
    });
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards only the matching user token to the same-origin fixed bridge", async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: "synthetic-alice", user: { id: "alice" } } },
    });
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await honoFetch("agent/generate", {
      expectedUserId: "alice",
      method: "POST",
      body: { prompt: "Hello" },
      signal,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/hono/agent/generate",
      expect.objectContaining({
        signal,
        method: "POST",
        credentials: "omit",
        headers: expect.objectContaining({ authorization: "Bearer synthetic-alice" }),
      }),
    );
  });
});
