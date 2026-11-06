import { useEffect, useSyncExternalStore } from "react";
type Session = { access_token: string; user: { id: string; email: string } };
let state: { status: "loading" | "signed-in" | "signed-out"; session: Session | null } = {
  status: "loading",
  session: null,
};
const listeners = new Set<() => void>();
let revision = 0,
  boot = false;
export async function setFixtureUser(user: "alice" | "bob" | null) {
  const version = ++revision;
  if (!user) {
    state = { status: "signed-out", session: null };
    for (const listener of listeners) listener();
    return;
  }
  const response = await fetch("/__test/session/" + user);
  if (!response.ok) throw new Error("Fixture session unavailable");
  const session = (await response.json()) as Session;
  if (version !== revision) return;
  state = { status: "signed-in", session };
  for (const listener of listeners) listener();
}
export function fixtureSession() {
  return state.session;
}
export function useSession() {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!boot) {
      boot = true;
      void setFixtureUser("alice");
    }
  }, []);
  return { ...value, email: value.session?.user.email ?? null };
}
