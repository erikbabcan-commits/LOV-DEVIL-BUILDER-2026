import { test, expect, type Page } from '@playwright/test';

const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5174';
const idea = 'Create a modern CRM dashboard with customers, tasks and a sidebar.';
declare global {
  interface Window { __forgeStore: typeof import('../../src/stores/useAppStore').useStore }
}
async function chooseMockAi(page: Page) {
  await page.click('#modelChip');
  await page.getByRole('button', { name: /^AI test/ }).click();
  await expect(page.locator('#modelChip')).toContainText('AI test');
}
async function startAi(page: Page) {
  await chooseMockAi(page);
  await page.fill('#homeInput', idea);
  const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === APP_URL + '/api/agent/generate');
  await page.click('#homeSend');
  const result = await response;
  expect(result.ok()).toBe(true);
  expect(result.headers()['content-type']).toContain('text/event-stream');
  await expect(page.locator('.review-panel')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__forgeStore.getState().snapshots.length)).toBe(0);
}
async function approvedProject(page: Page, includeFiles = false) {
  return page.evaluate(includeFiles => {
    const state = window.__forgeStore.getState();
    // Persistence adds database bookkeeping and clears transient modified flags.
    // Compare every immutable source/version field, independently of that bookkeeping.
    return { liveId: state.liveId, html: state.liveHtml,
      snapshots: state.snapshots.map(({id,v,parentId,prompt,kind,time,html,sourceFiles,pinned}) => ({ id,v,parentId:parentId??null,prompt,kind,time,html,sourceFiles:sourceFiles??null,pinned:!!pinned })),
      files: includeFiles ? (state.vfs[state.liveId!] ?? []).map(({name,content}) => ({name,content})).sort((a,b)=>a.name.localeCompare(b.name)) : null };
  }, includeFiles);
}

test('M2 review: skutočné SSE → odmietnutie bez zmeny → explicitný Instant Draft', async ({ page }) => {
  await page.goto(APP_URL);
  await startAi(page);
  await expect(page.locator('#sendBtn')).toBeDisabled();
  await page.getByRole('button', { name: 'Odmietnuť', exact: true }).click();
  await expect(page.locator('.review-panel')).toHaveCount(0);
  expect(await page.evaluate(() => window.__forgeStore.getState().snapshots.length)).toBe(0);
  await page.click('#modelChip');
  await page.getByRole('button', { name: /^Instant Draft/ }).click();
  await page.fill('#promptInput', 'Kanban board');
  await page.click('#sendBtn');
  await expect(page.locator('#previewFrame')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#snapCount')).toHaveText('1');
  await expect(page.frameLocator('#previewFrame').locator('body')).toContainText('FlowDeck');
});

test('M2 persistence: refresh obnoví presnú verziu do pracovného priestoru', async ({ page }) => {
  await page.goto(APP_URL);
  await page.fill('#homeInput', 'Moj test projekt');
  await page.click('#homeSend');
  await expect(page.locator('#previewFrame')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg .actions').first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => window.__forgeStore.getState().persistNow())).toBe(true);
  const original = await approvedProject(page);
  await page.reload();
  await expect(page.locator('#workspaceView')).toBeVisible();
  await expect.poll(() => approvedProject(page)).toEqual(original);
  await expect(page.frameLocator('#previewFrame').locator('body')).not.toBeEmpty();
});

test('M2.1 positive: HTTP/SSE → review → immutable súbory → editor → refresh restore', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
  page.on('response', response => {
    // Pilot discovers disabled auth using this missing route, followed by /api/health.
    if (response.status() >= 400 && !(response.url() === APP_URL + '/api/auth/me' && [404,405].includes(response.status()))) errors.push('HTTP ' + response.status() + ' ' + new URL(response.url()).pathname);
  });
  await page.goto(APP_URL);
  await startAi(page);
  await expect(page.locator('.review-panel')).toContainText('src/App.tsx');
  await page.getByRole('button', { name: 'Použiť zmeny', exact: true }).click();
  await expect(page.locator('#previewFrame')).toBeVisible({ timeout: 30_000 });
  await expect(page.frameLocator('#previewFrame').locator('body')).toContainText('ACME s.r.o.');
  expect(await page.evaluate(() => window.__forgeStore.getState().persistNow())).toBe(true);
  const before = await approvedProject(page,true);
  expect(before.snapshots).toHaveLength(1);
  expect(before.files!.find(file => file.name === 'src/App.tsx')?.content).toContain('CRM');
  await page.click('#editorBtn');
  await page.click('[data-edtab="files"]');
  await expect(page.locator('.ed-fileitem')).toHaveCount(before.files!.length);
  await expect(page.locator('.ed-fileitem').filter({ hasText: 'src/App.tsx' })).toBeVisible();
  await page.reload();
  await expect(page.locator('#workspaceView')).toBeVisible();
  await expect.poll(() => approvedProject(page,true)).toEqual(before);
  expect(errors).toEqual([]);
});

test('M2.1 cancel: zruší rozpracovanú HTTP odpoveď bez použitia súborov', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Actual mock Hono runs; deterministic browser-boundary latency makes client cancellation observable.
  // This does not claim provider-side cancellation.
  await page.route('**/api/agent/generate', async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.goto(APP_URL);
    await chooseMockAi(page);
    await page.fill('#homeInput', idea);
    const request = page.waitForRequest(value => value.method() === 'POST' && value.url() === APP_URL + '/api/agent/generate');
    await page.click('#homeSend');
    await request;
    await expect(page.locator('#cancelBtn')).toBeVisible();
    await page.click('#cancelBtn');
    release();
    await expect.poll(() => page.evaluate(() => window.__forgeStore.getState().generating)).toBe(false);
    expect(await page.evaluate(() => ({ snapshots: window.__forgeStore.getState().snapshots.length, pending: window.__forgeStore.getState().pendingReview }))).toEqual({ snapshots: 0, pending: null });
    await expect(page.locator('.review-panel')).toHaveCount(0);
  } finally { release(); }
});

test('M3 sandbox: schválenie kompiluje React → stop → nový skutočný build → stop', async ({ page }) => {
  await page.goto(APP_URL);
  await startAi(page);
  const initialBuild = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === APP_URL + '/api/sandbox/build');
  await page.getByRole('button', { name: 'Použiť zmeny', exact: true }).click();
  expect((await initialBuild).ok()).toBe(true);
  await expect(page.frameLocator('#previewFrame').locator('body')).toContainText('CRM');
  await page.click('#editorBtn');
  await expect(page.frameLocator('#sandboxFrame').locator('body')).toContainText('CRM');
  await page.click('#edSandboxStop');
  await expect(page.locator('#sandboxFrame')).toHaveCount(0);
  const nextBuild = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === APP_URL + '/api/sandbox/build');
  await page.click('#edSandboxRun');
  expect((await nextBuild).ok()).toBe(true);
  await expect(page.frameLocator('#sandboxFrame').locator('body')).toContainText('CRM');
  await page.click('#edSandboxStop');
  await expect(page.locator('#sandboxFrame')).toHaveCount(0);
});

test('M3 sandbox: chýbajúci React entry má viditeľnú chybu', async ({ page }) => {
  await page.goto(APP_URL);
  await page.fill('#homeInput', 'SaaS landing');
  await page.click('#homeSend');
  await expect(page.locator('#previewFrame')).toBeVisible({ timeout: 10_000 });
  await page.click('#editorBtn');
  await page.click('#edSandboxRun');
  await expect(page.locator('.ed-frame-wrap').first()).toContainText('src/main.tsx');
  await expect(page.locator('#sandboxFrame')).toHaveCount(0);
});
