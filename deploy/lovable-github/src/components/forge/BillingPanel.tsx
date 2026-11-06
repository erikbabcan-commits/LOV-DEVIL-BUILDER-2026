import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  BillingClientError,
  billingStatus,
  billingCheckout,
  billingPortal,
  checkoutReceipt,
  clearCheckoutReceipt,
  readCheckoutReceipt,
  type BillingScope,
  type BillingStatus,
  type BillingInterval,
  type CheckoutReceipt,
} from "@/lib/billing-client";
import { Btn } from "./ui";

const navigateToStripe = (url: string) => {
  window.location.assign(url);
};
const statusText: Record<string, string> = {
  active: "Aktívne",
  trialing: "Skúšobná doba",
  canceled: "Ukončené",
  past_due: "Platba mešká",
  unpaid: "Nezaplatené",
  incomplete: "Čaká na dokončenie",
  incomplete_expired: "Nedokončené",
  paused: "Pozastavené",
};
const errors: Record<string, string> = {
  network: "Spojenie sa prerušilo. Checkout už mohol vzniknúť; pokračuj rovnakou požiadavkou.",
  billing_provider_unavailable:
    "Stripe teraz neodpovedá. Checkout už mohol vzniknúť; pokračuj rovnakou požiadavkou.",
  billing_checkout_pending: "Checkout už čaká v inom intervale. Pokračuj v pôvodnej požiadavke.",
  billing_checkout_expired: "Predchádzajúci Checkout vypršal. Obnov stav pred ďalším pokusom.",
  billing_subscription_exists: "Predplatné už existuje. Obnov stav a použi správu predplatného.",
  billing_reconciliation_required:
    "Platobný stav vyžaduje kontrolu podpory. Ďalšiu platbu nezačínaj.",
  billing_configuration_changed:
    "Ponuka predplatného sa zmenila. Obnov stav; rozpracovaný Checkout potrebuje kontrolu podpory.",
  billing_price_unavailable:
    "Cenu teraz nemožno overiť. Platbu nezačínaj a skús obnoviť stav neskôr.",
  billing_disabled: "Platby ešte nie sú spustené. Na projekte môžeš ďalej pracovať.",
  unauthorized: "Prihlás sa znova a over prepojenie účtu.",
  unauthenticated: "Prihlás sa znova a over prepojenie účtu.",
  protocol: "Platobná odpoveď neprešla overením. Presmerovanie sa neuskutočnilo.",
  rate_limit: "Priveľa požiadaviek. Skús to o chvíľu znova.",
  storage:
    "Prehliadač nemôže uložiť identifikátor Checkoutu. Povoľ úložisko stránky a skús to znova.",
};
const price = (amount: number) =>
  new Intl.NumberFormat("sk-SK", { style: "currency", currency: "EUR" }).format(amount / 100);
