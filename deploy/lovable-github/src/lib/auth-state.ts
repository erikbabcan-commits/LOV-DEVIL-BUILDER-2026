import { z } from "zod";
import { AiQuotaSchema, type AiQuota } from "./ai-quota";
export type SessionState =
  { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; email: string | null };

export function deriveSessionState(
  loaded: boolean,
  session: { user?: { email?: string | null } | null } | null | undefined,
): SessionState {
  if (!loaded) return { status: "loading" };
  if (!session?.user) return { status: "signed-out" };
  return { status: "signed-in", email: session.user.email ?? null };
}

export type HonoReach =
  "ok" | "not-configured" | "basic-auth" | "unreachable" | "timeout" | "error" | "signed-out";
export type HonoAccount =
  | "linked"
  | "auth-incomplete"
  | "identity-unlinked"
  | "identity-unavailable"
  | "not-configured"
  | "unreachable"
  | "error"
  | "signed-out";

async function errCode(res: Response): Promise<string | null> {
  try {
    const j = (await res.clone().json()) as { error?: unknown };
    return typeof j.error === "string" ? j.error : null;
  } catch {
    return null;
  }
}

export async function mapReady(res: Response): Promise<HonoReach> {
  if (res.ok) return "ok";
  const code = await errCode(res);
  if (code === "hono_not_configured") return "not-configured";
  if (code === "upstream_basic_auth") return "basic-auth";
  if (res.status === 504) return "timeout";
  if (res.status === 502) return "unreachable";
  if (res.status === 401 && code === "unauthorized") return "signed-out";
  return "error";
}

export interface HonoAccountInfo {
  state: HonoAccount;
  userId?: string | undefined;
  plan?: string | undefined;
  quota?: AiQuota | undefined;
}

/** Translate the account probe while keeping a verified unlinked identity distinct. */
export async function mapMe(res: Response): Promise<HonoAccountInfo> {
  const code = await errCode(res);
  if (res.ok) {
    try {
      const parsed = z
        .object({
          user: z.object({ id: z.string().min(1).max(256), plan: z.enum(["free", "pro"]) }),
          quota: z.unknown().optional(),
        })
        .safeParse(await res.json());
      if (!parsed.success) return { state: "error" };
      const quota = AiQuotaSchema.safeParse(parsed.data.quota);
      return {
        state: "linked",
        userId: parsed.data.user.id,
        plan: parsed.data.user.plan,
        ...(quota.success ? { quota: quota.data } : {}),
      };
    } catch {
      return { state: "error" };
    }
  }
  if (code === "hono_not_configured") return { state: "not-configured" };
  if (res.status === 502 || res.status === 504) return { state: "unreachable" };
  if (res.status === 503) return { state: "identity-unavailable" };
  if (res.status === 401)
    return { state: code === "cloud_identity_unlinked" ? "identity-unlinked" : "auth-incomplete" };
  return { state: "error" };
}
