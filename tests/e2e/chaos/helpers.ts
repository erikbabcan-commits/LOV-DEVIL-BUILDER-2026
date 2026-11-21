import { test as base, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';

/* Agent 10: shared chaos helpers. Every spec imports `test` from here, so every test runs with
   the loopback-only isolation guard: non-loopback requests are aborted, recorded and must be 0. */
export const API_PORT = Number(process.env.CHAOS_API_PORT ?? 3012);
export const WEB_PORT = Number(process.env.CHAOS_WEB_PORT ?? 3013);
export const PUBLIC_PORT = Number(process.env.CHAOS_PUBLIC_PORT ?? 3014);
export const JOBS_WEB_PORT = Number(process.env.CHAOS_JOBS_WEB_PORT ?? 3015);
export const API = `http://127.0.0.1:${API_PORT}`;
export const WEB = `http://localhost:${WEB_PORT}`;
export const JOBS_WEB = `http://localhost:${JOBS_WEB_PORT}`;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** True for URLs that never leave the machine (loopback, data/blob/about/srcdoc). */
export function isLocal(url: string): boolean {
  if (/^(data|blob|about|chrome-error):/i.test(url)) return true;
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}
/** Token-like material that must never show up in browser console output. */
const SECRET_PATTERNS = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, /\bsk_(live|test)_[A-Za-z0-9]+/, /\bwhsec_[A-Za-z0-9]+/, /lov_token=/];

export type Isolation = { external: string[]; console: string[] };

export const test = base.extend<{ isolation: Isolation }>({
  isolation: [async ({ context }, use) => {
    const state: Isolation = { external: [], console: [] };
    // Abort before sending: nothing may leave the loopback interface.
    await context.route('**/*', route => {
      const url = route.request().url();
      if (isLocal(url)) return route.fallback();
      state.external.push(url);
      return route.abort('blockedbyclient');
    });
    const watch = (page: Page) => {
      page.on('request', (request: Request) => { if (!isLocal(request.url()) && !state.external.includes(request.url())) state.external.push(request.url()); });
      page.on('console', message => state.console.push(message.text()));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    await use(state);
    expect(state.external, 'non-loopback requests (must be 0)').toEqual([]);
    const leaked = state.console.filter(line => SECRET_PATTERNS.some(pattern => pattern.test(line)));
    expect(leaked, 'secret-like material in browser console').toEqual([]);
  }, { auto: true }],
});
export { expect };

/** Unique disposable account per test and per repeat. */
export function uniqueUser(prefix: string): string {
  return (prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48);
}

/** Signs in a fixture user (cookie session set by the loopback fixture) and waits for the app shell. */
export async function login(page: Page, user: string, options: { seed?: string; jobsClient?: boolean } = {}) {
  const query = new URLSearchParams();
  if (options.seed) query.set('seed', options.seed);
  if (options.jobsClient) query.set('web', 'jobs');
  await page.goto(`http://localhost:${API_PORT}/__test/session/${user}?${query}`);
  await expect(page).toHaveURL((options.jobsClient ? JOBS_WEB : WEB) + '/');
  await expect(page.getByRole('button', { name: 'Moje projekty' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#modelChip')).toContainText('AI test');
}

/** Opens the seeded server project via "Moje projekty" and switches to the workspace view. */
export async function openSeededProject(page: Page) {
  await page.getByRole('button', { name: 'Moje projekty' }).first().click();
  await page.getByRole('button', { name: 'Otvoriť zo servera' }).click();
  await expect(page.locator('#editorView')).toBeVisible();
  await page.click('#edPreviewBtn');
  await expect(page.locator('#workspaceView')).toBeVisible();
}

export async function aiCalls(request: APIRequestContext): Promise<{ total: number; repair: number }> {
  return (await request.get(API + '/__test/ai-calls')).json();
}
export async function serverJobs(request: APIRequestContext, user: string): Promise<Array<{ id: string; key: string; state: string }>> {
  return (await (await request.get(API + '/__test/jobs/' + user)).json()).jobs;
}
export async function serverProject(request: APIRequestContext, user: string, project: string) {
  return (await request.get(API + `/__test/project/${user}/${project}`)).json() as Promise<{ revision: number; liveId: string; snapshots: number; files: Array<{ name: string; content: string }> }>;
}
export async function publishState(request: APIRequestContext, user: string) {
  return (await request.get(API + '/__test/publish/' + user)).json() as Promise<{ jobs: Array<{ requestId: string; projectId: string; revision: number; state: string }>; live: Array<{ projectId: string; url: string; requestId: string }> }>;
}

/** Store snapshot used to prove "sources unchanged" in the browser. */
export async function liveSources(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { __forgeStore: { getState(): { liveId: string | null; snapshots: unknown[]; vfs: Record<string, Array<{ name: string; content: string }>> } } }).__forgeStore.getState();
    const files = (state.vfs[state.liveId ?? ''] ?? []).map(({ name, content }) => ({ name, content })).sort((a, b) => a.name.localeCompare(b.name));
    return { liveId: state.liveId, snapshots: state.snapshots.length, files };
  });
}
export async function storeValue<T>(page: Page, pick: string): Promise<T> {
  return page.evaluate(key => (window as unknown as { __forgeStore: { getState(): Record<string, unknown> } }).__forgeStore.getState()[key] as T, pick);
}
