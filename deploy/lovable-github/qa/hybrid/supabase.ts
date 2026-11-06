import { fixtureSession, setFixtureUser } from "./session";
export const supabase = {
  auth: {
    onAuthStateChange: (callback: () => void) => { window.addEventListener("fixture-auth-change", callback); return {data:{subscription:{unsubscribe:()=>window.removeEventListener("fixture-auth-change", callback)}}}; },
    getSession: async () => ({ data: { session: fixtureSession() }, error: null }),
    signOut: async () => {
      await setFixtureUser(null);
      return { error: null };
    },
  },
};
