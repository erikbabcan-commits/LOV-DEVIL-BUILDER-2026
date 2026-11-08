import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionPanel } from "./ConnectionPanel";
import { honoFetch } from "@/lib/hono-client";
const state = vi.hoisted(() => ({ id: "alice" }));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({ status: "signed-in", session: { user: { id: state.id } } }),
}));
vi.mock("@/lib/hono-client", () => ({ honoFetch: vi.fn() }));
const usage = {
  periodStart: "2026-11-01",
  periodEnd: "2026-12-01",
  calls: 3,
  reportedCalls: 2,
  unknownCalls: 1,
  pendingCalls: 0,
  promptTokens: 120,
  completionTokens: 40,
};
const me = (id: string) => ({
  user: { id: "internal-" + id, plan: "free" },
  quota: { used: 1, limit: 10, remaining: 9, plan: "free" },
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  state.id = "alice";
});
describe("account-bound token reporting", () => {
  it("guides a verified unlinked account until the next successful connection check", async () => {
    vi.mocked(honoFetch).mockImplementation(async (path) =>
      path === "auth/me"
        ? Response.json({ error: "cloud_identity_unlinked" }, { status: 401 })
        : Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
    render(<ConnectionPanel onClose={() => {}} />);
    expect(await screen.findByText("Účet čaká na prepojenie s VPS")).toBeInTheDocument();
    expect(screen.getByText(/Správca musí prepojiť tento účet s VPS/)).toBeInTheDocument();
    expect(screen.getByText(/Potom obnov stav pripojenia/)).toBeInTheDocument();
    vi.mocked(honoFetch).mockImplementation(async (path) =>
      Response.json(
        path === "sandbox/ready" ? { ready: true } : path === "auth/me" ? me("alice") : usage,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Overiť znova" }));
    expect(await screen.findByText("Prepojený (free)")).toBeInTheDocument();
    expect(screen.queryByText(/Správca musí prepojiť/)).not.toBeInTheDocument();
  });
  it("shows token coverage and keeps unknown calls visible", async () => {
    vi.mocked(honoFetch).mockImplementation(async (path) =>
      Response.json(
        path === "sandbox/ready" ? { ready: true } : path === "auth/me" ? me("alice") : usage,
      ),
    );
    render(<ConnectionPanel onClose={() => {}} />);
    expect(await screen.findByText("160 nahlásených tokenov")).toBeInTheDocument();
    expect(screen.getByText(/Súčet je neúplný/)).toBeInTheDocument();
  });
  it("does not show a synthetic zero when the usage response is malformed", async () => {
    vi.mocked(honoFetch).mockImplementation(async (path) =>
      Response.json(
        path === "sandbox/ready" ? { ready: true } : path === "auth/me" ? me("alice") : {},
      ),
    );
    render(<ConnectionPanel onClose={() => {}} />);
    expect(await screen.findByText(/Spotrebu tokenov sa nepodarilo/)).toBeInTheDocument();
    expect(screen.queryByText(/nahlásených tokenov/)).not.toBeInTheDocument();
  });
  it("ignores delayed Alice responses after switching to Bob", async () => {
    const finish: Array<() => void> = [];
    vi.mocked(honoFetch).mockImplementation(async (path) => {
      const id = state.id;
      if (id === "alice") await new Promise<void>((resolve) => finish.push(resolve));
      return Response.json(
        path === "sandbox/ready"
          ? { ready: true }
          : path === "auth/me"
            ? me(id)
            : id === "alice"
              ? usage
              : {
                  ...usage,
                  calls: 0,
                  reportedCalls: 0,
                  unknownCalls: 0,
                  promptTokens: 0,
                  completionTokens: 0,
                },
      );
    });
    const view = render(<ConnectionPanel onClose={() => {}} />);
    state.id = "bob";
    view.rerender(<ConnectionPanel onClose={() => {}} />);
    expect(await screen.findByText("0 nahlásených tokenov")).toBeInTheDocument();
    for (const resolve of finish) resolve();
    await waitFor(() =>
      expect(screen.queryByText("160 nahlásených tokenov")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("0 nahlásených tokenov")).toBeInTheDocument();
  });
});
