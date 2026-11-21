import type { Page } from '@playwright/test';
import { test, expect, login, openSeededProject, uniqueUser, liveSources, aiCalls, WEB } from './helpers';

/* Flow 5: AST guard shield (agent 4) — blocked before build with file:line, never sent to AI. */
const buildFailed = (page: Page) => page.getByRole('alert').filter({ hasText: 'Náhľad sa nepodarilo zostaviť.' });
const repairStatus = (page: Page) => page.locator('.repair-status');

async function preview(page: Page, seed: string) {
  await login(page, uniqueUser('ast-' + seed.replace(/^ast-/, '')), { seed });
  await openSeededProject(page);
  const build = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/sandbox/build');
  await page.getByRole('button', { name: 'Spustiť náhľad' }).click();
  return (await build).json() as Promise<{ ok: boolean; html: string | null; errors: Array<{ file: string; message: string }> }>;
}
/** Security finding: the repair button must not reach the AI (0 provider calls, blocked:'security'). */
async function expectRepairBlocked(page: Page, request: import('@playwright/test').APIRequestContext) {
  const before = await liveSources(page), calls = await aiCalls(request);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === WEB + '/api/sandbox/autofix');
  await page.getByRole('button', { name: 'Navrhnúť AI opravu' }).click();
  const body = await (await response).json();
  expect(body).toMatchObject({ ok: false, attempts: 0, blocked: 'security' });
  await expect(repairStatus(page)).toHaveAttribute('data-state', 'blocked');
  await expect(repairStatus(page)).toContainText('Build zablokovala bezpečnostná kontrola. Takéto nálezy AI neopravuje');
  expect(await aiCalls(request)).toEqual(calls);
  expect(await liveSources(page)).toEqual(before);
}

const CASES = [
  { seed: 'ast-fs', title: "import fs from 'fs'", text: 'src/App.tsx: [sandbox_policy_blocked:forbidden_module] 1:1 zakázaný modul: fs' },
  { seed: 'ast-eval', title: "eval('1')", text: 'src/App.tsx: [sandbox_policy_blocked:eval] 2:26 eval je zakázaný' },
  { seed: 'ast-env', title: 'process.env.X', text: 'src/App.tsx: [sandbox_policy_blocked:process_env] 2:20 prístup k process.env je zakázaný' },
];

test.describe('štít AST guardu', () => {
  for (const item of CASES) {
    test(`5 chaos: ${item.title} → build/náhľad zablokovaný s presnou hláškou (súbor:riadok), autofix bez AI`, async ({ page, request }) => {
      const result = await preview(page, item.seed);
      expect(result.ok).toBe(false);
      expect(result.html).toBeNull();
      await expect(buildFailed(page)).toContainText(item.text);
      await expect(page.locator('#previewFrame')).toHaveCount(0);
      await expectRepairBlocked(page, request);
    });
  }

  test("5 chaos: import './evil.txt' (ne-skriptový súbor) → build zablokovaný so súborom", async ({ page }) => {
    const result = await preview(page, 'ast-evil');
    expect(result.ok).toBe(false);
    expect(result.html).toBeNull();
    // Refused by the builder's resolver (the guard does not scan .txt), with the importing file:line.
    await expect(buildFailed(page)).toContainText('src/main.tsx:1:7');
    await expect(buildFailed(page)).toContainText('nepodporovaný typ súboru pre import: src/evil.txt');
    await expect(page.locator('#previewFrame')).toHaveCount(0);
  });

  /* FIXME(F4, REPORT.md): the non-script import refusal (server/sandbox/builder.ts:75) carries no
     `[sandbox_policy_blocked:` prefix, so server/agent/autofix.ts:101 isSecurityBlock() treats it as a
     repairable compiler error: the project incl. src/evil.txt is sent to the AI (1 paid attempt, attempts:1). */
  test.fixme("5 chaos: import './evil.txt' → autofix sa nespustí (0 volaní AI)", async ({ page, request }) => {
    await preview(page, 'ast-evil');
    await expect(buildFailed(page)).toContainText('evil.txt');
    await expectRepairBlocked(page, request);
  });

  test('5 happy: čistý projekt sa zostaví a náhľad beží', async ({ page }) => {
    const result = await preview(page, 'clean');
    expect(result.ok).toBe(true);
    await expect(page.frameLocator('#previewFrame').locator('h1')).toHaveText('Kontrola cielenej zmeny');
    await expect(buildFailed(page)).toHaveCount(0);
  });
});
