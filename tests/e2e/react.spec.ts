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

test('M1.1 resizer: pointer drag zmení šírku chat panelu (constraints 340-560)', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  const before = await page.locator('#chatPanel').evaluate(el => getComputedStyle(el).width);
  // drag doprava
  await page.locator('#resizer').hover();
  await page.mouse.down();
  await page.mouse.move(500, 400, { steps: 5 });
  await page.mouse.up();
  const after = await page.locator('#chatPanel').evaluate(el => getComputedStyle(el).width);
  expect(parseInt(after)).toBeGreaterThan(parseInt(before));
  // constraint: 560 max
  await page.locator('#resizer').hover();
  await page.mouse.down();
  await page.mouse.move(900, 400, { steps: 5 });
  await page.mouse.up();
  const clamped = await page.locator('#chatPanel').evaluate(el => getComputedStyle(el).width);
  expect(parseInt(clamped)).toBeLessThanOrEqual(560);
  // dvojklik reset 420
  await page.locator('#resizer').dblclick();
  const reset = await page.locator('#chatPanel').evaluate(el => getComputedStyle(el).width);
  expect(parseInt(reset)).toBe(420);
});

test('M1.1 editor: všetkých 8 tabov prístupných (blueprints/prompts/team/gallery vrátane)', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS landing');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await page.click('#editorBtn');
  const tabs = ['preview', 'files', 'history', 'blueprints', 'prompts', 'backend', 'team', 'gallery'];
  for (const tab of tabs) {
    await page.click(`[data-edtab="${tab}"]`);
    await expect(page.locator(`.ed-pane[data-edpane="${tab}"]`)).toBeVisible();
  }
  // blueprints: 6 kariet s dátami
  await page.click('[data-edtab="blueprints"]');
  expect(await page.locator('.ed-bp').count()).toBe(6);
  await expect(page.locator('.ed-bp').first()).toContainText('SaaS Landing');
  // prompts: 8 kariet
  await page.click('[data-edtab="prompts"]');
  expect(await page.locator('.ed-prompt').count()).toBe(8);
});

test('M1.1 blueprints: klik spustí generovanie (template mód)', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS landing');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await page.click('#editorBtn');
  await page.click('[data-edtab="blueprints"]');
  await page.locator('.ed-bp[data-bp="bp-kanban"]').click();
  // vrati sa do workspace (generate prepne mode); frame sa remountuje so starým obsahom,
  // nový kanban template dorazí po ~2.2s — čakaj kým srcdoc obsahuje Kanban
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await expect.poll(async () => await page.locator('#previewFrame').getAttribute('srcdoc'), { timeout: 15_000 })
    .toContain('Kanban');
});

/* M1.1 Priority 2: deterministické vizuálne checkpointy — identický stav ako legacy procedúra:
   streaming dokončený (msg done), preview tab, history expanded, scroll top. */
test('M1.1 vizuálny checkpoint: workspace po dokončení streamovania (deterministický)', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'vygeneruj mi SaaS landing page');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  // počkať na dokončenie streamovania — posledná správa má .actions (done)
  await expect(page.locator('.msg .actions').first()).toBeVisible({ timeout: 15_000 });
  await page.click('#histToggle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOTS + '/02-workspace-desktop.png', animations: 'disabled' });
  // code / console / diff taby
  for (const [tab, shot] of [['raw', '04-code-desktop'], ['console', '05-console-desktop'], ['diff', '06-diff']] as const) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: SHOTS + '/' + shot + '.png', animations: 'disabled' });
  }
  await page.click('[data-tab="preview"]');
  await page.screenshot({ path: SHOTS + '/03-agent-mode-desktop.png', animations: 'disabled' });
  // editor + landing mobile
  await page.click('#editorBtn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOTS + '/07-editor-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/08-editor-mobile.png', animations: 'disabled' });
  await page.evaluate(() => window.history.go(0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: SHOTS + '/09-landing-mobile.png', animations: 'disabled' });
});

test('M1.1 DEBUG: device geometria', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await expect(page.locator('.msg .actions').first()).toBeVisible({ timeout: 15_000 });
  const geo = await page.evaluate(() => {
    const d = document.getElementById('device');
    const w = document.getElementById('viewportWrap');
    const f = document.getElementById('previewFrame');
    return {
      deviceW: d.style.width, deviceH: d.style.height, deviceTransform: d.style.transform,
      rect: d.getBoundingClientRect().toJSON(),
      wrapW: w.clientWidth, padding: getComputedStyle(w).padding,
      frameRect: f.getBoundingClientRect().toJSON(),
      frameSrcdocLen: (f.getAttribute('srcdoc') || '').length
    };
  });
  console.log('GEOMETRY:', JSON.stringify(geo, null, 2));
});

test('M1.1 DEBUG2: DOM štruktúra workspace', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'SaaS');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await expect(page.locator('.msg .actions').first()).toBeVisible({ timeout: 15_000 });
  const info = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const r = (el: Element | null) => el ? (el as HTMLElement).getBoundingClientRect().toJSON() : null;
    return {
      mtabs: { display: getComputedStyle(q('.mtabs')!).display, h: q('.mtabs')?.offsetHeight },
      canvasTabs: { rect: r(q('.canvas-tabs')), h: q('.canvas-tabs')?.offsetHeight },
      canvasBody: { rect: r(q('.canvas-body')) },
      viewportWrap: { rect: r(q('#viewportWrap')), pad: getComputedStyle(q('#viewportWrap')!).padding },
      device: { rect: r(q('#device')), transform: (q('#device') as HTMLElement).style.transform },
      frame: { rect: r(q('#previewFrame')), h: q('#previewFrame')?.offsetHeight },
      topbarH: q('.topbar')?.offsetHeight
    };
  });
  console.log('DOMINFO:', JSON.stringify(info, null, 2));
});
