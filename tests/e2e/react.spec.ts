import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../screenshots-react');

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test('landing: načíta sa bez JS chýb, vizuálna baseline desktop', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:5173');
  await expect(page.locator('#homeInput')).toBeVisible();
  await expect(page.locator('h1')).toContainText('Čo chceš');
  expect(errors).toEqual([]);
  await page.screenshot({ path: SHOTS + '/01-landing-desktop.png' });
});

test('generovanie: SaaS template → workspace + preview iframe + agent plán', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'vygeneruj mi SaaS landing page');
  await page.click('#homeSend');
  await expect(page.locator('#previewFrame')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.plan')).toBeVisible();
  await expect(page.locator('.plan-step.done').first()).toBeVisible({ timeout: 10_000 });
  const srcdoc = await page.locator('#previewFrame').getAttribute('srcdoc');
  expect(srcdoc).toContain('hero');
  /* parity s legacy procedúrou: expand history pred screenshotom */
  await page.click('#histToggle');
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/02-workspace-desktop.png' });
});

test('kanban template: prompt → kanban generátor', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'vytvor kanban board');
  await page.click('#homeSend');
  await expect(page.locator('#previewFrame')).toBeVisible({ timeout: 10_000 });
  const srcdoc = await page.locator('#previewFrame').getAttribute('srcdoc');
  expect(srcdoc).toContain('board');
});

test('editor: dashboard + VFS súbory + história', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS landing');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await page.click('#editorBtn');
  await expect(page.locator('#editorView')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/07-editor-desktop.png' });
  // Súbory tab
  await page.click('[data-edtab="files"]');
  await expect(page.locator('#edCodeFile')).toContainText('index.html');
  const fileItems = await page.locator('.ed-fileitem').count();
  expect(fileItems).toBe(4); // index.html, styles.css, app.js, README.md
  // História tab
  await page.click('[data-edtab="history"]');
  await expect(page.locator('.ed-commit').first()).toBeVisible();
  await expect(page.locator('.head-badge')).toBeVisible();
});

test('zoom + viewport segment', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await expect(page.locator('#zoomIn')).toBeVisible();
  await page.click('#zoomIn');
  await expect(page.locator('#zoomVal')).toHaveText('110%');
  await page.click('#viewportSeg [data-vp="mobile"]');
  // viewport zmena v store (šírka device)
  const w = await page.locator('#device').evaluate(el => el.style.width);
  expect(w).toContain('390');
});

test('mobile: mtabs navigácia', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173');
  await expect(page.locator('.home')).toBeVisible();
  await page.fill('#homeInput', 'SaaS');
  await page.click('#homeSend');
  // na mobile je canvas skrytý (data-view=chat) — čakaj na správu v chate, potom prepní na canvas
  await expect(page.locator('.plan-step.done').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.mtabs')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/10-workspace-mobile.png' });
  await page.click('.mtabs [data-view="canvas"]');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await page.screenshot({ path: SHOTS + '/08-editor-mobile.png' });
});

test('história: snapshot restore funguje (immutability parita)', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS landing');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  // Ctrl+S checkpoint
  await page.keyboard.press('Control+s');
  await expect(page.locator('#snapCount')).toHaveText('2', { timeout: 5_000 });
  // expand history (ako v legacy) → view snapshot v1 → read-only banner
  await page.click('#histToggle');
  await page.locator('.hist-list .snap').first().locator('.view').click();
  await expect(page.locator('#histBanner.show')).toBeVisible();
  await expect(page.locator('#histBannerText')).toContainText('v1');
  // späť na live
  await page.click('#backToLive');
  await expect(page.locator('#histBanner.show')).toHaveCount(0);
});
