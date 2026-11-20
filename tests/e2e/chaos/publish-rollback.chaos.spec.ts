import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, login, openSeededProject, uniqueUser, publishState, PUBLIC_PORT } from './helpers';

/* Flow 4: Publish and rollback (agent 7) on the pg-mem fixture with the real public listener. */
const publishDialog = (page: Page) => page.getByRole('dialog', { name: 'Publikovať aplikáciu' });
const rollbackDialog = (page: Page) => page.getByRole('dialog', { name: 'Obnoviť predchádzajúcu verziu' });
const V1_TITLE = 'Kontrola cielenej zmeny', V2_TITLE = 'Chaos second release';

async function openPublish(page: Page) {
  await page.click('#publishBtn');
  await expect(publishDialog(page)).toBeVisible();
  await expect(publishDialog(page).getByText('Overujem hosting…')).toHaveCount(0);
  await publishDialog(page).getByRole('checkbox', { name: /Súhlasím so zverejnením/ }).check();
}
/** Publishes the current version; `double` double-clicks the button. Returns the immutable public URL. */
async function publish(page: Page, double = false): Promise<string> {
  await openPublish(page);
  const button = publishDialog(page).getByRole('button', { name: 'Publikovať zvolenú verziu' });
  if (double) await button.dblclick(); else await button.click();
  const link = publishDialog(page).getByRole('link', { name: 'Otvoriť verejnú aplikáciu' });
  await expect(link).toBeVisible({ timeout: 90_000 });
  const url = (await link.getAttribute('href'))!;
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PUBLIC_PORT}/p/[0-9a-f-]{36}/$`));
  return url;
}
async function closePublish(page: Page) {
  await publishDialog(page).getByRole('button', { name: 'Zavrieť publikovanie' }).click();
  await expect(publishDialog(page)).toHaveCount(0);
}
async function publicHtml(request: APIRequestContext, url: string) {
  const response = await request.get(url, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(response.headers()['cache-control']).toBe('no-cache');
  return response.text();
}
/** Second version: edit src/App.tsx in the code editor and save it (Ctrl+S). */
async function editAndSave(page: Page) {
  await page.click('[data-tab="raw"]');
  await page.getByRole('button', { name: 'Otvoriť src/App.tsx' }).click();
  await page.getByRole('button', { name: 'Jednoduchý editor', exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Úprava src/App.tsx' });
  await box.fill((await box.inputValue()).replace(V1_TITLE, V2_TITLE));
  await page.keyboard.press('Control+S');
  await expect(page.locator('#codeSaveAll')).toHaveText('Uložiť');
  await page.click('[data-tab="preview"]');
  await expect(page.frameLocator('#previewFrame').locator('h1')).toHaveText(V2_TITLE, { timeout: 30_000 });
}
async function liveUrl(request: APIRequestContext, user: string) {
  const state = await publishState(request, user);
  expect(state.live).toHaveLength(1);
  return state.live[0].url;
}

test.describe('publish a rollback', () => {
  test('4 happy: publish → no-cache HTML, hashed asset 404 no-store, druhý publish, rollback myšou → HTML späť', async ({ page, request }) => {
    const user = uniqueUser('pub-mouse');
    await login(page, user, { seed: 'clean' });
    await openSeededProject(page);
    const first = await publish(page);
    const html1 = await publicHtml(request, first);
    expect(html1).toContain(V1_TITLE);
    const asset = await request.get(first + 'index.3f2a9c1b.js');
    expect(asset.status()).toBe(404);
    expect(asset.headers()['cache-control']).toBe('no-store');
    await closePublish(page);
    await editAndSave(page);
    const second = await publish(page);
    expect(second).not.toBe(first);
    const html2 = await publicHtml(request, second);
    expect(html2).toContain(V2_TITLE);
    expect(html2).not.toContain(V1_TITLE);
    // Rollback with the mouse to the first published revision.
    await publishDialog(page).getByRole('button', { name: 'Obnoviť predchádzajúcu verziu…' }).click();
    await expect(rollbackDialog(page).getByRole('radio')).toHaveCount(2);
    const state = await publishState(request, user);
    const firstRevision = state.jobs[0].revision;
    await rollbackDialog(page).getByRole('radio', { name: new RegExp('Revízia ' + firstRevision + '\\b') }).click();
    await rollbackDialog(page).getByRole('checkbox', { name: /Potvrdzujem prepnutie/ }).click();
    await rollbackDialog(page).getByRole('button', { name: 'Obnoviť zvolenú verziu' }).click();
    await expect(rollbackDialog(page)).toHaveCount(0);
    expect(await publicHtml(request, await liveUrl(request, user))).toBe(html1);
    // The immutable archive is untouched: still exactly two published versions.
    expect((await publishState(request, user)).jobs.map(j => j.state)).toEqual(['published', 'published']);
  });

  test('4 chaos: dvojklik na „Publikovať“ a dvojité potvrdenie rollbacku klávesnicou → jedna verzia, konzistentný stav', async ({ page, request }) => {
    const user = uniqueUser('pub-double');
    const posts: string[] = [];
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/publish(\/project\/[^/]+\/rollback)?$/.test(new URL(r.url()).pathname)) posts.push(new URL(r.url()).pathname); });
    await login(page, user, { seed: 'clean' });
    await openSeededProject(page);
    const first = await publish(page, true);
    const html1 = await publicHtml(request, first);
    let state = await publishState(request, user);
    expect(state.jobs).toHaveLength(1);
    expect(posts.filter(p => p === '/api/publish')).toHaveLength(1);
    await closePublish(page);
    await editAndSave(page);
    await publish(page);
    state = await publishState(request, user);
    expect(state.jobs).toHaveLength(2);
    // Rollback with the keyboard only; the submit key is pressed twice in a row.
    await publishDialog(page).getByRole('button', { name: 'Obnoviť predchádzajúcu verziu…' }).press('Enter');
    const radios = rollbackDialog(page).getByRole('radio');
    await expect(radios).toHaveCount(2);
    await expect(radios.first()).toBeChecked(); // newest is preselected
    await radios.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(1)).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(rollbackDialog(page).getByRole('checkbox', { name: /Potvrdzujem prepnutie/ })).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(rollbackDialog(page).getByRole('button', { name: 'Obnoviť zvolenú verziu' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(rollbackDialog(page)).toHaveCount(0);
    expect(await publicHtml(request, await liveUrl(request, user))).toBe(html1);
    state = await publishState(request, user);
    expect(state.jobs).toHaveLength(2);
    expect(state.live).toHaveLength(1);
    expect(state.live[0].requestId).toBe(state.jobs[0].requestId);
    expect(posts.filter(p => p.endsWith('/rollback')).length).toBeLessThanOrEqual(2);
    await expect(publishDialog(page)).toBeVisible();
  });

  // F5 (REPORT.md): PublishDialog.tsx:137 passes liveVersion={null} to RollbackDialog, but once a stable address exists
  // service.ts:299-300 requires expectedVersion === current version → the second rollback ends with 409 publish_live_conflict.
  test.fixme('4 chaos: druhý rollback (späť na novšiu verziu) z toho istého dialógu', async ({ page, request }) => {
    const user = uniqueUser('pub-twice');
    await login(page, user, { seed: 'clean' });
    await openSeededProject(page);
    await publish(page);
    await closePublish(page);
    await editAndSave(page);
    const second = await publish(page);
    const html2 = await publicHtml(request, second);
    const rollbackTo = async (index: number) => {
      await publishDialog(page).getByRole('button', { name: 'Obnoviť predchádzajúcu verziu…' }).click();
      const radios = rollbackDialog(page).getByRole('radio');
      await expect(radios).toHaveCount(2);
      await radios.nth(index).check();
      await rollbackDialog(page).getByRole('checkbox', { name: /Potvrdzujem prepnutie/ }).check();
      await rollbackDialog(page).getByRole('button', { name: 'Obnoviť zvolenú verziu' }).click();
    };
    await rollbackTo(1);
    await expect(rollbackDialog(page)).toHaveCount(0);
    await rollbackTo(0);
    await expect(rollbackDialog(page).getByRole('alert')).toHaveCount(0);
    await expect(rollbackDialog(page)).toHaveCount(0);
    expect(await publicHtml(request, await liveUrl(request, user))).toBe(html2);
  });
});
