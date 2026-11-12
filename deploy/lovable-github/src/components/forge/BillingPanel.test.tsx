import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingPanel } from "./BillingPanel";
import {
  checkoutReceipt,
  readCheckoutReceipt,
  trustedStripeRedirect,
  type BillingStatus,
} from "@/lib/billing-client";

const mocks = vi.hoisted(() => ({
  owner: "cloud-alice",
  token: "alice.token",
  request: vi.fn(),
  getSession: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: (listener: () => void) => {
        mocks.listeners.add(listener);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                mocks.listeners.delete(listener);
              },
            },
          },
        };
      },
    },
  },
}));
vi.mock("@/lib/hono-client", () => ({ honoFetch: mocks.request }));
const scope = () => ({
  cloudUserId: mocks.owner,
  honoUserId: "internal-alice",
  token: mocks.token,
});
const report = (overrides: Partial<BillingStatus> = {}): BillingStatus => ({
  userId: "internal-alice",
  enabled: true,
  mode: "sandbox",
  plan: "free",
  subscription: null,
  prices: { month: { amount: 2000, currency: "eur" }, year: { amount: 20000, currency: "eur" } },
  trialDays: 14,
  checkoutAvailable: true,
  portalAvailable: false,
  pendingCheckout: false,
  ...overrides,
});
function panel(navigate = vi.fn()) {
  return {
    navigate,
    view: render(
      <BillingPanel
        cloudUserId={mocks.owner}
        honoUserId="internal-alice"
        accessToken={mocks.token}
        navigate={navigate}
      />,
    ),
  };
}
async function start() {
  return screen.findByRole("button", { name: "Otvoriť testovací Checkout" });
}
const posts = () => mocks.request.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  mocks.owner = "cloud-alice";
  mocks.token = "alice.token";
  mocks.request.mockReset();
  mocks.getSession.mockReset();
  mocks.getSession.mockImplementation(async () => ({
    data: { session: { access_token: mocks.token, user: { id: mocks.owner } } },
  }));
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Cloud billing bound to the verified Hono owner", () => {
  it("shows disabled verified plan without invented prices or automatic writes", async () => {
    mocks.request.mockResolvedValue(
      Response.json(
        report({
          enabled: false,
          mode: "disabled",
          plan: "pro",
          checkoutAvailable: false,
          prices: { month: null, year: null },
        }),
      ),
    );
    panel();
    expect(await screen.findByText(/VORKEI Pro · 200/)).toBeInTheDocument();
    expect(screen.getByText(/Platby ešte nie sú spustené/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("uses explicit annual checkout, canonical internal owner and a scoped durable request ID", async () => {
    mocks.request.mockImplementation(async (path) =>
      Response.json(
        path === "billing"
          ? report()
          : { userId: "internal-alice", url: "https://checkout.stripe.com/c/pay/fixture" },
      ),
    );
    const { navigate } = panel();
    await start();
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: /Ročne/ }));
    fireEvent.click(await start());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/fixture"),
    );
    expect(posts()[0]![0]).toBe("billing/checkout");
    expect(posts()[0]![1]).toMatchObject({
      expectedUserId: "cloud-alice",
      expectedAccessToken: "alice.token",
      method: "POST",
      body: { interval: "year", requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) },
    });
    const saved = JSON.parse(
      sessionStorage.getItem("forge-billing-checkout:v1:cloud-alice:internal-alice:sandbox")!,
    );
    expect(saved).toEqual({ version: 1, ...posts()[0]![1]!.body });
    expect(screen.getByText(/VORKEI Free · 10/)).toBeInTheDocument();
  });
  it("labels live mode explicitly and keeps sandbox receipts separate", async () => {
    const old = checkoutReceipt(scope(), "sandbox", "month");
    mocks.request.mockImplementation(async (path) =>
      Response.json(
        path === "billing"
          ? report({ mode: "live" })
          : { userId: "internal-alice", url: "https://checkout.stripe.com/c/pay/live_fixture" },
      ),
    );
    const { navigate } = panel();
    await screen.findByText("Živé platby Stripe");
    expect(screen.queryByText("Testovací režim Stripe")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pokračovať do Stripe Checkoutu" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(readCheckoutReceipt(scope(), "live")?.requestId).not.toBe(old.requestId);
    expect(readCheckoutReceipt(scope(), "sandbox")).toEqual(old);
  });
  it("retains the exact retry request across uncertainty and remount", async () => {
    let calls = 0;
    mocks.request.mockImplementation(async (path) => {
      if (path === "billing") return Response.json(report({ pendingCheckout: calls > 0 }));
      if (++calls === 1) throw new TypeError("lost");
      return Response.json({
        userId: "internal-alice",
        url: "https://checkout.stripe.com/c/pay/recovered",
      });
    });
    const first = panel();
    fireEvent.click(await start());
    expect(await screen.findByRole("alert")).toHaveTextContent("rovnakou požiadavkou");
    const body = posts()[0]![1]!.body;
    first.view.unmount();
    const second = panel();
    const retry = await screen.findByRole("button", { name: "Pokračovať v Checkoute" });
    expect(screen.getByRole("radio", { name: /Ročne/ })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(second.navigate).toHaveBeenCalled());
    expect(posts()[1]![1]!.body).toEqual(body);
  });
  it("rejects Cloud-subject-as-internal-owner confusion", async () => {
    mocks.request.mockResolvedValue(Response.json(report({ userId: "cloud-alice" })));
    panel();
    expect(await screen.findByRole("alert")).toHaveTextContent("neprešla overením");
    expect(screen.queryByText(/VORKEI Free/)).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
  it("drops an Alice checkout response after switching to Bob", async () => {
    let finish!: (value: Response) => void;
    mocks.request.mockImplementation(async (path) =>
      path === "billing"
        ? Response.json(report())
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    const { view, navigate } = panel();
    fireEvent.click(await start());
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.owner = "cloud-bob";
    mocks.token = "bob.token";
    view.rerender(
      <BillingPanel
        cloudUserId="cloud-bob"
        honoUserId="internal-bob"
        accessToken="bob.token"
        navigate={navigate}
      />,
    );
    await act(async () => {
      finish(
        Response.json({ userId: "internal-alice", url: "https://checkout.stripe.com/c/pay/late" }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(posts()[0]![1]!.signal.aborted).toBe(true);
  });
  it("rejects an older operation even after auth A→B→A returns to the same token", async () => {
    let finish!: (value: Response) => void;
    mocks.request.mockImplementation(async (path) =>
      path === "billing"
        ? Response.json(report())
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    const { navigate } = panel();
    fireEvent.click(await start());
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => {
      mocks.owner = "cloud-bob";
      mocks.token = "bob.token";
      for (const listener of mocks.listeners) listener();
      mocks.owner = "cloud-alice";
      mocks.token = "alice.token";
      for (const listener of mocks.listeners) listener();
    });
    await act(async () => {
      finish(
        Response.json({ userId: "internal-alice", url: "https://checkout.stripe.com/c/pay/old" }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(posts()[0]![1]!.signal.aborted).toBe(true);
  });
  it("does not navigate after unmount when the transport ignores abort", async () => {
    let finish!: (value: Response) => void;
    mocks.request.mockImplementation(async (path) =>
      path === "billing"
        ? Response.json(report())
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    const { view, navigate } = panel();
    fireEvent.click(await start());
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.unmount();
    await act(async () => {
      finish(
        Response.json({ userId: "internal-alice", url: "https://checkout.stripe.com/c/pay/late" }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("requires the current exact token before preparing a POST", async () => {
    mocks.request.mockResolvedValue(Response.json(report()));
    const { navigate } = panel();
    await start();
    mocks.token = "refreshed.token";
    fireEvent.click(await start());
    await act(async () => {});
    expect(posts()).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });
  it("offers self-service portal only on explicit action", async () => {
    mocks.request.mockImplementation(async (path) =>
      Response.json(
        path === "billing"
          ? report({
              plan: "pro",
              mode: "live",
              checkoutAvailable: false,
              portalAvailable: true,
              subscription: {
                status: "trialing",
                interval: "month",
                periodEnd: "2026-11-20T00:00:00.000Z",
                cancelAtPeriodEnd: true,
              },
            })
          : { userId: "internal-alice", url: "https://billing.stripe.com/p/session/fixture" },
      ),
    );
    const { navigate } = panel();
    await screen.findByText(/Skúšobná doba/);
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Spravovať predplatné" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://billing.stripe.com/p/session/fixture"),
    );
    expect(posts()[0]![0]).toBe("billing/portal");
  });
  it("refuses a response bound to another internal account", async () => {
    mocks.request.mockImplementation(async (path) =>
      Response.json(
        path === "billing"
          ? report()
          : { userId: "internal-bob", url: "https://checkout.stripe.com/c/pay/wrong_owner" },
      ),
    );
    const { navigate } = panel();
    fireEvent.click(await start());
    expect(await screen.findByRole("alert")).toHaveTextContent("neprešla overením");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("requires durable recovery storage before sending checkout", async () => {
    mocks.request.mockResolvedValue(Response.json(report()));
    panel();
    await start();
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota");
      },
      removeItem: vi.fn(),
    });
    fireEvent.click(await start());
    expect(await screen.findByRole("alert")).toHaveTextContent("nemôže uložiť");
    expect(posts()).toHaveLength(0);
  });
  it.each([
    "https://checkout.stripe.com.evil.test/x",
    "http://checkout.stripe.com/x",
    "https://user:pass@billing.stripe.com/x",
    "https://billing.stripe.com:8443/x",
    "javascript:alert(1)",
  ])("never navigates to an untrusted target %s", async (url) => {
    mocks.request.mockImplementation(async (path) =>
      Response.json(path === "billing" ? report() : { userId: "internal-alice", url }),
    );
    const { navigate } = panel();
    fireEvent.click(await start());
    expect(await screen.findByRole("alert")).toHaveTextContent("Presmerovanie sa neuskutočnilo");
    expect(navigate).not.toHaveBeenCalled();
    expect(() => trustedStripeRedirect(url)).toThrow();
  });
});
