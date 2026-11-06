import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { ConnectionPanel } from "@/components/forge/ConnectionPanel";
import { deriveSessionState, mapMe, mapReady } from "./auth-state";

const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const state = vi.hoisted(() => ({
  value: {} as { status: "signed-in"; email: string; session: { user: { id: string } } },
  fetch: vi.fn(),
}));
vi.mock("@/hooks/use-session", () => ({ useSession: () => state.value }));
vi.mock("@/lib/hono-client", () => ({ honoFetch: state.fetch }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));

describe("session state", () => {
  it("loading / signed-out / signed-in", () => {
    expect(deriveSessionState(false, null)).toEqual({ status: "loading" });
    expect(deriveSessionState(true, null)).toEqual({ status: "signed-out" });
    expect(deriveSessionState(true, { user: { email: "a@b.c" } })).toEqual({
      status: "signed-in",
      email: "a@b.c",
    });
  });
});

describe("panel mapping", () => {
  it("ready", async () => {
    expect(await mapReady(j({ ok: true }))).toBe("ok");
    expect(await mapReady(j({ error: "hono_not_configured" }, 503))).toBe("not-configured");
    expect(await mapReady(j({ error: "upstream_basic_auth" }, 502))).toBe("basic-auth");
    expect(await mapReady(j({ error: "timeout" }, 504))).toBe("timeout");
  });
  it("me", async () => {
    expect(await mapMe(j({ user: { id: "1", email: "x", plan: "pro" }, quota: {} }))).toEqual({
      state: "linked",
      plan: "pro",
    });
    expect((await mapMe(j({ error: "unlinked" }, 401))).state).toBe("auth-incomplete");
    expect((await mapMe(j({ error: "db" }, 503))).state).toBe("identity-unavailable");
    expect((await mapMe(j({ error: "hono_not_configured" }, 503))).state).toBe("not-configured");
  });
});

describe("quota response validation", () => {
  it("accepts verified usage and rejects a fake linked response or malformed quota", async () => {
    const quota = { used: 8, limit: 10, remaining: 2, plan: "free" };
    expect(await mapMe(j({ user: { id: "alice", plan: "free" }, quota }))).toMatchObject({
      state: "linked",
      quota,
    });
    expect(await mapMe(j({ ok: true }))).toEqual({ state: "error" });
    expect(
      await mapMe(j({ user: { id: "alice", plan: "free" }, quota: { ...quota, remaining: 10 } })),
    ).not.toHaveProperty("quota");
  });
});

describe("connection panel account boundaries", () => {
  let pending: { resolve: (value: Response) => void; signal: AbortSignal }[];
  const signedIn = (id: string) => ({
    status: "signed-in" as const,
    email: id + "@example.com",
    session: { user: { id } },
  });
  beforeEach(() => {
    pending = [];
    state.value = signedIn("alice");
    state.fetch.mockReset();
    state.fetch.mockImplementation(
      (_path, init) =>
        new Promise((resolve) => {
          pending.push({ resolve, signal: init.signal });
        }),
    );
  });
  afterEach(cleanup);
  it("ignores Alice responses arriving after Bob has already connected", async () => {
    const { rerender } = render(createElement(ConnectionPanel, { onClose() {} }));
    await waitFor(() => expect(pending).toHaveLength(3));
    state.value = signedIn("bob");
    rerender(createElement(ConnectionPanel, { onClose() {} }));
    await waitFor(() => expect(pending).toHaveLength(6));
    expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => {
      pending[3]!.resolve(j({ ready: true }));
      pending[4]!.resolve(j({ user: { id: "bob", plan: "pro" } }));
      pending[5]!.resolve(j({}));
    });
    await waitFor(() => expect(screen.getByText("Prepojený (pro)")).toBeInTheDocument());
    await act(async () => {
      pending[0]!.resolve(j({ ready: true }));
      pending[1]!.resolve(j({ user: { id: "alice", plan: "free" } }));
      pending[2]!.resolve(j({}));
    });
    expect(screen.queryByText("Prepojený (free)")).not.toBeInTheDocument();
    expect(screen.getByText("Prepojený (pro)")).toBeInTheDocument();
  });
  it("hides quota immediately when the Cloud account changes and shows only Bob's result", async () => {
    const { rerender } = render(createElement(ConnectionPanel, { onClose() {} }));
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[0]!.resolve(j({ ready: true }));
      pending[1]!.resolve(
        j({
          user: { id: "internal-alice", plan: "free" },
          quota: { used: 8, limit: 10, remaining: 2, plan: "free" },
        }),
      );
      pending[state.value.session.user.id === "alice" ? 2 : 5]!.resolve(j({}));
    });
    expect(screen.getByRole("region", { name: "Spotreba AI účtu" })).toHaveTextContent("8 / 10");
    expect(screen.getByRole("status")).toHaveTextContent("Blížiš sa");
    state.value = signedIn("bob");
    rerender(createElement(ConnectionPanel, { onClose() {} }));
    expect(screen.queryByRole("region", { name: "Spotreba AI účtu" })).not.toBeInTheDocument();
    await waitFor(() => expect(pending).toHaveLength(6));
    await act(async () => {
      pending[3]!.resolve(j({ ready: true }));
      pending[4]!.resolve(
        j({
          user: { id: "internal-bob", plan: "pro" },
          quota: { used: 0, limit: 200, remaining: 200, plan: "pro" },
        }),
      );
      pending[state.value.session.user.id === "alice" ? 2 : 5]!.resolve(j({}));
    });
    expect(screen.getByRole("region", { name: "Spotreba AI účtu" })).toHaveTextContent("0 / 200");
    expect(screen.queryByText(/8 \/ 10/)).not.toBeInTheDocument();
  });
  it("aborts pending probes when the panel closes", async () => {
    const { unmount } = render(createElement(ConnectionPanel, { onClose() {} }));
    await waitFor(() => expect(pending).toHaveLength(3));
    unmount();
    expect(pending.every((item) => item.signal.aborted)).toBe(true);
  });
});
