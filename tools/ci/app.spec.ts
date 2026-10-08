import { test, expect } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP = 'file://' + resolve(root, 'demo/index.html');
const SHOTS = resolve(root, 'tools/ci/screenshots');

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

let pageErrors = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
});

test.afterEach(async () => {
  // appka sama loguje cez console.debug/dbg; pageerror je tvrdá chyba
  expect(pageErrors, 'žiadne neočakávané JS výnimky: ' + pageErrors.join(' | ')).toEqual([]);
});

test('app sa načíta bez JS chýb (home)', async ({ page }) => {
  await page.goto(APP);
  await expect(page.locator('#homeInput')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/01-landing-desktop.png' });
});

test('vnútorná test suite: všetky testy zelené', async ({ page }) => {
  await page.goto(APP);
  const res = await page.evaluate(() => window.__runForgeTests());
  expect(res.fail, `zlyhané testy: ${res.fail}`).toBe(0);
  expect(res.pass).toBeGreaterThan(0);
  console.log(`SUITE: ${res.pass}/${res.pass + res.fail} zelených`);
});

test('D1 regresia: editor uloží zobrazený súbor aj bez predchádzajúceho výberu', async ({ page }) => {
  await page.goto(APP);
  const saved = await page.evaluate(() => {
    const s = { id:'d1e2e', v:1, prompt:'p', time:'10:00', kind:'saas',
      html:'<html><head><style>x{y:z}</style></head><body><h1>D1-E2E</h1><script>d1()<\/script></body></html>' };
    window.__setState({ snapshots:[s], liveId:s.id, liveHtml:s.html, viewing:null, vfs:{}, edFile:null });
    window.__goEditor();
    window.__setEdTab('files');
    window.__state().edFile = null;
    window.__renderEdFiles();
    document.getElementById('edCodeTa').value = '<html><body><h1>D1-SAVED</h1></body></html>';
    window.__saveEdFile();
    return { edFile: window.__state().edFile, html: s.html };
  });
  expect(saved.edFile).toBe('index.html');
  expect(saved.html).toContain('D1-SAVED');
});

test('D2 regresia: read-only história sa nedá prepísať cez editor', async ({ page }) => {
  await page.goto(APP);
  const histHtmlBefore = await page.evaluate(() => {
    const hist = { id:'d2e2e', v:1, prompt:'h', time:'09:00', kind:'saas', html:'<p>HIST-E2E</p>' };
    const live = { id:'d2live', v:2, prompt:'l', time:'09:30', kind:'saas', html:'<p>LIVE-E2E</p>' };
    window.__setState({ snapshots:[hist, live], liveId:live.id, liveHtml:live.html, viewing:hist, vfs:{}, edFile:'index.html' });
    window.__goEditor();
    window.__setEdTab('files');
    window.__startEdit();
    document.getElementById('edCodeTa').value = '<p>HIST-HACKED</p>';
    window.__saveEdFile();
    return hist.html;
  });
  expect(histHtmlBefore).toBe('<p>HIST-E2E</p>');
});

test('D3 regresia: multi-block roundtrip zachová obsah, poradie a sémantiku', async ({ page }) => {
  await page.goto(APP);
  const res = await page.evaluate(() => {
    // M1.1-D3d: extrahuje sa len JEDEN klasický inline script; 2+ = preservation
    const src = '<head><style>a{b:c}</style><script>first()<\/script>' +
      '<style media="print">p{color:red}<\/style>' +
      '<script type="module">mod()<\/script><script src="https://cdn.x/lib.js"><\/script></head><body>stred</body>';
    const { indexHtml, cssParts, jsParts } = window.__vfsSplitBlocks(src);
    return {
      mediaKept: indexHtml.includes('media="print"'),
      moduleKept: indexHtml.includes('type="module"'),
      srcKept: indexHtml.includes('src="https://cdn.x/lib.js"'),
      jsCount: jsParts.length,
      firstKept: indexHtml.includes('first()'),
      cssCount: cssParts.length,
      bodyKept: indexHtml.includes('stred')
    };
  });
  expect(res.jsCount).toBe(1);
  expect(res.firstKept).toBe(false);
  expect(res.cssCount).toBe(1);
  expect(res.mediaKept).toBe(true);
  expect(res.moduleKept).toBe(true);
  expect(res.srcKept).toBe(true);
  expect(res.bodyKept).toBe(true);
});

test('smoke + vizuálna baseline: workspace po generovaní (desktop aj mobile)', async ({ page }) => {
  await page.goto(APP);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.fill('#homeInput', 'vygeneruj mi SaaS landing page');
  await page.click('#homeSend');
  await page.waitForTimeout(3500);
  await expect(page.locator('#previewFrame')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/02-workspace-desktop.png' });
  await page.screenshot({ path: SHOTS + '/03-agent-mode-desktop.png' });

  await page.evaluate(() => window.__setTab('code'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/04-code-desktop.png' });
  await page.evaluate(() => window.__setTab('console'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/05-console-desktop.png' });

  await page.evaluate(() => { const b = document.getElementById('historyBar'); b.classList.add('expanded'); window.__renderHistory(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/06-history-desktop.png' });

  await page.evaluate(() => window.__goEditor());
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOTS + '/07-editor-desktop.png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/08-editor-mobile.png' });
  await page.evaluate(() => window.__goHome());
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/09-landing-mobile.png' });
  await page.evaluate(() => window.__showWorkspace());
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/10-workspace-mobile.png' });
});