export function BillingPanel({
  cloudUserId,
  honoUserId,
  accessToken,
  navigate = navigateToStripe,
}: {
  cloudUserId: string;
  honoUserId: string;
  accessToken: string;
  navigate?: (url: string) => void;
}) {
  const scope = useMemo<BillingScope>(
    () => ({ cloudUserId, honoUserId, token: accessToken }),
    [cloudUserId, honoUserId, accessToken],
  );
  const [epoch, setEpoch] = useState(0),
    authEpoch = useRef(0);
  const [record, setRecord] = useState<{
    scope: BillingScope;
    epoch: number;
    status: BillingStatus;
  } | null>(null);
  const [receipt, setReceipt] = useState<CheckoutReceipt | null>(null),
    [interval, setInterval] = useState<BillingInterval>("month");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const state = useRef({
    alive: false,
    scope,
    epoch: 0,
    operation: null as AbortController | null,
  });
  state.current.scope = scope;
  state.current.epoch = epoch;
  const current = useCallback(
    (captured = epoch) =>
      state.current.alive &&
      state.current.scope === scope &&
      captured === authEpoch.current &&
      captured === state.current.epoch,
    [scope, epoch],
  );
  const report = record?.scope === scope && record.epoch === epoch ? record.status : null;
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => {
      authEpoch.current++;
      state.current.operation?.abort();
      setEpoch(authEpoch.current);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    const ref = state.current;
    ref.alive = true;
    const controller = new AbortController(),
      captured = epoch;
    setLoading(true);
    setBusy(false);
    setError("");
    setRecord(null);
    setReceipt(null);
    void billingStatus(scope, controller.signal)
      .then((value) => {
        if (!current(captured) || controller.signal.aborted) return;
        setRecord({ scope, epoch: captured, status: value });
        try {
          if (value.plan === "pro" && !value.pendingCheckout) {
            clearCheckoutReceipt(scope, value.mode);
            setReceipt(null);
          } else {
            const saved = readCheckoutReceipt(scope, value.mode);
            setReceipt(saved);
            if (saved) setInterval(saved.interval);
          }
        } catch {
          setError(errors["storage"]!);
        }
      })
      .catch((reason) => {
        if (!current(captured) || controller.signal.aborted) return;
        const code = reason instanceof BillingClientError ? reason.code : "";
        if (code !== "stale")
          setError(errors[code] ?? "Predplatné sa nepodarilo načítať. Skús obnoviť stav.");
      })
      .finally(() => {
        if (current(captured)) setLoading(false);
      });
    return () => {
      ref.alive = false;
      controller.abort();
      ref.operation?.abort();
      ref.operation = null;
    };
  }, [scope, epoch, revision, current]);
  useEffect(() => {
    const focus = () => {
      if (!state.current.operation) setRevision((value) => value + 1);
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  async function open(kind: "checkout" | "portal") {
    if (!report || loading || !current() || state.current.operation) return;
    const captured = epoch,
      controller = new AbortController(),
      mode = report.mode;
    state.current.operation = controller;
    setBusy(true);
    setError("");
    try {
      let target: string;
      if (kind === "checkout") {
        const saved = checkoutReceipt(scope, mode, receipt?.interval ?? interval);
        setReceipt(saved);
        setInterval(saved.interval);
        target = await billingCheckout(scope, saved, controller.signal);
      } else target = await billingPortal(scope, crypto.randomUUID(), controller.signal);
      if (current(captured) && !controller.signal.aborted) navigate(target);
    } catch (reason) {
      if (!current(captured) || controller.signal.aborted) return;
      const code = reason instanceof BillingClientError ? reason.code : "";
      if (code === "billing_checkout_expired") {
        try {
          clearCheckoutReceipt(scope, mode);
          setReceipt(null);
          setRecord(null);
        } catch {
          /* Keep uncertain recovery state. */
        }
      }
      if (code !== "stale")
        setError(
          errors[code] ??
            "Platobnú stránku sa nepodarilo pripraviť. Plán zostáva overený serverom.",
        );
    } finally {
      if (state.current.operation === controller) state.current.operation = null;
      if (current(captured)) setBusy(false);
    }
  }
  const selected = receipt?.interval ?? interval,
    selectedPrice = report?.prices[selected];
  return (
    <section
      className="mt-3 min-w-0 rounded-lg border border-border p-3 text-[12px] [overflow-wrap:anywhere]"
      aria-label="Predplatné"
      aria-busy={loading || busy}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Predplatné</h3>
        {report?.enabled && (
          <span
            className={
              "rounded border px-1.5 py-0.5 text-[10px] " +
              (report.mode === "live"
                ? "border-primary text-primary-text"
                : "border-border text-muted-foreground")
            }
          >
            {report.mode === "live" ? "Živé platby Stripe" : "Testovací režim Stripe"}
          </span>
        )}
      </div>
      {loading ? (
        <p role="status">Overujem predplatné…</p>
      ) : report ? (
        <>
          <p className="font-medium">
            {report.plan === "pro" ? "Forge Pro" : "Forge Free"} ·{" "}
            {report.plan === "pro" ? 200 : 10} AI úloh mesačne
          </p>
          {report.subscription && (
            <p className="mt-1 text-muted-foreground">
              {statusText[report.subscription.status]}
              {report.subscription.periodEnd
                ? " · do " + new Date(report.subscription.periodEnd).toLocaleDateString("sk-SK")
                : ""}
              {report.subscription.cancelAtPeriodEnd ? " · bez ďalšieho obnovenia" : ""}
            </p>
          )}
          {!report.enabled ? (
            <p className="mt-2 text-muted-foreground">
              Platby ešte nie sú spustené. Na projekte môžeš ďalej pracovať.
            </p>
          ) : (
            <>
              <p className="mt-2 text-muted-foreground">
                {report.mode === "live"
                  ? "Pokračuješ na skutočnú platobnú stránku Stripe."
                  : "Testovacie platby nemenia živý účet."}{" "}
                Aktivácia sa zobrazí až po overení predplatného.
              </p>
              {report.pendingCheckout && (
                <p role="status" className="mt-2">
                  {receipt
                    ? "Rozpracovaný Checkout obnovíme rovnakou požiadavkou."
                    : "Checkout už je rozpracovaný. Vyber jeho pôvodný interval; server obnoví rovnaký Checkout. Ak ho nepoznáš, použi pôvodnú kartu."}
                </p>
              )}
              {(report.checkoutAvailable || (report.pendingCheckout && !!receipt)) && (
                <>
                  <fieldset
                    className="mt-3 flex min-w-0 flex-col gap-2 rounded border border-border p-2"
                    disabled={busy || !!receipt}
                  >
                    <legend className="px-1 text-muted-foreground">
                      Interval Pro predplatného
                    </legend>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={"billing-interval-" + cloudUserId}
                        checked={selected === "month"}
                        onChange={() => setInterval("month")}
                      />
                      Mesačne{report.prices.month ? " · " + price(report.prices.month.amount) : ""}
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={"billing-interval-" + cloudUserId}
                        checked={selected === "year"}
                        onChange={() => setInterval("year")}
                      />
                      Ročne{report.prices.year ? " · " + price(report.prices.year.amount) : ""}
                    </label>
                  </fieldset>
                  <p className="mt-2">
                    {selectedPrice
                      ? price(selectedPrice.amount) + (selected === "year" ? " / rok" : " / mesiac")
                      : "Cenu sa nepodarilo overiť."}{" "}
                    Prípadnú 14-dňovú skúšobnú dobu, konečnú cenu a dane potvrdí Stripe Checkout.
                  </p>
                  <Btn
                    className="mt-2 h-auto min-h-8 w-full whitespace-normal px-2 py-2"
                    variant="primary"
                    size="sm"
                    disabled={busy || !selectedPrice}
                    onClick={() => void open("checkout")}
                  >
                    {busy
                      ? "Pripravujem Stripe…"
                      : receipt || report.pendingCheckout
                        ? "Pokračovať v Checkoute"
                        : report.mode === "live"
                          ? "Pokračovať do Stripe Checkoutu"
                          : "Otvoriť testovací Checkout"}
                  </Btn>
                </>
              )}
              {report.portalAvailable && (
                <Btn
                  className="mt-2 h-auto min-h-8 w-full whitespace-normal px-2 py-2"
                  size="sm"
                  disabled={busy}
                  onClick={() => void open("portal")}
                >
                  {report.mode === "live"
                    ? "Spravovať predplatné"
                    : "Spravovať testovacie predplatné"}
                </Btn>
              )}
            </>
          )}
        </>
      ) : null}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      <Btn
        className="mt-3"
        size="sm"
        disabled={loading || busy}
        onClick={() => setRevision((value) => value + 1)}
      >
        Obnoviť predplatné
      </Btn>
    </section>
  );
}
