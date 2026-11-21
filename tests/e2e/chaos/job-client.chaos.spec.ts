import type { Page, Request } from '@playwright/test';
import { test, expect, login, uniqueUser, serverJobs, WEB, JOBS_WEB } from './helpers';

/* Flow 1: Job client (agent 2) — SSE → polling recovery, network outages, no double run, 503 fallback. */
const IDEA = 'Create a modern CRM dashboard with customers, tasks and a sidebar.';
const TERMINAL = /"type":"(done|error|cancelled)"/;

type Post = { url: string; key: string | null; body: string | null };
/** Records every POST to the generate/jobs endpoints (method, Idempotency-Key, body). */
function recordPosts(page: Page) {
  const posts: Post[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (path === '/api/agent/generate' || path === '/api/agent/jobs'))
      posts.push({ url: path, key: request.headers()['idempotency-key'] ?? null, body: request.postData() });
  });
  return posts;
}
/** Records every transport state the store reports (reconnecting can be short-lived). */
async function recordTransports(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __transports: string[]; __forgeStore: { subscribe(fn: (s: { jobTransport: string }) => void): void; getState(): { jobTransport: string } } };
    w.__transports = [w.__forgeStore.getState().jobTransport];
    w.__forgeStore.subscribe(state => { if (w.__transports.at(-1) !== state.jobTransport) w.__transports.push(state.jobTransport); });
  });
}
const transports = (page: Page) => page.evaluate(() => (window as unknown as { __transports: string[] }).__transports);
/** Same Idempotency-Key must never be reused with a different body. */
function expectKeysBoundToOneBody(posts: Post[]) {
  const bodies = new Map<string, Set<string>>();
  for (const post of posts) {
    expect(post.key, 'Idempotency-Key on ' + post.url).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    bodies.set(post.key!, (bodies.get(post.key!) ?? new Set()).add(post.body ?? ''));
  }
  for (const [, set] of bodies) expect(set.size).toBe(1);
}
async function submitHome(page: Page, prompt = IDEA) {
  await page.fill('#homeInput', prompt);
  await page.click('#homeSend');
}
async function expectReview(page: Page) {
  await expect(page.locator('.review-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.review-panel')).toContainText('src/App.tsx');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __forgeStore: { getState(): { generating: boolean } } }).__forgeStore.getState().generating)).toBe(false);
}

