import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchAuthStatus } from '../../src/services/auth';
import { AppShell } from '../../src/app/AppShell';
import { AI_QUOTA_CHANGED } from '../../src/services/ai/usage';
import { useStore } from '../../src/stores/useAppStore';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const signedIn = { user: { id: 'user-1', email: 'test@example.com', plan: 'free' }, quota: { used: 1, limit: 10, remaining: 9, plan: 'free' } };

describe('verified authentication status', () => {
  it('refreshes quota from authenticated server state after AI admission', async () => {
    vi.spyOn(useStore.getState(), 'restoreFromDb').mockResolvedValue(undefined);
    const initial={...signedIn,quota:{used:8,limit:10,remaining:2,plan:'free'}};
    const fetch=vi.fn().mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(Response.json({...initial,quota:{used:9,limit:10,remaining:1,plan:'free'}}));
    vi.stubGlobal('fetch',fetch);render(<AppShell/>);
    await screen.findByRole('button',{name:'Spotreba AI: 8 z 10 mesačných úloh'});
    fireEvent(window,new Event(AI_QUOTA_CHANGED));
    await screen.findByRole('button',{name:'Spotreba AI: 9 z 10 mesačných úloh'});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url])=>url==='/api/auth/me')).toBe(true);
  });
  it.each([500, 503])('does not open a pilot editor after HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
    expect(await fetchAuthStatus()).toEqual({ state: 'unavailable' });
  });
  it('does not treat a missing auth route as a disabled authentication system', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json({ ok: true, auth: 'enabled' }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchAuthStatus()).toEqual({ state: 'unavailable' });
  });
  it('allows an explicitly disabled pilot only after the health response confirms it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json({ ok: true, auth: 'disabled' })));
    expect(await fetchAuthStatus()).toEqual({ state: 'disabled' });
  });
  it('recognizes a valid session and an anonymous response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(signedIn)).mockResolvedValueOnce(new Response('', { status: 401 })));
    expect(await fetchAuthStatus()).toEqual({ state: 'authenticated', ...signedIn });
    expect(await fetchAuthStatus()).toEqual({ state: 'anonymous' });
  });
  it.each([{}, { ...signedIn, user: null }, { ...signedIn, quota: { remaining: 10 } }])('rejects a malformed successful response', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    expect(await fetchAuthStatus()).toEqual({ state: 'unavailable' });
  });
  it('keeps the editor and persisted project hidden during outage, then permits retry', async () => {
    const restore = vi.spyOn(useStore.getState(), 'restoreFromDb').mockResolvedValue(undefined);
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    render(<AppShell />);
    expect(screen.getByRole('status')).toHaveTextContent('Overujem prístup');
    expect(screen.queryByRole('textbox', { name: 'Popíš zmenu' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server teraz neodpovedá'));
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skúsiť znova' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Prihlásenie' })).toBeInTheDocument());
    expect(restore).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
