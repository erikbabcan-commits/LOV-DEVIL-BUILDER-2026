// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { autofixLoop } from '../../../server/agent/autofix';
import type { AIProvider } from '../../../server/providers/types';

/* Step 4: AUTOFIX — bounded repair loop s mock providerom (deterministické CI). */

function mockFixingProvider(): AIProvider {
  return {
    name: 'mock-fix',
    model: 'mock-fix',
    async complete(messages) {
      /* AI vráti opravený main.tsx (syntax chyba → validný kód) */
      return {
        text: JSON.stringify({
          files: [
            { path: 'src/main.tsx', content: 'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<h1>FIXED</h1>);' },
          ],
        }),
        usage: { promptTokens: 10, completionTokens: 50 },
      };
    },
    async *stream() { yield { delta: '' }; },
  };
}

function mockUselessProvider(): AIProvider {
  return {
    name: 'mock-bad',
    model: 'mock-bad',
    async complete() {
      return { text: 'blbosť bez json', usage: { promptTokens: 0, completionTokens: 0 } };
    },
    async *stream() { yield { delta: '' }; },
  };
}

const brokenFiles = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }) },
  { path: 'src/main.tsx', content: 'const x = {' }, // syntax chyba
];

describe('AUTOFIX (Step 4)', () => {
  it('build chyba → AI patch → rebuild úspešný v 1 pokuse', async () => {
    const r = await autofixLoop(mockFixingProvider(), brokenFiles);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.patchesApplied).toBe(1);
    expect(r.buildErrors.length).toBe(1); // z prvého buildu
    /* finálne súbory sú opravené */
    const main = r.finalFiles.find(f => f.path === 'src/main.tsx');
    expect(main?.content).toContain('FIXED');
    expect(r.history.some(h => h.phase === 'done')).toBe(true);
  });

  it('AI nevie opraviť → max 2 pokusy, ok=false, explicitné chyby', async () => {
    const r = await autofixLoop(mockUselessProvider(), brokenFiles);
    expect(r.ok).toBe(false);
    expect(r.attempts).toBeLessThanOrEqual(2);
    expect(r.buildErrors.length).toBeGreaterThan(0);
    expect(r.history.some(h => h.message.includes('AI patch zlyhal'))).toBe(true);
  });

  it('už fungujúci build → 0 pokusov, ok=true', async () => {
    const goodFiles = [
      { path: 'src/main.tsx', content: 'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<h1>OK</h1>);' },
    ];
    const r = await autofixLoop(mockFixingProvider(), goodFiles);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(0);
    expect(r.patchesApplied).toBe(0);
  });

  it('AI patch je minimálny — nemení súbory, ktoré opravovať netreba', async () => {
    const files = [
      ...brokenFiles,
      { path: 'src/App.tsx', content: 'export default function App(){ return <h1> untouched</h1>; }' },
    ];
    const r = await autofixLoop(mockFixingProvider(), files);
    const app = r.finalFiles.find(f => f.path === 'src/App.tsx');
    expect(app?.content).toContain('untouched');
  });
});
