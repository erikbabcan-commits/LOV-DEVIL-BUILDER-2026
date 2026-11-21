import type { Page } from '@playwright/test';
import { test, expect, login, openSeededProject, uniqueUser, liveSources } from './helpers';

/* Flow 2: Editor (agent 6) — tabs, Ctrl/Meta+P fuzzy open, lint markers; chaos on shortcuts and saving. */
const tablist = (page: Page) => page.getByRole('tablist', { name: 'Otvorené súbory' });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name, exact: true });
const quickOpen = (page: Page) => page.getByRole('dialog', { name: 'Rýchle otvorenie súboru' });

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  return errors;
}
async function openCode(page: Page, seed: string, user: string) {
  await login(page, user, { seed });
  await openSeededProject(page);
  await page.click('[data-tab="raw"]');
  await expect(page.getByRole('region', { name: 'Editor kódu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Otvoriť src/App.tsx' })).toBeEnabled();
}

test.describe('editor: záložky, fuzzy hľadanie, lint', () => {
  test('2 happy: viac záložiek – otvorenie, prepínanie (myš aj šípky), zatvorenie', async ({ page }) => {
    const errors = pageErrors(page);
    await openCode(page, 'editor', uniqueUser('editor-tabs'));
    for (const name of ['src/App.tsx', 'src/index.css', 'src/main.tsx']) await page.getByRole('button', { name: 'Otvoriť ' + name }).click();
    // CodePane starts with index.html open; three more tabs were added.
    await expect(tablist(page).getByRole('tab')).toHaveText(['index.html', 'src/App.tsx', 'src/index.css', 'src/main.tsx']);
    await expect(tab(page, 'src/main.tsx')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'src/App.tsx').click();
    await expect(tab(page, 'src/App.tsx')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.cp-tools')).toContainText('src/App.tsx');
    await tab(page, 'src/App.tsx').press('ArrowRight');
    await expect(tab(page, 'src/index.css')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'src/index.css')).toBeFocused();
    await page.getByRole('button', { name: 'Zavrieť src/index.css' }).click();
    await expect(tablist(page).getByRole('tab')).toHaveText(['index.html', 'src/App.tsx', 'src/main.tsx']);
    await expect(tab(page, 'src/main.tsx')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'src/main.tsx').press('Delete');
    await expect(tablist(page).getByRole('tab')).toHaveText(['index.html', 'src/App.tsx']);
    expect(errors).toEqual([]);
  });

  test('2 happy: Ctrl+P aj Meta+P otvorí fuzzy hľadanie, výber otvorí záložku, Esc zavrie', async ({ page }) => {
    const errors = pageErrors(page);
    await openCode(page, 'editor', uniqueUser('editor-fuzzy'));
    await page.keyboard.press('Control+P');
    await expect(quickOpen(page)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Hľadať súbor' })).toBeFocused();
    await page.keyboard.type('fmtprice');
    await expect(quickOpen(page).getByRole('option').first()).toContainText('formatPrice');
    await page.keyboard.press('Enter');
    await expect(quickOpen(page)).toHaveCount(0);
    await expect(tab(page, 'src/utils/formatPrice.ts')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Meta+P');
    await expect(quickOpen(page)).toBeVisible();
    await page.keyboard.type('usecount');
    await quickOpen(page).getByRole('option', { name: /useCounter/ }).click();
    await expect(tab(page, 'src/hooks/useCounter.ts')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+P');
    await expect(quickOpen(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(quickOpen(page)).toHaveCount(0);
    await expect(tablist(page).getByRole('tab')).toHaveText(['index.html', 'src/utils/formatPrice.ts', 'src/hooks/useCounter.ts']);
    expect(errors).toEqual([]);
  });

  test('2 happy: lint marker na syntaktickej chybe (riadok z buildu)', async ({ page }) => {
    const errors = pageErrors(page);
    await login(page, uniqueUser('editor-lint'), { seed: 'repair' });
    await openSeededProject(page);
    await page.getByRole('button', { name: 'Spustiť náhľad' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Náhľad sa nepodarilo zostaviť.' })).toContainText('src/App.tsx:1:15');
    await page.click('[data-tab="raw"]');
    await page.getByRole('button', { name: 'Otvoriť src/App.tsx' }).click();
    await expect(page.locator('.editor-host').getByRole('alert')).toContainText('Chyby posledného náhľadu');
    const marker = page.locator('.cm-editor .cm-lintRange-error');
    await expect(marker.first()).toBeVisible();
    // The marker sits on line 1 (the line reported by esbuild).
    await expect(page.locator('.cm-editor .cm-line').first().locator('.cm-lintRange-error')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('2 chaos: rýchle opakované Ctrl+P/Esc bez pádu a bez straty záložiek', async ({ page }) => {
    const errors = pageErrors(page);
    await openCode(page, 'editor', uniqueUser('editor-spam'));
    for (const name of ['src/App.tsx', 'src/index.css']) await page.getByRole('button', { name: 'Otvoriť ' + name }).click();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(i % 2 ? 'Meta+P' : 'Control+P');
      await page.keyboard.press('Escape');
    }
    // Burst without waiting for React between keys.
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
    });
    await page.keyboard.press('Escape');
    await expect(quickOpen(page)).toHaveCount(0);
    await expect(tablist(page).getByRole('tab')).toHaveText(['index.html', 'src/App.tsx', 'src/index.css']);
    await expect(tab(page, 'src/index.css')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Editor kódu' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('2 chaos: zatváranie záložiek počas ukladania – bez pádu a bez straty obsahu', async ({ page }) => {
    const errors = pageErrors(page);
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await openCode(page, 'editor', uniqueUser('editor-save'));
    const before = await liveSources(page);
    for (const name of ['src/App.tsx', 'src/index.css']) await page.getByRole('button', { name: 'Otvoriť ' + name }).click();
    await tab(page, 'src/App.tsx').click();
    await page.getByRole('button', { name: 'Jednoduchý editor' }).click();
    const edited = before.files.find(f => f.name === 'src/App.tsx')!.content.replace('Kontrola cielenej zmeny', 'Chaos uložený nadpis');
    await page.getByRole('textbox', { name: 'Úprava src/App.tsx' }).fill(edited);
    await expect(page.locator('#codeSaveAll')).toHaveText('Uložiť (1)');
    // Save and, in the same task, try to close every tab while the save is in flight.
    await page.evaluate(() => {
      document.querySelector('.code-pane')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
      for (let i = 0; i < 3; i++) document.querySelectorAll<HTMLButtonElement>('.editor-tabs .tab-close').forEach(button => button.click());
    });
    await expect.poll(async () => (await liveSources(page)).snapshots).toBe(before.snapshots + 1);
    const after = await liveSources(page);
    expect(after.files.find(f => f.name === 'src/App.tsx')!.content).toBe(edited);
    expect(after.files.filter(f => f.name !== 'src/App.tsx')).toEqual(before.files.filter(f => f.name !== 'src/App.tsx'));
    await expect(page.locator('#codeSaveAll')).toHaveText('Uložiť');
    // The saved content is what the editor shows when the file is opened again.
    await page.getByRole('button', { name: 'Otvoriť src/App.tsx' }).click();
    await expect(tab(page, 'src/App.tsx')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.editor-host')).toContainText('Chaos uložený nadpis');
    await expect(page.locator('#codeSaveAll')).toHaveText('Uložiť');
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  /* FIXME(F3, REPORT.md): after Ctrl+S the CodeSession remounts (src/features/workspace/CodePane.tsx:54-60, key
     contains snapshot.id) and reopens only `state.edFile` (:79). Selecting a tab never updates edFile (:454-457),
     so every save closes all other tabs and switches away from the file being edited. Content is not lost. */
  test.fixme('2 záložky a aktívny súbor ostanú otvorené po uložení', async ({ page }) => {
    await openCode(page, 'editor', uniqueUser('editor-keep'));
    for (const name of ['src/App.tsx', 'src/index.css']) await page.getByRole('button', { name: 'Otvoriť ' + name }).click();
    await tab(page, 'src/App.tsx').click();
    await page.getByRole('button', { name: 'Jednoduchý editor' }).click();
    const box = page.getByRole('textbox', { name: 'Úprava src/App.tsx' });
    await box.fill((await box.inputValue()) + '\n// uložené');
    await page.keyboard.press('Control+S');
    await expect(page.locator('#codeSaveAll')).toHaveText('Uložiť');
    await expect(tablist(page).getByRole('tab')).toHaveText(['index.html', 'src/App.tsx', 'src/index.css']);
    await expect(tab(page, 'src/App.tsx')).toHaveAttribute('aria-selected', 'true');
  });
});
