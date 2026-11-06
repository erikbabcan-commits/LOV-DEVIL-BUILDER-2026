import type { AnchorHTMLAttributes } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";
const mocks = vi.hoisted(() => ({
  status: "signed-in",
  cancel: vi.fn(),
  clear: vi.fn(),
  signOut: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({ status: mocks.status, email: "synthetic@example.test" }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: mocks.signOut } },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries: mocks.cancel, clear: mocks.clear }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = "signed-in";
  mocks.cancel.mockResolvedValue(undefined);
  mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(cleanup);
it("names the mobile sign-in icon even when its visual text is hidden", () => {
  mocks.status = "signed-out";
  render(
    <>
      <style>{".hidden{display:none}"}</style>
      <AccountMenu />
    </>,
  );
  expect(screen.getByRole("link", { name: "Prihlásiť sa" })).toHaveAttribute("href", "/auth");
  expect(mocks.signOut).not.toHaveBeenCalled();
});
it("shows no interactive auth control while loading", () => {
  mocks.status = "loading";
  render(<AccountMenu />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
async function openWithKeyboard() {
  const trigger = screen.getByRole("button", { name: "Účet" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("menuitem", { name: "Odhlásiť sa" });
  await waitFor(() => expect(item).toHaveFocus());
  return { trigger, item };
}
it("opens by keyboard and Escape returns focus without signing out", async () => {
  render(<AccountMenu />);
  const { trigger, item } = await openWithKeyboard();
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(item, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(mocks.signOut).not.toHaveBeenCalled();
});
it("Enter selects sign-out only after explicit keyboard activation", async () => {
  render(<AccountMenu />);
  const { item } = await openWithKeyboard();
  expect(mocks.signOut).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.keyDown(item, { key: "Enter" });
  });
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/auth", replace: true }));
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
  expect(mocks.cancel).toHaveBeenCalledTimes(1);
  expect(mocks.clear).toHaveBeenCalledTimes(1);
});

it("keeps cached data and navigation on a returned provider error, then permits retry", async () => {
  mocks.signOut.mockResolvedValueOnce({ error: new Error("private-provider-detail") });
  render(<AccountMenu />);
  const { item } = await openWithKeyboard();
  await act(async () => {
    fireEvent.keyDown(item, { key: "Enter" });
  });
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith("Odhlásenie sa nepodarilo dokončiť. Skús to znova.");
  const retry = await openWithKeyboard();
  await act(async () => {
    fireEvent.keyDown(retry.item, { key: "Enter" });
  });
  expect(mocks.signOut).toHaveBeenCalledTimes(2);
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
});
it("handles a rejected auth request without discarding cached data or navigating", async () => {
  mocks.signOut.mockRejectedValueOnce(new Error("network-private-detail"));
  render(<AccountMenu />);
  const { item } = await openWithKeyboard();
  await act(async () => {
    fireEvent.keyDown(item, { key: "Enter" });
  });
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledTimes(1);
});
it("does not invoke auth if query cancellation failed", async () => {
  mocks.cancel.mockRejectedValueOnce(new Error("cache-private-detail"));
  render(<AccountMenu />);
  const { item } = await openWithKeyboard();
  await act(async () => {
    fireEvent.keyDown(item, { key: "Enter" });
  });
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledTimes(1);
});
it("waits for provider confirmation and blocks duplicate actions while pending", async () => {
  let resolve!: (value: { error: null }) => void;
  mocks.signOut.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<AccountMenu />);
  const { trigger, item } = await openWithKeyboard();
  await act(async () => {
    fireEvent.keyDown(item, { key: "Enter" });
  });
  expect(trigger).toBeDisabled();
  expect(trigger).toHaveAttribute("aria-busy", "true");
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Odhlásiť sa" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve({ error: null });
  });
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
  expect(mocks.error).not.toHaveBeenCalled();
});
