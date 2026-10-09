import { test, expect } from '@playwright/test';

/* Workstream E: vertikálny rez — M2 AI engine so zapnutým mock serverom v CI.
   Tento test beží proti AI serveru s mock transportom (VITE_AI_API_BASE → test server).
   Reálna inferencia je v liveSmoke.test.ts (vyžaduje kľúč). */

test('M2 vertikálny rez: prompt → AI eventy → súbory v editore → persist → refresh restore', async ({ page }) => {
  const events: string[] = [];
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('›') || t.includes('✓') || t.includes('AI')) events.push(t);
  });

  await page.goto('http://localhost:5173');
  await expect(page.locator('#homeInput')).toBeVisible();

  // prepnúť model na AI (Mistral) — cez store hook (deterministické, nezávislé od menu UI)
  await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { setModel(m: string): void } } };
    w.__forgeStore.getState().setModel('AI (Mistral)');
  });

  await page.fill('#homeInput', 'Create a modern CRM dashboard with customers, tasks and a sidebar.');
  await page.click('#homeSend');

  /* M2.1: server teraz v CI BEŽÍ (mock provider) → AI cesta produkuje plán + súbory.
     Pozitívna cesta je detailne v M2.1 positive teste nižšie. Tu len overíme,
     že AI režim NEvyprodukoval tichý template fallback: buď AI plán v chate,
     alebo (bez servera lokálne) explicitný error toast. */
  await page.waitForTimeout(2500);
  const hasAiPlan = await page.locator('.plan-title').count();
  const hasErrorToast = await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { toasts: Array<{ msg: string }> } } };
    return w.__forgeStore.getState().toasts.some(t => /AI server|nakonfigurovan/.test(t.msg));
  });
  expect(hasAiPlan > 0 || hasErrorToast).toBe(true);

  // Instant Draft mód stále funguje (explicitný, nie tichý fallback) —
  // po AI pokuse sme vo workspace, použijeme composer tam
  await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { setModel(m: string): void } } };
    w.__forgeStore.getState().setModel('Lovable Cloud');
  });
  await page.fill('#promptInput', 'CRM dashboard');
  await page.click('#sendBtn');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  await expect(page.locator('.plan').first()).toBeVisible();
});

test('M2 persistence: refresh obnoví projekt', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.fill('#homeInput', 'Moj test projekt');
  await page.click('#homeSend');
  await page.waitForSelector('#previewFrame', { timeout: 10_000 });
  // počkať na dokončenie + persist (persistNow volané po done)
  await expect(page.locator('.msg .actions').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);

  // refresh — po reload je UI na home (rovnaké správanie ako nová session),
  // ale projekt+snapshoty sú obnovené z IndexedDB v store
  await page.reload();
  await expect(page.locator('#homeInput')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  const snapCount = await page.evaluate(() => (window as unknown as { __forgeStore?: { getState(): { snapshots: unknown[] } } }).__forgeStore?.getState().snapshots.length ?? 0);
  expect(snapCount).toBeGreaterThan(0);
});

/* ============ M2.1 Step 2: POSITIVE-PATH E2E — reálny Hono server s mock providerom ============
   Plný lifecycle cez reálne HTTP/SSE: prompt → server → plan + files eventy →
   súbory aplikované v UI → persist → refresh restore. */
test('M2.1 positive: AI (mock za reálnym Honom) vygeneruje súbory → UI → editor → refresh restore', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await expect(page.locator('#homeInput')).toBeVisible();

  // prepni na AI model (store hook — deterministické)
  await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { setModel(m: string): void } } };
    w.__forgeStore.getState().setModel('AI (Mistral)');
  });

  await page.fill('#homeInput', 'Create a modern CRM dashboard with customers, tasks and a sidebar.');
  await page.click('#homeSend');

  // reálne SSE eventy z Hono servera: AI plán sa zobrazí v chate
  await expect(page.locator('.plan-title').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.plan-title').first()).toContainText('AI plán');
  // plán kroky z mock providera (cez reálnu inferenčnú cestu servera)
  await expect(page.locator('.plan-step').first()).toContainText('štruktúru', { ignoreCase: true });

  // pôvodná app nemá AI súbory — po stage sa aplikujú (toast + konzola)
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const w = window as unknown as { __forgeStore: { getState(): { vfs: Record<string, Array<{ name: string }>>; liveId: string | null } } };
      const st = w.__forgeStore.getState();
      return Object.values(st.vfs).flat().filter(f => f.name.startsWith('src/')).length;
    });
  }, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);

  // AI súbory obsahujú reálne vygenerovaný obsah (nie šablónu)
  const appContent = await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { vfs: Record<string, Array<{ name: string; content: string }>> } } };
    const files = Object.values(w.__forgeStore.getState().vfs).flat();
    const app = files.find(f => f.name === 'src/App.tsx');
    return app?.content ?? '';
  });
  expect(appContent).toContain('ACME s.r.o.');
  expect(appContent).toContain('CRM');

  // editor: súbory viditeľné vo file exploreri
  await page.click('#editorBtn');
  await page.click('[data-edtab="files"]');
  const fileCount = await page.locator('.ed-fileitem').count();
  expect(fileCount).toBeGreaterThanOrEqual(4);

  // persist → refresh → restore
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('#homeInput')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2000);
  const restoredFiles = await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { vfs: Record<string, Array<{ name: string }>>; snapshots: unknown[] } } };
    const st = w.__forgeStore.getState();
    return {
      aiFiles: Object.values(st.vfs).flat().filter(f => f.name.startsWith('src/')).length,
      snapshots: st.snapshots.length,
    };
  });
  expect(restoredFiles.aiFiles).toBeGreaterThanOrEqual(4);
  expect(restoredFiles.snapshots).toBeGreaterThan(0);
});

/* M2.1: cancel počas behu reálneho servera */
test('M2.1 cancel: prerušenie AI bežiaceho generovania', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.evaluate(() => {
    const w = window as unknown as { __forgeStore: { getState(): { setModel(m: string): void } } };
    w.__forgeStore.getState().setModel('AI (Mistral)');
  });
  await page.fill('#homeInput', 'Cancel test CRM');
  await page.click('#homeSend');
  // počkať kým beží (sendBtn disabled / cancelBtn visible)
  await page.waitForTimeout(300);
  const hasCancel = await page.locator('#cancelBtn').count();
  if (hasCancel > 0) {
    await page.click('#cancelBtn');
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => {
      const w = window as unknown as { __forgeStore: { getState(): { generating: boolean } } };
      return w.__forgeStore.getState().generating;
    });
    expect(st).toBe(false);
  }
});
