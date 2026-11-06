import { createFileRoute } from "@tanstack/react-router";

async function handle({ request, params }: { request: Request; params: { _splat?: string } }) {
  const { makeGitHubBff } = await import("@/lib/github-bff.server");
  const { createClient } = await import("@supabase/supabase-js");
  const supabaseUrl = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];

  if (
    !process.env["HONO_BASE_URL"] ||
    !process.env["GITHUB_BRIDGE_SECRET"] ||
    !process.env["GITHUB_CLOUD_CALLBACK_URL"] ||
    !process.env["GITHUB_CLOUD_CLIENT_ID"]
  )
    return Response.json(
      { error: "github_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  return makeGitHubBff({
    bridgeSecret: process.env["GITHUB_BRIDGE_SECRET"],
    callbackUrl: process.env["GITHUB_CLOUD_CALLBACK_URL"],
    clientId: process.env["GITHUB_CLOUD_CLIENT_ID"],
    baseUrl: process.env["HONO_BASE_URL"],
    fetch: (input, init) => fetch(input, init),
    ...(process.env["HONO_BASIC_AUTH"] ? { basicAuth: process.env["HONO_BASIC_AUTH"] } : {}),
    verifyToken: async (token, signal) => {
      if (!supabaseUrl || !key) throw new Error("auth not configured");
      const sb = createClient(supabaseUrl, key, {
        auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
        global: {
          fetch: (i, init) => {
            const h = new Headers(init?.headers);
            if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
              h.delete("Authorization");
            h.set("apikey", key);
            return fetch(i, {
              ...init,
              headers: h,
              signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
              redirect: "error",
              cache: "no-store",
            });
          },
        },
      });
      const { data, error } = await sb.auth.getUser(token);
      if (error) {
        if (error.status && error.status >= 500) throw error;
        return false;
      }
      const u = data.user;
      return !!u && !u.is_anonymous && u.role === "authenticated";
    },
  })(request);
}

export const Route = createFileRoute("/api/github-connect/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
