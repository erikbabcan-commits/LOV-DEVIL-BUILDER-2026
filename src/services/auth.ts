import { apiUrl } from '../lib/api';

/* Auth klient — zisťuje stav auth (health + me), login/register/logout.
   Keď je auth vypnutý (pilot mód), health vráti auth:'disabled' a UI pokračuje bez loginu. */

export interface AuthUser {
  id: string;
  email: string;
  plan: 'free' | 'pro';
}

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  plan: 'free' | 'pro';
}

export type AuthStatus =
  | { state: 'checking' }
  | { state: 'unavailable' }
  | { state: 'disabled' }
  | { state: 'anonymous' }
  | { state: 'authenticated'; user: AuthUser; quota: QuotaInfo };

export async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include', signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 405) {
      // Missing routes and proxy failures are not evidence that authentication is disabled.
      const health = await fetch(apiUrl('/api/health'), { credentials: 'include', signal: AbortSignal.timeout(10_000) });
      const status = health.ok ? await health.json() : null;
      return { state: status?.ok === true && status?.auth === 'disabled' ? 'disabled' : 'unavailable' };
    }
    if (res.status === 401) return { state: 'anonymous' };
    if (!res.ok) return { state: 'unavailable' };
    const me = await res.json();
    const validPlan = (plan: unknown) => plan === 'free' || plan === 'pro';
    if (typeof me?.user?.id !== 'string' || !me.user.id || typeof me.user.email !== 'string' || !validPlan(me.user.plan) ||
        !validPlan(me?.quota?.plan) || !['used', 'limit', 'remaining'].every(key => typeof me.quota[key] === 'number' && Number.isFinite(me.quota[key]) && me.quota[key] >= 0))
      return { state: 'unavailable' };
    return { state: 'authenticated', user: me.user, quota: me.quota };
  } catch {
    return { state: 'unavailable' };
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl(path), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    const value: unknown = await res.json().catch(() => null);
    const code = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : 'unknown_error';
    return { ok: false, error: code };
  } catch { return { ok: false, error: 'network_error' }; }
}

export const authApi = {
  login: (email: string, password: string) => post('/api/auth/login', { email, password }),
  register: (email: string, password: string) => post('/api/auth/register', { email, password }),
  logout: () => post('/api/auth/logout', {}),
  googleStatus: async (): Promise<{ configured: boolean; clientId: string | null }> => {
    try {
      const res = await fetch(apiUrl('/api/auth/google/status'), { credentials: 'include', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { configured: false, clientId: null };
      return (await res.json()) as { configured: boolean; clientId: string | null };
    } catch {
      return { configured: false, clientId: null };
    }
  },
  loginWithGoogleCredential: (credential: string) => post('/api/auth/google/credential', { credential })
};
