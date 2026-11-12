import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { z } from "zod";
import { honoFetch } from "@/lib/hono-client";
import { Btn } from "./ui";

const sections = {
  profile: "Profil, prepojenia a plán",
  projects: "Projekty a verzie vrátane koša",
  auth: "Prihlásenia v Hono",
  ai: "História spotreby AI",
  publish: "Publikácie",
  github: "Exporty do GitHubu",
  billing: "Udalosti predplatného",
  closure: "Žiadosti o zrušenie účtu",
} as const;
type Section = keyof typeof sections;

const ExportPage = z.object({
  version: z.literal(1),
  accountId: z.string(),
  section: z.string(),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/)
    .nullable(),
  records: z.array(z.record(z.string(), z.unknown())),
});

function downloadPage(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function AccountDataExport({
  cloudUserId,
  honoUserId,
  accessToken,
}: {
  cloudUserId: string;
  honoUserId: string;
  accessToken: string;
}) {
  const [section, setSection] = useState<Section>("profile");
  const [page, setPage] = useState<{ number: number; cursor: string | null }>({
    number: 1,
    cursor: null,
  });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [cloudUserId, honoUserId, accessToken]);

  async function download() {
    if (pending.current && !pending.current.signal.aborted) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await honoFetch(
        `account/export/${section}${page.cursor ? "/" + page.cursor : ""}`,
        {
          expectedUserId: cloudUserId,
          expectedAccessToken: accessToken,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const detail =
          response.status === 429
            ? "Limit exportu bol dosiahnutý. Skús znova o minútu."
            : response.status === 401
              ? "Over prihlásenie a skús stiahnutie znova."
              : "Údaje sa nepodarilo stiahnuť. Skús to znova.";
        if (!controller.signal.aborted) setError(detail);
        return;
      }
      const text = await response.text();
      const data = ExportPage.parse(JSON.parse(text));
      controller.signal.throwIfAborted();
      if (
        data.accountId !== honoUserId ||
        data.section !== section ||
        (data.nextCursor !== null && (!data.records.length || data.nextCursor === page.cursor))
      )
        throw new Error("invalid_account_export");
      if (data.records.length) downloadPage(text, `vorkei-${section}-${page.number}.json`);
      setStatus(
        data.nextCursor
          ? `Časť ${page.number} je pripravená. Dostupná je aj ďalšia časť.`
          : data.records.length
            ? "Posledná časť je pripravená."
            : "V tejto časti už nie sú ďalšie údaje.",
      );
      setPage(
        data.nextCursor
          ? { number: page.number + 1, cursor: data.nextCursor }
          : { number: 1, cursor: null },
      );
    } catch {
      if (!controller.signal.aborted) setError("Údaje sa nepodarilo stiahnuť. Skús to znova.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <details className="mt-3 rounded-lg border border-border p-3 text-[12px]">
      <summary className="cursor-pointer font-medium">Údaje účtu</summary>
      <p className="mt-2 text-muted-foreground">Stiahni údaje uložené vo VORKEI vo formáte JSON.</p>
      <label className="mt-3 block">
        Časť exportu
        <select
          className="mt-1 block h-9 w-full rounded-md border border-border bg-card px-2"
          value={section}
          disabled={busy}
          onChange={(event) => {
            setSection(event.target.value as Section);
            setPage({ number: 1, cursor: null });
            setStatus("");
            setError("");
          }}
        >
          {Object.entries(sections).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Btn className="mt-2" type="button" size="sm" disabled={busy} onClick={() => void download()}>
        <Download aria-hidden="true" className="size-3.5" />
        {busy ? "Pripravujem údaje…" : page.cursor ? "Stiahnuť ďalšiu časť" : "Stiahnuť JSON"}
      </Btn>
      {status && (
        <p className="mt-2 text-muted-foreground" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="mt-2 text-destructive" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
