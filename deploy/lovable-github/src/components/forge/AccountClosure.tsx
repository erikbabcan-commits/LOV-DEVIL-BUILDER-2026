import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { honoFetch } from "@/lib/hono-client";
import { Btn } from "./ui";

const ClosureStatus = z.discriminatedUnion("state", [
  z.object({ accountId: z.string(), state: z.literal("none") }),
  z.object({
    accountId: z.string(),
    state: z.literal("pending"),
    requestId: z.string().uuid(),
    eligibleAt: z.string().datetime(),
  }),
]);
const utc = new Intl.DateTimeFormat("sk-SK", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
type Action = "load" | "request" | "cancel";

export function AccountClosure({
  cloudUserId,
  honoUserId,
  accessToken,
}: {
  cloudUserId: string;
  honoUserId: string;
  accessToken: string;
}) {
  const [status, setStatus] = useState<z.infer<typeof ClosureStatus> | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef<AbortController | null>(null);
  const retryId = useRef<string | null>(null);
  useEffect(() => () => inFlight.current?.abort(), [cloudUserId, honoUserId, accessToken]);

  async function run(action: Action) {
    if (inFlight.current && !inFlight.current.signal.aborted) return;
    if (action === "request" && (status?.state !== "none" || !confirmed)) return;
    if (action === "cancel" && status?.state !== "pending") return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const requestId =
        action === "request"
          ? (retryId.current ??= crypto.randomUUID())
          : status?.state === "pending"
            ? status.requestId
            : undefined;
      const response = await honoFetch(
        action === "cancel" ? "account/closure/cancel" : "account/closure",
        {
          expectedUserId: cloudUserId,
          expectedAccessToken: accessToken,
          signal: controller.signal,
          ...(action === "load"
            ? {}
            : {
                method: "POST",
                body: action === "request" ? { requestId, confirmed: true } : { requestId },
              }),
        },
      );
      if (!response.ok) throw new Error("closure_unavailable");
      const result = ClosureStatus.parse(await response.json());
      controller.signal.throwIfAborted();
      if (result.accountId !== honoUserId) throw new Error("closure_account_mismatch");
      setStatus(result);
      setConfirmed(false);
      if (action === "request") {
        retryId.current = null;
        setNotice(
          result.state === "pending" ? "Žiadosť bola zaevidovaná." : "Žiadosť už bola odvolaná.",
        );
      }
      if (action === "cancel" && result.state === "none") setNotice("Žiadosť bola odvolaná.");
    } catch {
      if (!controller.signal.aborted) setError("Žiadosť sa nepodarilo overiť. Skús to znova.");
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <details
      className="mt-3 rounded-lg border border-border p-3 text-[12px]"
      onToggle={(event) => {
        if (event.currentTarget.open) void run("load");
      }}
    >
      <summary className="cursor-pointer font-medium">Zrušenie účtu</summary>
      <p className="mt-2 text-muted-foreground">
        Po podaní máš najmenej 30 dní na odvolanie. Dovtedy môžeš ďalej pracovať a stiahnuť si
        údaje.
      </p>
      {busy && (
        <p className="mt-2 text-muted-foreground" role="status">
          Overujem stav žiadosti…
        </p>
      )}
      {status?.state === "pending" && (
        <>
          <p className="mt-2 font-medium">Žiadosť čaká na spracovanie</p>
          <p className="text-muted-foreground">
            Najskôr {utc.format(new Date(status.eligibleAt))} UTC.
          </p>
          <Btn
            className="mt-2"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => void run("cancel")}
          >
            Odvolať žiadosť
          </Btn>
        </>
      )}
      {status?.state === "none" && (
        <>
          <label className="mt-3 flex items-start gap-2">
            <input
              className="mt-0.5 accent-primary"
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Rozumiem, že žiadam o zrušenie účtu.
          </label>
          <Btn
            className="mt-2"
            size="sm"
            type="button"
            variant="danger"
            disabled={busy || !confirmed}
            onClick={() => void run("request")}
          >
            Podať žiadosť
          </Btn>
        </>
      )}
      {notice && (
        <p className="mt-2 text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="mt-2">
          <p className="text-destructive" role="alert">
            {error}
          </p>
          <Btn
            className="mt-2"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => void run("load")}
          >
            Overiť stav
          </Btn>
        </div>
      )}
    </details>
  );
}
