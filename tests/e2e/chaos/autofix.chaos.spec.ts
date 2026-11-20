import type { Page } from '@playwright/test';
import { test, expect, login, openSeededProject, uniqueUser, liveSources, aiCalls, storeValue, WEB } from './helpers';

/* Flow 3: Autofix (agent 9) — up to 3 attempts with the network-free fixture provider. */
const buildFailed = (page: Page) => page.getByRole('alert').filter({ hasText: 'Náhľad sa nepodarilo zostaviť.' });
const repairButton = (page: Page) => page.getByRole('button', { name: 'Navrhnúť AI opravu' });
const repairStatus = (page: Page) => page.locator('.repair-status');

async function brokenPreview(page: Page, seed: string, user: string) {
  await login(page, user, { seed });
  await openSeededProject(page);
  await page.getByRole('button', { name: 'Spustiť náhľad' }).click();
  await expect(buildFailed(page)).toContainText('src/App.tsx:');
  await expect(repairButton(page)).toBeEnabled();
}

test.describe('autofix: najviac 3 pokusy, bezpečný návrat', () => {
  test('3a happy: oprava na 1. pokus → pendingReview → po schválení build OK', async ({ page, request }) => {
    await brokenPreview(page, 'repair', uniqueUser('fix-ok'));
    const before = await liveSources(page), calls = await aiCalls(request);
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/sandbox/autofix');
    await repairButton(page).click();
    const body = await (await response).json();
    expect(body).toMatchObject({ ok: true, attempts: 1 });
    expect(body.route).toMatchObject({ model: expect.any(String), reason: expect.any(String) });
    await expect(page.locator('.review-panel')).toContainText('Návrh prešiel buildom.');
    expect(await storeValue<{ source: string } | null>(page, 'pendingReview')).toMatchObject({ source: 'patch' });
    // Nothing applied yet: the proposal waits for review.
    expect(await liveSources(page)).toEqual(before);
    expect((await aiCalls(request)).repair - calls.repair).toBe(1);
    const build = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/sandbox/build');
    await page.locator('.review-panel').getByRole('button', { name: 'Použiť zmeny', exact: true }).click();
    expect(await (await build).json()).toMatchObject({ ok: true });
    await expect(page.frameLocator('#previewFrame').locator('h1')).toHaveText('Kontrola cielenej zmeny');
    const after = await liveSources(page);
    expect(after.snapshots).toBe(before.snapshots + 1);
    expect(after.files.find(f => f.name === 'src/App.tsx')!.content).not.toContain('const broken = ;');
  });

  test('3b chaos: 3 neúspešné pokusy → ok:false, attempts:3, zdroje nezmenené, posledný funkčný stav', async ({ page, request }) => {
    await brokenPreview(page, 'repair-fail', uniqueUser('fix-fail'));
    const before = await liveSources(page), calls = await aiCalls(request);
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/sandbox/autofix');
    await repairButton(page).click();
    const body = await (await response).json();
    expect(body).toMatchObject({ ok: false, attempts: 3 });
    expect(body.blocked).toBeUndefined();
    await expect(repairStatus(page)).toHaveAttribute('data-state', 'failed');
    await expect(repairStatus(page)).toContainText('Oprava neprešla ani po 3 pokusoch. Ostal posledný funkčný stav projektu, nič sa nezmenilo.');
    await expect(repairStatus(page).getByRole('listitem')).toHaveCount(3);
    await expect(repairStatus(page)).toContainText('Pokus 3 z 3');
    expect(await storeValue(page, 'pendingReview')).toBeNull();
    expect(await liveSources(page)).toEqual(before);
    expect((await aiCalls(request)).repair - calls.repair).toBe(3);
    await expect(repairButton(page)).toBeEnabled();
  });

  test('3c chaos: autofix endpoint vráti 500 → UI použiteľné, zdroje nezmenené', async ({ page, request }) => {
    await brokenPreview(page, 'repair', uniqueUser('fix-500'));
    const before = await liveSources(page), calls = await aiCalls(request);
    await page.route('**/api/sandbox/autofix', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) }));
    await repairButton(page).click();
    await expect(page.locator('.msg').last()).toContainText('AI služba teraz nie je dostupná');
    await expect.poll(() => storeValue<boolean>(page, 'generating')).toBe(false);
    await expect(repairStatus(page)).toHaveCount(0);
    expect(await storeValue(page, 'pendingReview')).toBeNull();
    expect(await liveSources(page)).toEqual(before);
    expect((await aiCalls(request)).total).toBe(calls.total);
    // Still usable: retry the build, then a real repair succeeds once the endpoint is back.
    await page.unroute('**/api/sandbox/autofix');
    await page.getByRole('button', { name: 'Skúsiť znova' }).click();
    await expect(buildFailed(page)).toContainText('src/App.tsx:');
    await repairButton(page).click();
    await expect(page.locator('.review-panel')).toContainText('Návrh prešiel buildom.');
  });

  test('3c chaos: autofix timeout (visí) → zrušenie, UI použiteľné, zdroje nezmenené', async ({ page, request }) => {
    await brokenPreview(page, 'repair', uniqueUser('fix-hang'));
    const before = await liveSources(page), calls = await aiCalls(request);
    let hung = 0;
    await page.route('**/api/sandbox/autofix', () => { hung++; /* never answers: simulated upstream timeout */ });
    await repairButton(page).click();
    await expect(repairStatus(page)).toHaveAttribute('data-state', 'running');
    await expect(page.locator('#cancelBtn')).toBeVisible();
    await page.click('#cancelBtn');
    await expect.poll(() => storeValue<boolean>(page, 'generating')).toBe(false);
    await expect(page.locator('#cancelBtn')).toHaveCount(0);
    expect(hung).toBe(1);
    expect(await storeValue(page, 'pendingReview')).toBeNull();
    expect(await liveSources(page)).toEqual(before);
    expect((await aiCalls(request)).total).toBe(calls.total);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await expect(repairButton(page)).toBeEnabled();
  });

  test('3c chaos: autofix sieťový timeout (net::ERR_TIMED_OUT) → zrozumiteľná hláška, zdroje nezmenené', async ({ page, request }) => {
    await brokenPreview(page, 'repair', uniqueUser('fix-timeout'));
    const before = await liveSources(page), calls = await aiCalls(request);
    await page.route('**/api/sandbox/autofix', route => route.abort('timedout'));
    await repairButton(page).click();
    await expect(page.locator('.msg').last()).toContainText('AI server nie je dostupný');
    await expect.poll(() => storeValue<boolean>(page, 'generating')).toBe(false);
    expect(await storeValue(page, 'pendingReview')).toBeNull();
    expect(await liveSources(page)).toEqual(before);
    expect((await aiCalls(request)).total).toBe(calls.total);
    await expect(repairButton(page)).toBeEnabled();
  });
});
