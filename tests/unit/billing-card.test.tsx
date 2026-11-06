import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BillingCard } from "../../src/features/billing/BillingCard";
import { selectDatabaseScope } from "../../src/services/persistence/db";
import {
  captureBillingIdentity,
  prepareCheckoutAttempt,
  trustedBillingUrl,
} from "../../src/services/billing";
import type { BillingStatus } from "../../shared/billing";

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    userId: "alice",
    enabled: true,
    mode: "sandbox",
    plan: "free",
    subscription: null,
    prices: {
      month: { amount: 2000, currency: "eur" },
      year: { amount: 20000, currency: "eur" },
    },
    trialDays: 14,
    checkoutAvailable: true,
    portalAvailable: false,
    pendingCheckout: false,
    ...overrides,
  };
}
function csrf() {
  document.cookie = "lov_csrf=fixture-csrf; Path=/";
}
beforeEach(() => {
  selectDatabaseScope({ kind: "account", userId: "alice" });
  sessionStorage.clear();
  csrf();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  selectDatabaseScope({ kind: "pilot" });
  document.cookie = "lov_csrf=; Max-Age=0; Path=/";
});
async function checkoutButton() {
  return screen.findByRole("button", {
    name: /Pokračovať.*Checkoute|Pokračovať do testovacieho Checkoutu/,
  });
}
function posted(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(([, init]) => init?.method === "POST");
}
describe("verified account subscription UI", () => {
  it("keeps sandbox and live retry UUIDs separate and discards a sandbox interval in live UI", async () => {
    const identity = captureBillingIdentity("alice")!;
    const sandbox = prepareCheckoutAttempt(identity, "year", "sandbox");
    const live = prepareCheckoutAttempt(identity, "month", "live");
    expect(live.requestId).not.toBe(sandbox.requestId);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(status({mode:"live"}))));
    render(<BillingCard userId="alice" />);
    await screen.findByText("Platby cez Stripe");
    expect(screen.getByRole("radio", {name:/Mesačne/})).toBeChecked();
    expect(screen.getByRole("radio", {name:/Ročne/})).not.toBeChecked();
  });

  it("labels live checkout and portal as real payments while requiring an explicit action", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(status({ mode: "live", portalAvailable: true })));
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" />);
    expect(await screen.findByText("Platby cez Stripe")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Pokračovať do Checkoutu"})).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Spravovať predplatné"})).toBeInTheDocument();
    expect(screen.queryByText("Testovací režim Stripe")).not.toBeInTheDocument();
    expect(screen.queryByText(/Testovacie platby nemenia/)).not.toBeInTheDocument();
    expect(screen.getByText(/Návrat z Checkoutu sám nemení plán/)).toBeInTheDocument();
    expect(posted(fetch)).toEqual([]);
  });

  it("shows verified disabled plan without invented prices or payment actions", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        status({
          enabled: false,
          mode: "disabled",
          plan: "pro",
          prices: { month: null, year: null },
          checkoutAvailable: false,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" />);
    expect(await screen.findByText("Forge Pro")).toBeInTheDocument();
    expect(screen.getByText("200 AI úloh mesačne")).toBeInTheDocument();
    expect(screen.getByText(/Platby ešte nie sú spustené/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/20,00/)).not.toBeInTheDocument();
    expect(posted(fetch)).toEqual([]);
  });
  it("uses actual annual price, explicit click, owner-bound UUID, CSRF and a trusted redirect", async () => {
    const fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        Response.json(
          url === "/api/billing"
            ? status()
            : {
                userId: "alice",
                url: "https://checkout.stripe.com/c/pay/cs_test_fixture",
              },
        ),
      ),
    );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" navigate={navigate} />);
    await checkoutButton();
    expect(posted(fetch)).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: /Ročne/ }));
    fireEvent.click(await checkoutButton());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_fixture",
      ),
    );
    const [url, init] = posted(fetch)[0];
    expect(url).toBe("/api/billing/checkout");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Token": "fixture-csrf" },
    });
    expect(JSON.parse(init.body)).toEqual({
      interval: "year",
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    const stored = JSON.parse(
      sessionStorage.getItem("billing-checkout:v1:alice")!,
    );
    expect(stored).toEqual({ version: 1, ...JSON.parse(init.body) });
    expect(Object.keys(stored).sort()).toEqual([
      "interval",
      "requestId",
      "version",
    ]);
  });
  it("reuses identical checkout after an uncertain response and reload, locking interval", async () => {
    let pending = false,
      attempts = 0;
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/billing")
        return Promise.resolve(
          Response.json(status({ pendingCheckout: pending })),
        );
      pending = true;
      attempts++;
      return attempts === 1
        ? Promise.reject(new TypeError("connection lost"))
        : Promise.resolve(
            Response.json({
              userId: "alice",
              url: "https://checkout.stripe.com/c/pay/recovered",
            }),
          );
    });
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let view = render(<BillingCard userId="alice" navigate={navigate} />);
    fireEvent.click(await checkoutButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "rovnakou požiadavkou",
    );
    const first = JSON.parse(posted(fetch)[0][1].body);
    view.unmount();
    view = render(<BillingCard userId="alice" navigate={navigate} />);
    const retry = await screen.findByRole("button", {
      name: "Pokračovať v Checkoute",
    });
    expect(screen.getByRole("radio", { name: /Ročne/ })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/recovered",
      ),
    );
    expect(JSON.parse(posted(fetch)[1][1].body)).toEqual(first);
    view.unmount();
  });
  it("starts a new checkout only after a definitive expiry response and an explicit refresh", async () => {
    let attempts = 0;
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/billing")
        return Promise.resolve(Response.json(status()));
      attempts++;
      return Promise.resolve(
        attempts === 1
          ? Response.json(
              { error: "billing_checkout_expired" },
              { status: 409 },
            )
          : Response.json({
              userId: "alice",
              url: "https://checkout.stripe.com/c/pay/new",
            }),
      );
    });
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" navigate={navigate} />);
    fireEvent.click(await checkoutButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("vypršal");
    expect(
      screen.queryByRole("button", { name: /Pokračovať.*Checkout/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Obnoviť predplatné" }));
    fireEvent.click(await checkoutButton());
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(JSON.parse(posted(fetch)[1][1].body).requestId).not.toBe(
      JSON.parse(posted(fetch)[0][1].body).requestId,
    );
  });
  it("offers explicit recovery in the original interval when another tab owns the server attempt", async () => {
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          Response.json(
            url === "/api/billing"
              ? status({ pendingCheckout: true })
              : {
                  userId: "alice",
                  url: "https://checkout.stripe.com/c/pay/existing",
                },
          ),
        ),
      );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" navigate={navigate} />);
    expect(
      await screen.findByText(/Zvoľ jeho pôvodný interval/),
    ).toBeInTheDocument();
    expect(posted(fetch)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Pokračovať v Checkoute" }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/existing",
      ),
    );
    expect(JSON.parse(posted(fetch)[0][1].body).interval).toBe("month");
  });
  it("keeps plan changes on the server and opens portal only after an explicit action", async () => {
    const fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        Response.json(
          url === "/api/billing"
            ? status({
                plan: "pro",
                checkoutAvailable: false,
                portalAvailable: true,
                subscription: {
                  status: "active",
                  interval: "month",
                  periodEnd: "2026-12-01T00:00:00.000Z",
                  cancelAtPeriodEnd: true,
                },
              })
            : {
                userId: "alice",
                url: "https://billing.stripe.com/p/session/fixture",
              },
        ),
      ),
    );
    const navigate = vi.fn(),
      refresh = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <BillingCard
        userId="alice"
        navigate={navigate}
        onRefreshQuota={refresh}
      />,
    );
    expect(await screen.findByText("Forge Pro")).toBeInTheDocument();
    expect(screen.getByText(/bez ďalšieho obnovenia/)).toBeInTheDocument();
    expect(posted(fetch)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Spravovať testovacie predplatné" }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://billing.stripe.com/p/session/fixture",
      ),
    );
    expect(posted(fetch)[0][0]).toBe("/api/billing/portal");
    fireEvent.click(screen.getByRole("button", { name: "Obnoviť predplatné" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(await screen.findByText("Forge Pro")).toBeInTheDocument();
  });
  it("rejects wrong-owner status and permits safe explicit retry", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(status({ userId: "bob", plan: "pro" })),
      )
      .mockResolvedValueOnce(Response.json(status()));
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("neplatné");
    expect(screen.queryByText("Forge Pro")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Obnoviť predplatné" }));
    expect(await screen.findByText("Forge Free")).toBeInTheDocument();
  });
  it("clears previous UI immediately on account scope change and ignores late checkout", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation((url: string) =>
      url === "/api/billing"
        ? Promise.resolve(Response.json(status()))
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" navigate={navigate} />);
    fireEvent.click(await checkoutButton());
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => {
      selectDatabaseScope({ kind: "account", userId: "bob" });
    });
    expect(screen.queryByText("Forge Free")).not.toBeInTheDocument();
    await act(async () => {
      finish(
        Response.json({
          userId: "alice",
          url: "https://checkout.stripe.com/c/pay/late",
        }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("aktuálneho účtu");
  });
  it("does not navigate after unmount even if fetch ignores abort", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation((url: string) =>
      url === "/api/billing"
        ? Promise.resolve(Response.json(status()))
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    );
    const navigate = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const view = render(<BillingCard userId="alice" navigate={navigate} />);
    fireEvent.click(await checkoutButton());
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.unmount();
    await act(async () => {
      finish(
        Response.json({
          userId: "alice",
          url: "https://checkout.stripe.com/c/pay/late",
        }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(posted(fetch)[0][1].signal.aborted).toBe(true);
  });
  it.each([
    "https://checkout.stripe.com.attacker.test/pay",
    "https://attacker.test/checkout.stripe.com",
    "http://checkout.stripe.com/pay",
    "https://user:secret@checkout.stripe.com/pay",
    "https://billing.stripe.com:8443/pay",
    "javascript:alert(1)",
  ])(
    "refuses redirect outside the exact HTTPS Stripe origin: %s",
    async (url) => {
      const fetch = vi
        .fn()
        .mockImplementation((path: string) =>
          Promise.resolve(
            Response.json(
              path === "/api/billing" ? status() : { userId: "alice", url },
            ),
          ),
        );
      const navigate = vi.fn();
      vi.stubGlobal("fetch", fetch);
      render(<BillingCard userId="alice" navigate={navigate} />);
      fireEvent.click(await checkoutButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Presmerovanie sa neuskutočnilo",
      );
      expect(navigate).not.toHaveBeenCalled();
    },
  );
  it("refuses checkout when CSRF is missing without sending POST", async () => {
    document.cookie = "lov_csrf=; Max-Age=0; Path=/";
    const fetch = vi.fn().mockResolvedValue(Response.json(status()));
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" />);
    fireEvent.click(await checkoutButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("reláciu");
    expect(posted(fetch)).toHaveLength(0);
  });
  it("does not POST when durable retry receipt cannot be stored", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(status()));
    vi.stubGlobal("fetch", fetch);
    render(<BillingCard userId="alice" />);
    await checkoutButton();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota");
    });
    fireEvent.click(await checkoutButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("nemôže uložiť");
    expect(posted(fetch)).toHaveLength(0);
  });
  it("keeps retry receipts separate for accounts and rejects A→B→A stale identity", () => {
    const alice = captureBillingIdentity("alice")!;
    const receipt = prepareCheckoutAttempt(alice, "month");
    selectDatabaseScope({ kind: "account", userId: "bob" });
    const bob = captureBillingIdentity("bob")!;
    const other = prepareCheckoutAttempt(bob, "year");
    expect(receipt.requestId).not.toBe(other.requestId);
    selectDatabaseScope({ kind: "account", userId: "alice" });
    expect(() => prepareCheckoutAttempt(alice, "month")).toThrow("stale");
    expect(
      prepareCheckoutAttempt(captureBillingIdentity("alice")!, "month"),
    ).toEqual(receipt);
  });
  it("accepts only the documented exact Stripe origins", () => {
    expect(
      trustedBillingUrl("https://checkout.stripe.com/c/pay/fixture#client"),
    ).toBe("https://checkout.stripe.com/c/pay/fixture#client");
    expect(
      trustedBillingUrl("https://billing.stripe.com/p/session/fixture"),
    ).toBe("https://billing.stripe.com/p/session/fixture");
  });
});
