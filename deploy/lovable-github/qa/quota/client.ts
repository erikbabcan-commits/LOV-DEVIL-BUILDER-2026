import { currentFixtureUser } from "./session";
/** Synthetic loopback rendering fixture. No requests or production credentials. */
export function honoFetch(path: string, init: { signal?: AbortSignal } = {}): Promise<Response> {
  const user = currentFixtureUser(),
    full = new URL(location.href).searchParams.has("full");
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(
      () => {
        init.signal?.removeEventListener("abort", abort);
        if (path === "sandbox/ready") return resolve(Response.json({ ready: true }));
        if (path === "ai-usage")
          return resolve(
            Response.json({
              periodStart: "2026-11-01",
              periodEnd: "2026-12-01",
              calls: user === "alice" ? 5 : 0,
              reportedCalls: user === "alice" ? 4 : 0,
              unknownCalls: user === "alice" ? 1 : 0,
              pendingCalls: 0,
              promptTokens: user === "alice" ? 13400 : 0,
              completionTokens: user === "alice" ? 3200 : 0,
            }),
          );
        if (path !== "auth/me") return reject(new Error("Unknown fixture path"));
        const used = user === "alice" ? (full ? 10 : 8) : 0,
          limit = user === "alice" ? 10 : 200;
        resolve(
          Response.json({
            user: { id: "internal-" + user, plan: user === "alice" ? "free" : "pro" },
            quota: {
              used,
              limit,
              remaining: limit - used,
              plan: user === "alice" ? "free" : "pro",
            },
          }),
        );
      },
      user === "alice" ? 250 : 30,
    );
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
  });
}
