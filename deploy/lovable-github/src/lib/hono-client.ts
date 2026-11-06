import { supabase } from "@/integrations/supabase/client";

/** Browser call to the same-origin Hono proxy with the user's Cloud access token. */
export async function honoFetch(
  path: string,
  init: {
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    expectedUserId?: string;
    expectedAccessToken?: string;
  } = {},
) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (init.expectedUserId && data.session?.user.id !== init.expectedUserId)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  if (init.expectedAccessToken && token !== init.expectedAccessToken)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`/api/hono/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : null,
    signal: init.signal ?? null,
    credentials: "omit",
    cache: "no-store",
  });
}
