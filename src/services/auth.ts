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
  | { state: 'disabled' }
  | { state: 'anonymous' }
  | { state: 'authenticated'; user: AuthUser; quota: QuotaInfo };

export async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    /* /api/auth/me: 404 = auth vypnutý (pilot), 401 = zapnutý ale neprihlásený, 200 = prihlásený */
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.status === 404 || res.status === 405) return { state: 'disabled' };
    if (res.status === 401) return { state: 'anonymous' };
    if (!res.ok) return { state: 'disabled' };
    const me = await res.json();
    return { state: 'authenticated', user: me.user, quota: me.quota };
  } catch {
    /* server nedostupný — nezamykaj UI (pilot bez auth featury) */
    return { state: 'disabled' };
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) return { ok: true };
  const j = await res.json().catch(() => ({}));
  return { ok: false, error: j.error ?? 'unknown_error' };
}

export const authApi = {
  login: (email: string, password: string) => post('/api/auth/login', { email, password }),
  register: (email: string, password: string) => post('/api/auth/register', { email, password }),
  logout: () => post('/api/auth/logout', {})
};
