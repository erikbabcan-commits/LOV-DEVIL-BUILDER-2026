import { useSyncExternalStore } from "react";
let user = "alice";
const listeners = new Set<() => void>();
export function setFixtureUser(value: "alice" | "bob") {
  user = value;
  listeners.forEach((listener) => listener());
}
export function currentFixtureUser() {
  return user;
}
export function useSession() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => user,
    () => user,
  );
  return {
    status: "signed-in" as const,
    email: current + "@example.invalid",
    session: { access_token: "synthetic-local-only", user: { id: current } },
  };
}
