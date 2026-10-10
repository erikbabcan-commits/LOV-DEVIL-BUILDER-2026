// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildProject, APPROVED_DEPS } from '../../../server/sandbox/builder';

/* M3 sandbox: izolovaný build vygenerovaného projektu (compile-only; kód beží len v iframe). */

const crmFiles = [
  { path: 'package.json', content: JSON.stringify({ name: 'crm', private: true, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }) },
  { path: 'index.html', content: '<!doctype html><html><body><div id="root"></div></body></html>' },
  { path: 'src/main.tsx', content: 'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);' },
  { path: 'src/App.tsx', content: 'import Sidebar from "./components/Sidebar";\nexport default function App(){ return <div><Sidebar/><h1>CRM LIVE</h1></div>; }' },
  { path: 'src/components/Sidebar.tsx', content: 'export default function Sidebar(){ return <nav>CRM menu</nav>; }' },
];

describe('M3 sandbox builder (izolovaný React build)', () => {
  it('vygenerovaný React projekt sa reálne zbundluje do spustiteľného HTML', async () => {
    const r = await buildProject(crmFiles);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.moduleCount).toBe(5);
    expect(r.html).toBeTruthy();
    /* bundle obsahuje App kód + React runtime + entry mount */
    expect(r.html).toContain('CRM menu');
    expect(r.html).toContain('CRM LIVE');
    expect(/jsx|jsxs|jsxDEV/.test(r.html!)).toBe(true);
    expect(/createRoot/.test(r.html!)).toBe(true);
    /* sandbox error handler postMessage */
    expect(r.html).toContain('forge-sandbox-error');
    expect(r.html).toContain('id="root"');
  });

  it('multi-file imports sa resolvujú (main → App → Sidebar)', async () => {
    const r = await buildProject(crmFiles);
    expect(r.ok).toBe(true);
    /* ak by import zlyhal, build by spadol s "modul nenájdený" */
    expect(r.html).toContain('CRM menu');
  });

  it('syntax chyba v generovanom kóde → presná chyba so súborom', async () => {
    const r = await buildProject([
      { path: 'package.json', content: '{}' },
      { path: 'src/main.tsx', content: 'const x = {' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(/Expected|error/i);
  });

  it('chýbajúci modul → build chyba', async () => {
    const r = await buildProject([
      { path: 'src/main.tsx', content: 'import Neexistujuci from "./Niekde";\nconsole.log(Neexistujuci);' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.message.includes('modul nenájdený') || e.message.includes('Could not resolve'))).toBe(true);
  });

  it('path traversal v generovaných súboroch → zamietnuté', async () => {
    const r = await buildProject([{ path: '../etc/evil.ts', content: 'x' }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('zakázaná cesta');
  });

  it('ne schválená dependency (axios) → zamietnutá, schválené prejdú', async () => {
    const bad = await buildProject([
      { path: 'package.json', content: JSON.stringify({ dependencies: { axios: '^1' } }) },
      { path: 'src/main.tsx', content: 'import "react";' },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toContain('axios');

    const good = await buildProject([
      { path: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.3.1' } }) },
      { path: 'src/main.tsx', content: 'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<h1>x</h1>);' },
    ]);
    expect(good.ok).toBe(true);
    expect(APPROVED_DEPS.has('react')).toBe(true);
  });

  it('chýbajúci entry (src/main.tsx) → explicitná chyba', async () => {
    const r = await buildProject([{ path: 'index.html', content: '<html></html>' }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('entry');
  });

  it('veľkostný limit → zamietnuté', async () => {
    const r = await buildProject([
      { path: 'src/main.tsx', content: 'x'.repeat(300_000) },
    ]);
    expect(r.ok).toBe(false);
  });
});
