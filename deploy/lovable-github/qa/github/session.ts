export function useSession() {
  return { status: "signed-in" as const, email: "test@example.invalid", session: { access_token: "synthetic-local-fixture", user: { id: "fixture-user" } } };
}
