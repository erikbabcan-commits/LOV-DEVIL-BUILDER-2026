import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { X, RefreshCw } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { honoFetch } from "@/lib/hono-client";
import {
  mapMe,
  mapReady,
  type HonoAccount,
  type HonoAccountInfo,
  type HonoReach,
} from "@/lib/auth-state";
import { AiUsageSchema, type AiUsage } from "@/lib/ai-usage";
import { Btn } from "./ui";
import { AccountDataExport } from "./AccountDataExport";
import { AccountClosure } from "./AccountClosure";
const BillingPanel = lazy(() =>
  import("./BillingPanel").then((module) => ({ default: module.BillingPanel })),
);

const REACH: Record<HonoReach, string> = {
  ok: "Dostupný",
  "not-configured": "Nenakonfigurovaný",
  "basic-auth": "Chránený Basic Auth – nepripravený",
  unreachable: "Nedostupný",
  timeout: "Časový limit",
  error: "Chyba",
  "signed-out": "Vyžaduje prihlásenie",
};
const ACCOUNT: Record<HonoAccount, string> = {
  linked: "Prepojený",
  "auth-incomplete": "Prihlásenie, prepojenie alebo transportné overenie neúplné",
  "identity-unavailable": "Identity DB nedostupná",
  "not-configured": "Nenakonfigurovaný",
  unreachable: "Nedostupný",
  error: "Chyba",
  "signed-out": "Vyžaduje prihlásenie",
};

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={good ? "text-success" : "text-secondary-foreground"}>{value}</span>
    </div>
  );
}

