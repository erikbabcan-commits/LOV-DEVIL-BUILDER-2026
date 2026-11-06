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
}));
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
