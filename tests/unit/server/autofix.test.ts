// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import { autofixLoop } from '../../../server/agent/autofix';
import type { AIProvider } from '../../../server/providers/types';
import * as sandbox from '../../../server/sandbox/builder';
import { containsPotentialSecret } from '../../../server/security/secrets';

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

afterEach(() => vi.restoreAllMocks());

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

  it('nové cesty zachovajú povolené znaky a zamietnu traversal aj nepovolené znaky', async () => {
    const modulePath = 'src/features/feature_flags-v2.1.ts';
    const rejectedPaths = [
      '../escape.ts', 'src/../escape.ts', 'src/bad file.ts',
      'src/bad:name.ts', 'src\\bad.ts', 'src/bad?.ts',
    ];
    const provider: AIProvider = {
      name: 'mock-paths',
      model: 'mock-paths',
      async complete() {
        return {
          text: JSON.stringify({
            files: [
              {
                path: 'src/main.tsx',
                content: 'import { createRoot } from "react-dom/client";\nimport { label } from "./features/feature_flags-v2.1.ts";\ncreateRoot(document.getElementById("root")!).render(<h1>{label}</h1>);',
              },
              { path: modulePath, content: 'export const label = "PATH_OK";' },
              ...rejectedPaths.map(path => ({ path, content: 'export const rejected = true;' })),
            ],
          }),
          usage: { promptTokens: 10, completionTokens: 80 },
        };
      },
      async *stream() { yield { delta: '' }; },
    };

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.finalFiles.map(file => file.path)).toEqual([
      'package.json', 'src/main.tsx', modulePath,
    ]);
    expect(result.finalFiles.find(file => file.path === modulePath)?.content).toContain('PATH_OK');
  });

  it('provider error sa redaktuje pred skrátením a bezpečný detail ostane užitočný', async () => {
    const canary = ['mstrl', 'AUTOFIX_PROVIDER_CANARY_0123456789'].join('_');
    const provider = mockFixingProvider();
    // The original credential crosses the 120-character history truncation boundary.
    const complete = vi.spyOn(provider, 'complete').mockRejectedValue(new Error(`HTTP 401: ${'detail '.repeat(10)}${canary} credential rejected`));

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain('mstrl_');
    expect(result.history.at(-1)?.message).toContain('HTTP 401:');
    expect(result.history.at(-1)?.message).toContain('[REDACTED] credential rejected');
  });

  it.each(['path', 'content'] as const)('tajomstvo vo vstupnom %s sa nevráti ani nepostúpi do buildu či AI', async field => {
    const canary = ['ghp', 'AUTOFIX_INPUT_CANARY_0123456789'].join('_');
    const files = [
      ...brokenFiles,
      {
        path: field === 'path' ? `src/${canary}.ts` : 'src/config.ts',
        content: field === 'content' ? `export const token = "${canary}";` : 'export const safe = true;',
      },
    ];
    const build = vi.spyOn(sandbox, 'buildProject');
    const provider = mockFixingProvider();
    const complete = vi.spyOn(provider, 'complete');

    const result = await autofixLoop(provider, files);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.finalFiles).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.history[0].message).toContain('zablokované');
  });

  it.each(['raw', 'escaped'] as const)('tajomstvo vo výstupe modelu (%s) sa neaplikuje ani nepoužije pri follow-up', async encoding => {
    const canary = ['mstrl', 'AUTOFIX_OUTPUT_CANARY_0123456789'].join('_');
    const text = JSON.stringify({ files: [{ path: 'src/main.tsx', content: `const token = "${canary}"; const broken = {` }] });
    const responseText = encoding === 'escaped' ? text.replace('mstrl_', 'mstrl\\u005f') : text;
    expect(containsPotentialSecret(responseText)).toBe(encoding === 'raw');
    const build = vi.spyOn(sandbox, 'buildProject');
    const provider = mockFixingProvider();
    const complete = vi.spyOn(provider, 'complete').mockResolvedValue({
      text: responseText,
      usage: { promptTokens: 10, completionTokens: 20 },
    });

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.patchesApplied).toBe(0);
    expect(result.finalFiles).toEqual(brokenFiles);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(build.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.history.at(-1)?.message).toContain('potenciálne tajomstvo');
  });

  it.each(['diagnostic', 'exception'] as const)('build %s redaktuje tajomstvo pred ďalším AI volaním aj JSON výsledkom', async kind => {
    const canary = ['ghp', 'AUTOFIX_BUILD_CANARY_0123456789'].join('_');
    const build = vi.spyOn(sandbox, 'buildProject');
    if (kind === 'diagnostic') {
      build.mockResolvedValueOnce({
        ok: false, html: null, durationMs: 1, moduleCount: 2,
        errors: [{ file: `src/${canary}.tsx`, message: `Syntax error near ${canary}: missing closing brace` }],
      });
    } else {
      build.mockRejectedValueOnce(new Error(`Build worker failed near ${canary}: missing closing brace`));
    }
    build.mockResolvedValueOnce({ ok: true, html: '<!doctype html>', durationMs: 1, moduleCount: 2, errors: [] });
    const provider = mockFixingProvider();
    const complete = vi.spyOn(provider, 'complete');

    const result = await autofixLoop(provider, brokenFiles);

    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(complete.mock.calls)).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result.buildErrors)).toContain('[REDACTED]');
    expect(JSON.stringify(result.buildErrors)).toContain('missing closing brace');
  });
});