export function ConnectionPanel({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const [reach, setReach] = useState<HonoReach | null>(null);
  const [storedAccount, setStoredAccount] = useState<{
    ownerId: string | null;
    info: HonoAccountInfo;
  } | null>(null);
  const [storedUsage, setStoredUsage] = useState<{ ownerId: string; data: AiUsage } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const userId = s.session?.user.id;
  const acct = storedAccount?.ownerId === (userId ?? null) ? storedAccount.info : null;

  const tokenUsage = storedUsage && storedUsage.ownerId === userId ? storedUsage.data : null;

  const check = useCallback(async () => {
    const revision = ++generation.current;
    pending.current?.abort();
    setStoredUsage(null);
    if (s.status !== "signed-in" || !userId) {
      setReach("signed-out");
      setStoredAccount({ ownerId: userId ?? null, info: { state: "signed-out" } });
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setReach(null);
    setStoredAccount(null);
    const results = await Promise.allSettled([
      honoFetch("sandbox/ready", { signal: controller.signal }).then(mapReady),
      honoFetch("auth/me", { signal: controller.signal }).then(mapMe),
      honoFetch("ai-usage", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("usage_unavailable");
        return AiUsageSchema.parse(await response.json());
      }),
    ]);
    if (controller.signal.aborted || revision !== generation.current) return;
    setReach(results[0].status === "fulfilled" ? results[0].value : "unreachable");
    setStoredAccount({
      ownerId: userId,
      info: results[1].status === "fulfilled" ? results[1].value : { state: "unreachable" },
    });
    if (results[2].status === "fulfilled")
      setStoredUsage({ ownerId: userId, data: results[2].value });
    setBusy(false);
  }, [s.status, userId]);

  useEffect(() => {
    if (s.status !== "loading") void check();
    return () => {
      pending.current?.abort();
    };
  }, [s.status, check]);

  return (
    <div
      role="dialog"
      aria-labelledby="conn-title"
      className="absolute right-2 top-12 z-50 w-[min(340px,calc(100vw-16px))] max-h-[calc(100dvh-84px)] overflow-y-auto rounded-xl border border-border bg-popover p-4 shadow-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 id="conn-title" className="text-[14px] font-semibold">
          Účet a pripojenie
        </h2>
        <Btn size="icon" variant="ghost" aria-label="Zavrieť" onClick={onClose}>
          <X className="h-4 w-4" />
        </Btn>
      </div>
      <div className="divide-y divide-border">
        <Row
          label="Cloud login"
          value={
            s.status === "signed-in"
              ? `Prihlásený${s.email ? ` (${s.email})` : ""}`
              : s.status === "loading"
                ? "…"
                : "Neprihlásený"
          }
          good={s.status === "signed-in"}
        />
        <Row label="Hono dostupnosť" value={reach ? REACH[reach] : "…"} good={reach === "ok"} />
        <Row
          label="Hono účet"
          value={acct ? ACCOUNT[acct.state] + (acct.plan ? ` (${acct.plan})` : "") : "…"}
          good={acct?.state === "linked"}
        />
      </div>
      {acct?.state === "linked" && (
        <section
          className="mt-3 rounded-lg border border-border p-3 text-[12px]"
          aria-label="Spotreba AI účtu"
        >
          {acct.quota ? (
            <>
              <p className="mb-2 font-medium">
                AI úlohy tento mesiac: {acct.quota.used} / {acct.quota.limit} · zostáva{" "}
                {acct.quota.remaining}
              </p>
              <progress
                aria-label="Mesačný limit AI"
                value={Math.min(acct.quota.used, acct.quota.limit)}
                max={acct.quota.limit}
                className="h-1.5 w-full accent-primary"
              />
              <p className="mt-2 text-muted-foreground">
                Otázky, generovanie aj AI opravy vrátane neúspešných a zrušených úloh. Obnova limitu
                na začiatku mesiaca v UTC.
              </p>
              {acct.quota.used >= acct.quota.limit * 0.8 && (
                <p role="status" className="mt-2">
                  {acct.quota.remaining === 0
                    ? "Mesačný limit AI je vyčerpaný."
                    : "Blížiš sa k mesačnému limitu AI."}{" "}
                  Lokálna práca a export zostávajú dostupné.
                </p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              Spotrebu AI sa nepodarilo načítať. Skús overenie znova.
            </p>
          )}
          <div className="mt-3 border-t border-border pt-3" aria-label="Spotreba AI tokenov">
            {tokenUsage ? (
              <>
                <p className="font-medium">
                  {(tokenUsage.promptTokens + tokenUsage.completionTokens).toLocaleString("sk-SK")}{" "}
                  nahlásených tokenov
                </p>
                <p className="mt-1 text-muted-foreground">
                  {tokenUsage.promptTokens.toLocaleString("sk-SK")} vstupných ·{" "}
                  {tokenUsage.completionTokens.toLocaleString("sk-SK")} výstupných
                </p>
                <p className="mt-1 text-muted-foreground">
                  Spotreba známa pri {tokenUsage.reportedCalls} z {tokenUsage.calls} volaní. Jedna
                  úloha môže zahŕňať viac volaní. Tento mesiac v UTC, od zapnutia merania.
                </p>
                {tokenUsage.unknownCalls > 0 && (
                  <p role="status" className="mt-2">
                    Počet volaní bez údajov o spotrebe: {tokenUsage.unknownCalls}. Súčet je neúplný.
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                Spotrebu tokenov sa nepodarilo načítať. Skús overenie znova.
              </p>
            )}
          </div>
        </section>
      )}
      {s.status === "signed-in" &&
        userId &&
        s.session?.access_token &&
        acct?.state === "linked" &&
        acct.userId && (
          <Suspense
            fallback={
              <p role="status" className="mt-3 text-[12px]">
                Načítavam predplatné…
              </p>
            }
          >
            <BillingPanel
              key={userId + ":" + acct.userId}
              cloudUserId={userId}
              honoUserId={acct.userId}
              accessToken={s.session.access_token}
            />
          </Suspense>
        )}
      {s.status === "signed-in" && userId && s.session?.access_token &&
        acct?.state === "linked" && acct.userId && (
          <Fragment key={userId + ":" + acct.userId}>
            <AccountDataExport
              cloudUserId={userId}
              honoUserId={acct.userId}
              accessToken={s.session.access_token}
            />
            <AccountClosure
              cloudUserId={userId}
              honoUserId={acct.userId}
              accessToken={s.session.access_token}
            />
          </Fragment>
        )}
      <div className="mt-3 flex justify-end gap-2">
        {s.status === "signed-out" ? (
          <Link
            to="/auth"
            className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground"
          >
            Prihlásiť sa
          </Link>
        ) : (
          <Btn size="sm" onClick={check} disabled={busy || s.status !== "signed-in"}>
            <RefreshCw className="h-3.5 w-3.5" /> Overiť znova
          </Btn>
        )}
      </div>
    </div>
  );
}