test.describe('job client: SSE → polling, výpadky siete', () => {
  test('1a happy: normálny SSE beh s Idempotency-Key končí reviewom', async ({ page, request }) => {
    const user = uniqueUser('jobs-a');
    const posts = recordPosts(page);
    await login(page, user);
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/agent/generate');
    await submitHome(page);
    const sse = await response;
    expect(sse.status()).toBe(200);
    expect(sse.headers()['content-type']).toContain('text/event-stream');
    await expectReview(page);
    await expect(page.locator('.job-transport-status')).toHaveCount(0);
    expect(posts.map(p => p.url)).toEqual(['/api/agent/generate']);
    expectKeysBoundToOneBody(posts);
    const jobs = await serverJobs(request, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: posts[0].key, state: 'succeeded' });
  });

  /* FIXME(F1, REPORT.md): the durable job row loses events — server/index.ts:512 fires `void flushJob()`
     without awaiting while server/agent/jobs.ts:189-197 appendEvents is a non-atomic read-modify-write,
     so concurrent batches overwrite each other (an 18-event run is stored as [file_done, done]).
     Recovery then polls a succeeded job with no stage/validation/done after `seen` and ends silently
     without review or message (F2). Re-enable when F1 is fixed. */
  test.fixme('1b chaos: SSE sa preruší uprostred + 1,5 s výpadok → reconnecting → polling → review', async ({ page, request }) => {
    const user = uniqueUser('jobs-b');
    const posts = recordPosts(page);
    let outageUntil = 0, polls = 0, failedPolls = 0;
    await login(page, user);
    await recordTransports(page);
    await page.route('**/api/agent/generate', async route => {
      const response = await route.fetch();
      const events = (await response.text()).split('\n\n').filter(part => part.startsWith('data:'));
      // The live view dies after three events: no terminal event ever reaches the client.
      const kept = events.filter(part => !TERMINAL.test(part)).slice(0, 3);
      outageUntil = Date.now() + 1_500; // simulated network outage window for the recovery polls
      await route.fulfill({ status: 200, headers: response.headers(), body: kept.join('\n\n') + '\n\n' });
    });
    await page.route('**/api/agent/jobs/**', route => {
      polls++;
      expect(new URL(route.request().url()).searchParams.get('detail')).toBe('1');
      if (Date.now() < outageUntil) { failedPolls++; return route.abort('internetdisconnected'); }
      return route.fallback();
    });
    await submitHome(page);
    await expectReview(page);
    const seen = await transports(page);
    expect(seen).toContain('streaming');
    expect(seen).toContain('reconnecting');
    expect(seen.at(-1)).toBe('idle');
    expect(failedPolls).toBeGreaterThan(0);
    expect(polls).toBeGreaterThan(failedPolls);
    expect(posts.filter(p => p.url === '/api/agent/generate')).toHaveLength(1);
    const jobs = await serverJobs(request, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('succeeded');
  });

  test('1b chaos: SSE prerušené a obnova zlyhá → zrozumiteľný stav failed, UI nezamrzne', async ({ page, request }) => {
    const user = uniqueUser('jobs-f');
    await login(page, user);
    await recordTransports(page);
    await page.route('**/api/agent/generate', async route => {
      const response = await route.fetch();
      const events = (await response.text()).split('\n\n').filter(part => part.startsWith('data:'));
      await route.fulfill({ status: 200, headers: response.headers(), body: events.filter(part => !TERMINAL.test(part)).slice(0, 3).join('\n\n') + '\n\n' });
    });
    await page.route('**/api/agent/jobs/**', route => route.abort('internetdisconnected'));
    await submitHome(page);
    const status = page.locator('.job-transport-status[data-transport="failed"]');
    await expect(status).toContainText('Spojenie s behom sa nepodarilo obnoviť', { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __forgeStore: { getState(): { generating: boolean; pendingReview: unknown } } }).__forgeStore.getState().generating)).toBe(false);
    expect(await transports(page)).toContain('reconnecting');
    await expect(page.locator('.msg').last()).toContainText('AI odpoveď sa prerušila pred dokončením');
    await expect(page.locator('.review-panel')).toHaveCount(0);
    await expect(page.locator('#cancelBtn')).toHaveCount(0);
    // Still usable: the prompt accepts a new task.
    await page.fill('#promptInput', 'Pridaj tlačidlo');
    await expect(page.locator('#sendBtn')).toBeEnabled();
    // The server-side job itself finished; the client only lost the view.
    expect((await serverJobs(request, user))[0].state).toBe('succeeded');
  });

  test('1c chaos: offline pri odoslaní, potom online → žiadny dvojitý beh', async ({ page, context, request }) => {
    const user = uniqueUser('jobs-c');
    const posts = recordPosts(page);
    await login(page, user);
    await context.setOffline(true);
    await submitHome(page);
    await expect(page.locator('.msg').last()).toContainText('AI server nie je dostupný', { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __forgeStore: { getState(): { generating: boolean } } }).__forgeStore.getState().generating)).toBe(false);
    expect(await serverJobs(request, user)).toHaveLength(0);
    await context.setOffline(false);
    const ok = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/agent/generate');
    await page.fill('#promptInput', IDEA);
    await page.click('#sendBtn');
    expect((await ok).status()).toBe(200);
    await expectReview(page);
    const jobs = await serverJobs(request, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('succeeded');
    expect(posts.every(p => p.url === '/api/agent/generate')).toBe(true);
    expect(posts.length).toBeLessThanOrEqual(2);
    expect(posts.at(-1)!.key).toBe(jobs[0].key);
    expectKeysBoundToOneBody(posts);
  });

  test('1d chaos: POST /api/agent/jobs → 503 agent_jobs_disabled → fallback na SSE s rovnakým kľúčom', async ({ page, request }) => {
    const user = uniqueUser('jobs-d');
    const posts = recordPosts(page);
    await login(page, user, { jobsClient: true });
    const disabled = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === JOBS_WEB + '/api/agent/jobs');
    const sse = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === JOBS_WEB + '/api/agent/generate');
    await submitHome(page);
    const rejected = await disabled;
    expect(rejected.status()).toBe(503);
    expect(JSON.stringify(await rejected.json())).toContain('agent_jobs_disabled');
    expect((await sse).headers()['content-type']).toContain('text/event-stream');
    await expectReview(page);
    expect(posts.map(p => p.url)).toEqual(['/api/agent/jobs', '/api/agent/generate']);
    expect(posts[0].key).toBe(posts[1].key);
    const jobs = await serverJobs(request, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: posts[1].key, state: 'succeeded' });
    // The session remembers that durable jobs are disabled: the next run goes straight to SSE.
    await page.getByRole('button', { name: 'Odmietnuť', exact: true }).click();
    await page.fill('#promptInput', 'Pridaj stránku s nastaveniami');
    await page.click('#sendBtn');
    await expect(page.locator('.review-panel')).toBeVisible({ timeout: 30_000 });
    expect(posts.map(p => p.url)).toEqual(['/api/agent/jobs', '/api/agent/generate', '/api/agent/generate']);
    expect(await serverJobs(request, user)).toHaveLength(2);
  });
});
