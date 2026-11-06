import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BillingInterval, BillingStatus } from "../../../shared/billing";
import {
  persistenceScope,
  subscribePersistenceScope,
} from "../../services/persistence/db";
import {
  BillingApiError,
  billingApi,
  captureBillingIdentity,
  clearCheckoutAttempt,
  matchesBillingIdentity,
  prepareCheckoutAttempt,
  readCheckoutAttempt,
  type BillingIdentity,
  type CheckoutAttempt,
} from "../../services/billing";

const navigateToStripe = (url: string) => {
  window.location.assign(url);
};
const messages: Record<string, string> = {
  billing_reconciliation_required:
    "Výsledok predchádzajúcej operácie musí overiť podpora. Novú platbu nezačínaj; zachovaj pôvodnú požiadavku.",
  billing_configuration_changed:
    "Nastavenie predplatného sa zmenilo. Obnov stav a kontaktuj podporu pred ďalším pokračovaním.",
  billing_price_unavailable:
    "Cenu sa nepodarilo potvrdiť. Platba sa nezačala; obnov stav alebo kontaktuj podporu.",
  network:
    "Spojenie sa prerušilo. Checkout už mohol vzniknúť; pokračuj rovnakou požiadavkou.",
  billing_checkout_pending:
    "Checkout už je rozpracovaný v inom intervale. Pokračuj v pôvodnej požiadavke.",
  billing_provider_unavailable:
    "Spojenie so Stripe sa prerušilo. Checkout už mohol vzniknúť; pokračuj rovnakou požiadavkou.",
  billing_subscription_exists:
    "Predplatné už existuje. Obnov stav a použi správu predplatného.",
  billing_pending:
    "Checkout už je rozpracovaný. Pokračuj v pôvodnej požiadavke.",
  billing_conflict:
    "Predplatné alebo Checkout sa medzičasom zmenili. Obnov jeho stav.",
  billing_disabled:
    "Platby ešte nie sú spustené. Na projekte môžeš ďalej pracovať.",
  billing_checkout_expired:
    "Predchádzajúci Checkout už vypršal. Obnov stav predplatného a začni znova.",
  login_required: "Relácia vypršala. Znovu sa prihlás.",
  csrf_required:
    "Platobnú reláciu sa nepodarilo overiť. Obnov stránku a prihlásenie.",
  rate_limit: "Priveľa požiadaviek. Skús to o chvíľu znova.",
  storage:
    "Prehliadač nemôže uložiť identifikátor Checkoutu. Povoľ úložisko tejto stránky a skús to znova.",
  interval_locked: "Najprv dokonči rozpracovaný Checkout v pôvodnom intervale.",
  protocol:
    "Server vrátil neplatné platobné údaje. Presmerovanie sa neuskutočnilo.",
};
const statusLabels: Record<string, string> = {
  active: "Aktívne",
  trialing: "Skúšobná doba",
  canceled: "Ukončené",
  past_due: "Platba mešká",
  unpaid: "Nezaplatené",
  incomplete: "Čaká na dokončenie",
  incomplete_expired: "Nedokončené",
  paused: "Pozastavené",
};
function money(amount: number) {
  return new Intl.NumberFormat("sk-SK", {
    style: "currency",
    currency: "EUR",
  }).format(amount / 100);
}
export function BillingCard({
  userId,
  onRefreshQuota,
  navigate = navigateToStripe,
}: {
  userId: string;
  onRefreshQuota?: () => void;
  navigate?: (url: string) => void;
}) {
  const epoch = useSyncExternalStore(
    subscribePersistenceScope,
    () => persistenceScope().epoch,
  );
  const databaseName = persistenceScope().databaseName;
  const identity = useMemo(() => {
    const captured = captureBillingIdentity(userId);
    return captured &&
      captured.databaseName === databaseName &&
      captured.epoch === epoch
      ? captured
      : null;
  }, [userId, epoch, databaseName]);
  if (!identity)
    return (
      <section className="project-storage billing-card" aria-label="Predplatné">
        <p role="status">Overujem plán aktuálneho účtu…</p>
      </section>
    );
  return (
    <BillingSession
      key={userId + ":" + epoch}
      identity={identity}
      onRefreshQuota={onRefreshQuota}
      navigate={navigate}
    />
  );
}
function BillingSession({
  identity,
  onRefreshQuota,
  navigate,
}: {
  identity: BillingIdentity;
  onRefreshQuota?: () => void;
  navigate: (url: string) => void;
}) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(() => {
    try {
      return readCheckoutAttempt(identity);
    } catch {
      return null;
    }
  });
  const [interval, setInterval] = useState<BillingInterval>(
    attempt?.interval ?? "month",
  );
  const current = useRef({
    alive: false,
    request: 0,
    pending: null as AbortController | null,
    operation: null as AbortController | null,
  });
  const verifiedModeRef = useRef<"sandbox" | "live" | null>(null);
  const quotaCallback = useRef(onRefreshQuota);
  useEffect(() => {
    quotaCallback.current = onRefreshQuota;
  }, [onRefreshQuota]);
  const refresh = useCallback(async () => {
    const state = current.current;
    state.pending?.abort();
    const controller = new AbortController(),
      request = ++state.request;
    state.pending = controller;
    setLoading(true);
    setError("");
    setStatus(null);
    try {
      const result = await billingApi.status(identity, controller.signal);
      if (
        !state.alive ||
        controller.signal.aborted ||
        request !== state.request ||
        !matchesBillingIdentity(identity)
      )
        return;
      setStatus(result);
      const verifiedMode = result.mode === "live" ? "live" : "sandbox";
      const scopedAttempt = readCheckoutAttempt(identity, verifiedMode);
      setAttempt(scopedAttempt);
      if (scopedAttempt || verifiedModeRef.current !== verifiedMode) setInterval(scopedAttempt?.interval ?? "month");
      verifiedModeRef.current = verifiedMode;
      // A verified active entitlement without a pending checkout ends the old retry receipt.
      if (result.plan === "pro" && !result.pendingCheckout) {
        try {
          clearCheckoutAttempt(identity, result.mode === "live" ? "live" : "sandbox");
          setAttempt(null);
        } catch {
          /* Existing receipt is harmless and remains owner scoped. */
        }
      }
    } catch (reason) {
      if (
        state.alive &&
        !controller.signal.aborted &&
        request === state.request &&
        matchesBillingIdentity(identity)
      ) {
        const code = reason instanceof BillingApiError ? reason.code : "";
        setError(
          messages[code] ??
            "Predplatné sa nepodarilo overiť. Skús obnoviť stav.",
        );
      }
    } finally {
      if (
        state.alive &&
        request === state.request &&
        matchesBillingIdentity(identity)
      )
        setLoading(false);
    }
  }, [identity]);
  useEffect(() => {
    const state = current.current;
    state.alive = true;
    void refresh();
    const focus = () => {
      if (!state.operation) void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      state.alive = false;
      state.request++;
      state.pending?.abort();
      state.operation?.abort();
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  async function act(kind: "checkout" | "portal") {
    const state = current.current;
    if (
      state.operation ||
      !status ||
      loading ||
      !matchesBillingIdentity(identity)
    )
      return;
    const controller = new AbortController();
    state.operation = controller;
    setBusy(true);
    setError("");
    try {
      let url: string;
      if (kind === "checkout") {
        const receipt = prepareCheckoutAttempt(
          identity,
          attempt?.interval ?? interval,
          status.mode === "live" ? "live" : "sandbox",
        );
        setAttempt(receipt);
        setInterval(receipt.interval);
        url = await billingApi.checkout(identity, receipt, controller.signal);
      } else
        url = await billingApi.portal(
          identity,
          crypto.randomUUID(),
          controller.signal,
        );
      if (
        state.alive &&
        !controller.signal.aborted &&
        matchesBillingIdentity(identity)
      )
        navigate(url);
    } catch (reason) {
      if (
        state.alive &&
        !controller.signal.aborted &&
        matchesBillingIdentity(identity)
      ) {
        const code = reason instanceof BillingApiError ? reason.code : "";
        if (code === "billing_checkout_expired") {
          try {
            clearCheckoutAttempt(identity, status.mode === "live" ? "live" : "sandbox");
            setAttempt(null);
            setStatus(null);
          } catch {
            /* Do not replace an unknown receipt when storage is unavailable. */
          }
        }
        setError(
          messages[code] ??
            "Platobnú stránku sa nepodarilo pripraviť. Plán sa týmto nemení.",
        );
      }
    } finally {
      if (state.operation === controller) state.operation = null;
      if (state.alive && matchesBillingIdentity(identity)) setBusy(false);
    }
  }
  const price = status?.prices[attempt?.interval ?? interval];
  const canRetry = !!attempt && status?.pendingCheckout;
  return (
    <section
      className="project-storage billing-card"
      aria-label="Predplatné"
      aria-busy={loading || busy}
    >
      <div className="billing-card-head">
        <h3>Predplatné</h3>
        {status?.enabled && (
          <span className="billing-sandbox">{status.mode === "live" ? "Platby cez Stripe" : "Testovací režim Stripe"}</span>
        )}
      </div>
      {loading ? (
        <p role="status">Overujem predplatné…</p>
      ) : status ? (
        <>
          <p className="billing-plan">
            <b>{status.plan === "pro" ? "Forge Pro" : "Forge Free"}</b>
            <span>{status.plan === "pro" ? "200" : "10"} AI úloh mesačne</span>
          </p>
          {status.subscription && (
            <p>
              {statusLabels[status.subscription.status]}
              {status.subscription.periodEnd
                ? " · do " +
                  new Date(status.subscription.periodEnd).toLocaleDateString(
                    "sk-SK",
                  )
                : ""}
              {status.subscription.cancelAtPeriodEnd
                ? " · bez ďalšieho obnovenia"
                : ""}
            </p>
          )}
          {!status.enabled ? (
            <p>
              Platby ešte nie sú spustené. Tvoj overený plán zostáva uvedený
              vyššie.
            </p>
          ) : (
            <>
              <p className="billing-note">
                {status.mode === "live"
                  ? "Predplatné sa aktivuje až po overení platby serverom. Návrat z Checkoutu sám nemení plán."
                  : "Testovacie platby nemenia živý účet. Aktivácia sa zobrazí až po overení predplatného."}
              </p>
              {status.pendingCheckout && (
                <p role="status">
                  {attempt
                    ? "Máš rozpracovaný Checkout. Pokračovanie použije rovnakú požiadavku."
                    : "Checkout už je rozpracovaný. Zvoľ jeho pôvodný interval; server obnoví rovnaký Checkout. Ak interval nepoznáš, použi pôvodnú kartu."}
                </p>
              )}
              {(status.checkoutAvailable || canRetry) && (
                <>
                  <fieldset
                    className="billing-interval"
                    disabled={busy || !!attempt}
                  >
                    <legend>Interval Pro predplatného</legend>
                    <label>
                      <input
                        type="radio"
                        name={"billing-interval-" + identity.epoch}
                        checked={interval === "month"}
                        onChange={() => setInterval("month")}
                      />
                      Mesačne
                      {status.prices.month
                        ? " · " + money(status.prices.month.amount)
                        : ""}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={"billing-interval-" + identity.epoch}
                        checked={interval === "year"}
                        onChange={() => setInterval("year")}
                      />
                      Ročne
                      {status.prices.year
                        ? " · " + money(status.prices.year.amount)
                        : ""}
                    </label>
                  </fieldset>
                  <p>
                    {price
                      ? money(price.amount) +
                        (interval === "year" ? " / rok" : " / mesiac")
                      : "Cenu sa nepodarilo overiť."}{" "}
                    · Prípadnú 14-dňovú skúšobnú dobu potvrdí Checkout.
                  </p>
                  <small>Konečnú cenu a prípadné dane zobrazí Stripe Checkout.</small>
                  <button
                    className="billing-primary"
                    disabled={busy || !price}
                    onClick={() => void act("checkout")}
                  >
                    {busy
                      ? "Pripravujem Stripe…"
                      : attempt || status.pendingCheckout
                        ? "Pokračovať v Checkoute"
                        : status.mode === "live" ? "Pokračovať do Checkoutu" : "Pokračovať do testovacieho Checkoutu"}
                  </button>
                </>
              )}
              {status.portalAvailable && (
                <button disabled={busy} onClick={() => void act("portal")}>
                  {status.mode === "live" ? "Spravovať predplatné" : "Spravovať testovacie predplatné"}
                </button>
              )}
              {!status.checkoutAvailable &&
                !status.portalAvailable &&
                !status.pendingCheckout && (
                  <p>
                    Platobné akcie teraz nie sú dostupné. Obnov stav alebo
                    kontaktuj podporu.
                  </p>
                )}
            </>
          )}
        </>
      ) : null}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={loading || busy}
        onClick={() => {
          quotaCallback.current?.();
          void refresh();
        }}
      >
        Obnoviť predplatné
      </button>
      <small>
        Limity sa týkajú AI úloh. Lokálne úpravy a export nečerpajú AI limit.
      </small>
    </section>
  );
}
