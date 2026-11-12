import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BillingStatusSchema } from '../../shared/billing';

const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5174';
test('billing mobile: skutočných 390px, intervaly, sandbox a dostupný Checkout bez platobnej akcie', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const status = BillingStatusSchema.parse({ userId: 'alice', enabled: true, mode: 'sandbox', plan: 'free', subscription: null,
    prices: { month: { amount: 2000, currency: 'eur' }, year: { amount: 20000, currency: 'eur' } }, trialDays: 14,
    checkoutAvailable: true, portalAvailable: false, pendingCheckout: false });
  const start = new Date(); start.setUTCDate(1);
  const next = new Date(start); next.setUTCMonth(next.getUTCMonth() + 1);
  const unexpected: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/me': { user: { id: 'alice', email: 'alice@example.test', plan: 'free' }, quota: { used: 2, limit: 10, remaining: 8, plan: 'free' } },
      '/api/billing': status,
      '/api/projects': { projects: [], nextCursor: null },
      '/api/project-storage': { usedBytes: 0, limitBytes: 64 * 1024 * 1024, usedProjects: 0, limitProjects: 3, trashedProjects: 0, warning: false },
      '/api/ai-usage': { periodStart: start.toISOString().slice(0,10), periodEnd: next.toISOString().slice(0,10), calls: 0, reportedCalls: 0, unknownCalls: 0, pendingCalls: 0, promptTokens: 0, completionTokens: 0 },
    };
    if (request.method() !== 'GET' || !(path in responses)) {
      unexpected.push(request.method() + ' ' + path);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill({ json: responses[path] });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#homeInput')).toBeVisible();
  await page.getByRole('button', { name: 'Moje projekty', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Moje projekty' });
  const card = page.getByRole('region', { name: 'Predplatné', exact: true });
  await expect(card.getByText('Testovací režim Stripe')).toBeVisible();
  await expect(card.getByText('VORKEI Free')).toBeVisible();
  await expect(card.getByRole('radio', { name: /^Mesačne/ })).toBeChecked();
  await card.getByRole('radio', { name: /^Ročne/ }).check();
  await expect(card.getByRole('radio', { name: /^Ročne/ })).toBeChecked();
  await expect(card.getByRole('radio', { name: /^Mesačne/ })).not.toBeChecked();
  await expect(card).toContainText(/200,00\s*€\s*\/ rok/);
  const primary = card.getByRole('button', { name: 'Pokračovať do testovacieho Checkoutu', exact: true });
  await primary.scrollIntoViewIfNeeded();
  await primary.focus();
  await expect(primary).toBeVisible();
  await expect(primary).toBeFocused();
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth }));
  expect(geometry).toEqual({ width: 390, height: 844, documentWidth: 390 });
  for (const target of [dialog, primary]) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const buttonBox = (await primary.boundingBox())!;
  expect(buttonBox.y).toBeGreaterThanOrEqual(0);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(844);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const screenshot = resolve('screenshots-react/billing-mobile.png');
  mkdirSync(resolve('screenshots-react'), { recursive: true });
  await page.screenshot({ path: screenshot });
  expect(unexpected).toEqual([]);
});
