export { captureGitHubCallback } from "../../src/lib/github-client";
export type { GitHubStatus } from "../../src/lib/github-client";
export async function githubRequest(action: string) {
  const scenario = new URL(window.location.href).searchParams.get("scenario");
  if (scenario === "error") throw new Error("GitHub prepojenie momentálne nie je dostupné.");
  if (action === "status") return scenario === "connected" ? { connected: true, username: "dlhy-testovaci-github-ucet-12345678901234", githubId: 42, scopes: ["public_repo"] } : { connected: false };
  if (action === "start") return { authorizationUrl: `${window.location.origin}/qa/github/index.html?view=callback&state=${"ab".repeat(32)}&code=synthetic-code` };
  return { ok: true };
}
