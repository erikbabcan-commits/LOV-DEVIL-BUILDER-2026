import { AgentEventSchema, type AgentEvent } from "./forge-events";
export type ForgeTransport = (
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
) => Promise<Response>;
const errors: Record<string, string> = {
  quota_exceeded:
    "Vyčerpal si mesačný AI limit. Lokálne úpravy a uložené projekty zostávajú dostupné.",
  project_conflict:
    "Server už obsahuje novšie zmeny. Tvoja lokálna verzia zostala zachovaná; načítaj serverovú verziu alebo ulož kópiu.",
  context_limit:
    "Celý projekt je pre tento model priveľký. Vyber väčší kontext alebo zmenši projekt.",
  invalid_model: "Model alebo záložné modely sa zmenili. Obnov ponuku a vyber znova.",
  hono_not_configured: "Prepojenie backendu ešte nie je aktívne. Skontroluj panel pripojenia.",
  secret_in_context: "Požiadavka obsahuje možné prihlasovacie údaje. Odstráň ich pred odoslaním.",
  storage_quota_exceeded: "Serverové úložisko je plné. Lokálna kópia zostala zachovaná.",
};
export async function checkedResponse(response: Response) {
  if (response.ok) return response;
  const value: unknown = await response.json().catch(() => null),
    code =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : "";
  throw new Error(
    errors[code] ??
      (response.status === 401
        ? "Prihlás sa a over prepojenie účtu v paneli backendov."
        : response.status === 429
          ? "Služba práve dosiahla limit. Skús to neskôr."
          : "Backend teraz nie je dostupný. Tvoja práca zostala zachovaná."),
  );
}
export async function* agentEvents(
  transport: ForgeTransport,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const response = await checkedResponse(
    await transport("agent/generate", { method: "POST", body, signal }),
  );
  if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body)
    throw new Error("AI prenos sa nezačal. Projekt sa nezmenil.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done)
        throw new Error("AI prenos sa prerušil pred dokončením. Projekt sa nezmenil.");
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error("AI odpoveď prekročila limit.");
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          throw new Error("AI prenos má neplatný formát.");
        }
        const parsed = AgentEventSchema.safeParse(value);
        if (!parsed.success) throw new Error("AI prenos má neplatný formát.");
        yield parsed.data;
        if (["done", "error", "cancelled"].includes(parsed.data.type)) return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
