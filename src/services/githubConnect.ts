import { z } from 'zod';
import { apiUrl } from '../lib/api';
import {
  checkGitHubAuth,
  checkGitHubAvailable,
  initiateGitHubAuth,
  revokeGitHubAuth,
  type GitHubAuthState,
} from './export/githubExport';
import {
  GitHubExportJob,
  GitHubExportReview,
  type GitHubExportError,
} from '../../shared/githubExportProtocol';

/* Unified GitHub connector client.
 *
 * Režim "bridge": BFF endpoint /api/github-connect/* je nakonfigurovaný (HONO_BASE_URL
 * + GITHUB_CLOUD_* + GITHUB_BRIDGE_SECRET) — OAuth ide cez /github/callback stránku
 * a výmenu dokončí POST /api/github-connect/finish. Export ide cez export/prepare|confirm|status.
 *
 * Režim "local": fallback na lokálne /api/github/* (cookie session + CSRF), OAuth cez
 * /api/github/auth/start → /api/github/auth/callback → redirect späť do aplikácie.
 *
 * Probe: GET /api/github-connect/status. Fallback mount vracia {connected:false, configured:false};
 * skutočný BFF vracia {connected:boolean} (prípadne 401 bez identity) — nikdy 503.
 */

export type GitHubConnectorMode = 'bridge' | 'local';

export interface GitHubConnection {
  mode: GitHubConnectorMode;
  available: boolean;
  configured: boolean;
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  csrfToken?: string;
  blocked?: boolean;
  blockReason?: string;
  message?: string;
}

export interface BridgeStatus {
  connected: boolean;
  username?: string;
  githubId?: number;
  scopes?: string[];
}

const BRIDGE_ROOT = '/api/github-connect';

async function readJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => ({}));
}

/** True keď beží BFF bridge (nie JSON fallback). */
export async function probeBridgeConfigured(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(apiUrl(`${BRIDGE_ROOT}/status`), {
      credentials: 'include',
      cache: 'no-store',
      signal: signal ?? AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const body = (await readJson(response)) as { connected?: unknown; configured?: unknown };
    return typeof body.connected === 'boolean' && body.configured !== false;
  } catch {
    return false;
  }
}

async function bridgeRequest<T>(
  action: 'start' | 'finish' | 'status' | 'disconnect' | 'export/prepare' | 'export/confirm' | 'export/status' | 'export/review' | 'export/cancel' | 'export/reconcile',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const isGet = action === 'status';
  const response = await fetch(apiUrl(`${BRIDGE_ROOT}/${action}`), {
    method: isGet ? 'GET' : 'POST',
    credentials: 'include',
    headers: isGet ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(action === 'export/confirm' ? 80_000 : 20_000),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const error = (data as { error?: unknown }).error;
    const code = typeof error === 'string' ? error : 'unavailable';
    const messages: Record<string, string> = {
      cloud_identity_required: 'Prihlás sa znova a zopakuj prepojenie.',
      github_nonce_required: 'Prepojenie vypršalo alebo patrí inému účtu. Začni znova.',
      github_route_unavailable: 'GitHub konektor nie je na tomto serveri zapnutý.',
      github_connection_unavailable: 'GitHub bridge momentálne neodpovedá. Skús to znova.',
      github_connection_failed: 'GitHub bridge zlyhal. Skús to znova.',
      origin_not_allowed: 'Požiadavka mimo povoleného pôvodu.',
      json_required: 'Neplatný formát požiadavky.',
      github_not_connected: 'Najprv pripoj GitHub.',
      github_export_not_configured: 'GitHub export nie je nakonfigurovaný.',
      project_not_found: 'Projekt sa na serveri nenašiel. Ulož ho najprv.',
      snapshot_not_found: 'Vybraná verzia projektu sa nenašla.',
      invalid_sources: 'Vybraná verzia nemá bezpečné exportovateľné súbory.',
      public_confirmation_required: 'Export vyžaduje potvrdenie verejného repozitára.',
      export_request_conflict: 'Tento názov alebo pokus je už rezervovaný. Skús iný názov.',
      export_expired: 'Kontrola exportu vypršala. Začni nový export.',
      repository_exists: 'Repozitár s týmto názvom už existuje na tvojom GitHube.',
      github_write_failed: 'Zápis na GitHub zlyhal. Skús to znova.',
    };
    throw new GitHubConnectError(code, messages[code] ?? 'GitHub prepojenie momentálne nie je dostupné. Skús to znova.');
  }
  return data as T;
}

export class GitHubConnectError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GitHubConnectError';
  }
}

export async function bridgeStatus(signal?: AbortSignal): Promise<BridgeStatus> {
  return bridgeRequest<BridgeStatus>('status', undefined, signal);
}

