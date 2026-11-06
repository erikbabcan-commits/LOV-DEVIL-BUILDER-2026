import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { GitHubConnection } from "./GitHubConnection";
import { GitHubCallback } from "./GitHubCallback";
const mocks = vi.hoisted(() => ({ token: "alice", request: vi.fn() }));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({
    status: "signed-in",
    email: mocks.token + "@example.com",
    session: { access_token: mocks.token },
  }),
}));
vi.mock("@/lib/github-client", async (original) => ({
  ...(await original<typeof import("@/lib/github-client")>()),
  githubRequest: mocks.request,
}));
beforeEach(() => {
  mocks.token = "alice";
  mocks.request.mockReset();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

it("shows public-only connection status and disconnects only after confirmation", async () => {
  mocks.request.mockResolvedValue({
    connected: true,
    username: "alice-github",
    githubId: 42,
    scopes: ["public_repo"],
  });
  render(<GitHubConnection />);
  await screen.findByText("Pripojené: alice-github");
  expect(screen.getByText("Prístup iba k verejným repozitárom.")).toBeTruthy();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Odpojiť GitHub" }));
  expect(mocks.request).toHaveBeenCalledTimes(1);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Odpojiť GitHub" }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("disconnect", "alice", {}));
});
it("ignores a previous account's delayed status response", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ connected: false });
  const view = render(<GitHubConnection />);
  mocks.token = "bob";
  view.rerender(<GitHubConnection />);
  await screen.findByRole("button", { name: "Pripojiť GitHub" });
  await act(async () => resolve({ connected: true, username: "private-alice" }));
  expect(screen.queryByText(/private-alice/)).toBeNull();
});
it("provides a retry after a network failure", async () => {
  mocks.request.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ connected: false });
  render(<GitHubConnection />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Skúsiť znova" }));
  await screen.findByRole("button", { name: "Pripojiť GitHub" });
});
it("strips callback credentials and completes once after the user's action, including StrictMode", async () => {
  window.history.replaceState(
    null,
    "",
    `/github/callback?state=${"ab".repeat(32)}&code=fixture-code`,
  );
  mocks.request.mockResolvedValue({ ok: true });
  render(
    <StrictMode>
      <GitHubCallback />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "Dokončiť prepojenie" });
  expect(window.location.search).toBe("");
  expect(mocks.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dokončiť prepojenie" }));
  await screen.findByText("GitHub je pripojený");
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("finish", "alice", {
    state: "ab".repeat(32),
    code: "fixture-code",
  });
});
it("handles denied consent without exchanging a code", async () => {
  window.history.replaceState(null, "", "/github/callback?error=access_denied");
  render(<GitHubCallback />);
  await screen.findByRole("alert");
  expect(window.location.search).toBe("");
  expect(screen.queryByRole("button")).toBeNull();
  expect(mocks.request).not.toHaveBeenCalled();
});
