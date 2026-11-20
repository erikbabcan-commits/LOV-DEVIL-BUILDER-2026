// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildProject, LOADABLE_SCRIPT_EXTENSIONS } from '../../../server/sandbox/builder';
import { AST_GUARD_EXTENSIONS, scanFiles } from '../../../server/sandbox/astGuard';

/* Bora P2-3 (wave 1 @ 2e479d4): a non-script file is skipped by the AST guard, so the
   builder must never load it as code. */
const main = { path: 'src/main.tsx', content: "import './evil.txt';\nexport {};\n" };
const evil = { path: 'src/evil.txt', content: "eval('1'); new Function('return 1')(); console.log(process.env);\n" };

describe('AST guard cannot be bypassed via a non-code import (P2-3)', () => {
  it('the guard skips src/evil.txt, but the builder refuses to load it', async () => {
    expect(scanFiles([main, evil]).ok).toBe(true); // guard alone does not see it (documented scope)
    const result = await buildProject([main, evil]);
    expect(result.ok).toBe(false);
    expect(result.html).toBeNull();
    expect(result.errors.map(e => e.message).join('\n')).toMatch(/nepodporovaný typ súboru/);
  });

  it('builder code extensions are exactly the guard extensions', () => {
    expect(LOADABLE_SCRIPT_EXTENSIONS.source).toBe(AST_GUARD_EXTENSIONS.source);
    expect(LOADABLE_SCRIPT_EXTENSIONS.flags).toBe(AST_GUARD_EXTENSIONS.flags);
  });

  it('css and json imports still build', async () => {
    const result = await buildProject([
      { path: 'src/main.tsx', content: "import './a.css';\nimport data from './d.json';\nconsole.log(data);\n" },
      { path: 'src/a.css', content: 'body{color:red}' },
      { path: 'src/d.json', content: '{"a":1}' },
    ]);
    expect(result.ok).toBe(true);
  });
});