/** Spustí OAuth — bridge: vráti authorizationUrl; local: redirect cez /api/github/auth/start. */
export async function startGitHubConnect(): Promise<void> {
  if (await probeBridgeConfigured()) {
    const result = await bridgeRequest<{ authorizationUrl: string }>('start', {});
    const url = new URL(result.authorizationUrl);
    if (
      url.origin !== 'https://github.com' ||
      url.pathname !== '/login/oauth/authorize' ||
      url.searchParams.get('scope') !== 'public_repo'
    )
      throw new GitHubConnectError('invalid_authorization_url', 'Neplatná odpoveď prepojenia.');
    window.location.assign(result.authorizationUrl);
    return;
  }
  initiateGitHubAuth();
}

/** Dokončí OAuth na /github/callback (bridge režim). */
export async function finishGitHubConnect(state: string, code: string): Promise<void> {
  await bridgeRequest('finish', { state, code });
}

export async function disconnectGitHub(): Promise<void> {
  if (await probeBridgeConfigured()) {
    await bridgeRequest('disconnect', {});
    return;
  }
  const result = await revokeGitHubAuth();
  if (!result.ok) throw new GitHubConnectError('disconnect_failed', result.error || 'Odpojenie zlyhalo.');
}

/** Unified stav pripojenia pre UI (TopBar / ConnectionPanel / Workspace). */
export async function getGitHubConnection(): Promise<GitHubConnection> {
  if (await probeBridgeConfigured()) {
    try {
      const status = await bridgeStatus();
      return {
        mode: 'bridge',
        available: true,
        configured: true,
        authenticated: status.connected,
        username: status.connected ? status.username : undefined,
        scopes: status.connected ? status.scopes : undefined,
        message: status.connected ? 'Pripojené' : 'Nepripojené',
        blocked: false,
      };
    } catch (error) {
      return {
        mode: 'bridge',
        available: false,
        configured: true,
        authenticated: false,
        message: error instanceof Error ? error.message : 'GitHub nedostupný',
        blocked: false,
      };
    }
  }
  const [availability, auth] = await Promise.all([checkGitHubAvailable(), checkGitHubAuth()]);
  return {
    mode: 'local',
    available: availability.available,
    configured: availability.configured,
    authenticated: auth.authenticated,
    username: auth.username,
    avatarUrl: auth.avatarUrl,
    scopes: auth.scopes,
    csrfToken: auth.csrfToken,
    blocked: auth.blocked || availability.blocked,
    blockReason: auth.blockReason ?? availability.blockReason,
    message: auth.message ?? availability.message,
  };
}

/** Zachytí ?code&state z /github/callback URL (bez toho žiadna výmena). */
export function captureGitHubCallback(url: string): { state: string; code: string } | null {
  const query = new URL(url).searchParams;
  if (query.has('error') || query.getAll('state').length !== 1 || query.getAll('code').length !== 1)
    return null;
  const state = query.get('state') ?? '';
  const code = query.get('code') ?? '';
  return /^[a-f0-9]{64}$/.test(state) && /^[A-Za-z0-9_-]{1,512}$/.test(code) ? { state, code } : null;
}

/* ---------- Bridge export (prepare → confirm → status) ---------- */

export type ExportReview = z.infer<typeof GitHubExportReview>;
export type ExportJob = z.infer<typeof GitHubExportJob>;

export async function bridgeExportPrepare(body: unknown, signal?: AbortSignal): Promise<ExportReview> {
  const data = await bridgeRequest<unknown>('export/prepare', body, signal);
  const parsed = GitHubExportReview.safeParse(data);
  if (!parsed.success) throw new GitHubConnectError('invalid_export_response', 'Server vrátil neplatnú odpoveď. Skús to znova.');
  return parsed.data;
}

export async function bridgeExportConfirm(body: unknown, signal?: AbortSignal): Promise<ExportJob> {
  const data = await bridgeRequest<unknown>('export/confirm', body, signal);
  const parsed = GitHubExportJob.safeParse(data);
  if (!parsed.success) throw new GitHubConnectError('invalid_export_response', 'Server vrátil neplatnú odpoveď. Skús to znova.');
  return parsed.data;
}

export async function bridgeExportStatus(requestId: string, signal?: AbortSignal): Promise<ExportJob> {
  const data = await bridgeRequest<unknown>('export/status', { requestId }, signal);
  const parsed = GitHubExportJob.safeParse(data);
  if (!parsed.success) throw new GitHubConnectError('invalid_export_response', 'Server vrátil neplatnú odpoveď. Skús to znova.');
  return parsed.data;
}

export async function bridgeExportCancel(body: unknown, signal?: AbortSignal): Promise<ExportJob> {
  const data = await bridgeRequest<unknown>('export/cancel', body, signal);
  const parsed = GitHubExportJob.safeParse(data);
  if (!parsed.success) throw new GitHubConnectError('invalid_export_response', 'Server vrátil neplatnú odpoveď. Skús to znova.');
  return parsed.data;
}

export type { GitHubExportError, GitHubAuthState };
