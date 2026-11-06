import { afterEach, expect, it, vi } from "vitest";
import { captureGitHubCallback, githubRequest } from "./github-client";
afterEach(() => vi.unstubAllGlobals());
it("accepts a single callback pair and rejects duplicates or denied consent", () => {
  const state = "ab".repeat(32);
  expect(
    captureGitHubCallback(`https://lovable.test/github/callback?state=${state}&code=code`),
  ).toEqual({ state, code: "code" });
  expect(
    captureGitHubCallback(
      `https://lovable.test/github/callback?state=${state}&state=${state}&code=code`,
    ),
  ).toBeNull();
  expect(
    captureGitHubCallback(
      `https://lovable.test/github/callback?state=${state}&code=code&error=denied`,
    ),
  ).toBeNull();
});
it("uses same-origin cookies and only the Cloud Bearer, never infrastructure credentials", async () => {
  const api = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", api);
  await githubRequest("finish", "fixture-token", { state: "ab".repeat(32), code: "code" });
  expect(api.mock.calls[0]).toEqual([
    "/api/github-connect/finish",
    expect.objectContaining({
      credentials: "same-origin",
      method: "POST",
      headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
    }),
  ]);
});
it("rejects unsafe authorization URLs and does not expose provider error text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ authorizationUrl: "https://attacker.test/login" })),
  );
  await expect(githubRequest("start", "fixture", {})).rejects.toThrow("Neplatná odpoveď");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ secret: "provider-private-error" }, { status: 502 })),
  );
  await expect(githubRequest("start", "fixture", {})).rejects.toThrow("momentálne nie je dostupné");
});
