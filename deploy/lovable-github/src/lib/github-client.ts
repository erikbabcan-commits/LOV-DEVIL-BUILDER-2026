import { z } from "zod";

const connection = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    username: z.string(),
    githubId: z.number(),
    scopes: z.tuple([z.literal("public_repo")]),
  }),
]);
export type GitHubStatus = z.infer<typeof connection>;
export async function githubRequest(
  action: "start" | "finish" | "status" | "disconnect",
  token: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/github-connect/${action}`, {
    method: action === "status" ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(action === "status" ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? "Prepojenie vypršalo alebo patrí inému účtu. Začni znova v editore."
        : response.status === 401
          ? "Prihlás sa znova a zopakuj prepojenie."
          : "GitHub prepojenie momentálne nie je dostupné. Skús to znova.",
    );
  const data: unknown = await response.json();
  if (action === "status") return connection.parse(data);
  if (action === "start") {
    const parsed = z.object({ authorizationUrl: z.string().url() }).parse(data);
    const url = new URL(parsed.authorizationUrl);
    if (
      url.origin !== "https://github.com" ||
      url.pathname !== "/login/oauth/authorize" ||
      url.searchParams.get("scope") !== "public_repo"
    )
      throw new Error("Neplatná odpoveď prepojenia.");
    return parsed;
  }
  return z.object({ ok: z.literal(true) }).parse(data);
}

export function captureGitHubCallback(url: string): { state: string; code: string } | null {
  const query = new URL(url).searchParams;
  if (query.has("error") || query.getAll("state").length !== 1 || query.getAll("code").length !== 1)
    return null;
  const state = query.get("state") ?? "",
    code = query.get("code") ?? "";
  return /^[a-f0-9]{64}$/.test(state) && /^[A-Za-z0-9_-]{1,512}$/.test(code)
    ? { state, code }
    : null;
}
