import { fixtureSession, setFixtureUser } from "./session";
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: fixtureSession() }, error: null }),
    signOut: async () => {
      await setFixtureUser(null);
      return { error: null };
    },
  },
};
