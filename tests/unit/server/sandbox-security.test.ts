// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { astGuardFailure, AST_GUARD_CODE, redactBuildDiagnostics, redactCompilerOutput, scanFiles, scanSource } from '../../../server/sandbox/astGuard';
import { createProcessTreeProbe, DEFAULT_HOST_MEMORY_MB, MAX_HOST_MEMORY_MB, DEFAULT_HOST_TIMEOUT_MS, resolveResourceLimits, runWithResourceLimits } from '../../../server/sandbox/resourceLimiter';
import { HostExecutor, IsolatedExecutor } from '../../../server/sandbox/executor';
import { SandboxError } from '../../../server/sandbox/errors';
import * as builder from '../../../server/sandbox/builder';
import { BLUEPRINT_REGISTRY } from '../../../src/templates/registry';

/* Agent 4 — sandbox AST guard, resource limiter and diagnostic masking.
   All credentials below are fake canaries assembled at runtime, never real key material. */

const rules = (path: string, code: string) => scanSource(path, code).map(f => f.rule);
const fake = (...parts: string[]) => parts.join('');
const token = 'unit-test-private-control-token-12345';
const good = { ok: true, html: '<html>ok</html>', errors: [], durationMs: 1, moduleCount: 1 };

afterEach(() => { vi.restoreAllMocks(); });

describe('astGuard – forbidden modules', () => {
  it.each(['child_process', 'fs', 'fs/promises', 'node:fs', 'node:child_process', 'node:path', 'worker_threads', 'vm', 'net', 'http', 'https'])(
    'rejects %s via import, export-from, require, import-equals and constant import()', mod => {
      expect(rules('src/a.ts', `import x from '${mod}';`)).toEqual(['forbidden_module']);
      expect(rules('src/a.ts', `export * from "${mod}";`)).toEqual(['forbidden_module']);
      expect(rules('src/a.js', `const x = require('${mod}');`)).toEqual(['forbidden_module']);
      expect(rules('src/a.ts', `import x = require('${mod}');`)).toEqual(['forbidden_module']);
      expect(rules('src/a.ts', `const m = await import('${mod}');`)).toEqual(['forbidden_module']);
    });

  it('allows approved packages and relative imports; strings mentioning modules are not code', () => {
    expect(rules('src/App.tsx', `import { useState } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport Card from './Card';\nconst label = "child_process fs eval";`)).toEqual([]);
    expect(rules('vite.config.ts', 'import { defineConfig } from "vite"; export default defineConfig({});')).toEqual([]);
    expect(rules('src/a.ts', "type T = import('fs').Stats; const Lazy = import('./Lazy');")).toEqual([]);
  });

  it('rejects non-constant dynamic import() and require()', () => {
    expect(rules('src/a.ts', 'const name = "fs"; import(name);')).toEqual(['dynamic_import']);
    expect(rules('src/a.ts', 'const p = "x"; import(`./${p}`);')).toEqual(['dynamic_import']);
    expect(rules('src/a.js', 'const m = "fs"; require(m);')).toEqual(['dynamic_require']);
    expect(rules('src/a.js', 'module.require("vm");')).toEqual(['forbidden_module']);
  });
});

describe('astGuard – code evaluation and environment access', () => {
  it('rejects eval in direct, indirect and global forms but not as a property name', () => {
    expect(rules('src/a.ts', 'eval("1+1");')).toEqual(['eval']);
    expect(rules('src/a.ts', '(0, eval)("1");')).toEqual(['eval']);
    expect(rules('src/a.ts', 'globalThis.eval("1");')).toEqual(['eval']);
    expect(rules('src/a.ts', 'window["eval"]("1");')).toEqual(['eval']);
    expect(rules('src/a.ts', 'const o = { eval: 1 }; o.eval; class A { eval() {} }')).toEqual([]);
  });

  it('rejects new Function(...) and Function(...) including global aliases', () => {
    expect(rules('src/a.ts', 'new Function("return 1");')).toEqual(['function_constructor']);
    expect(rules('src/a.ts', 'Function("return 1")();')).toEqual(['function_constructor']);
    expect(rules('src/a.ts', 'new globalThis.Function("x");')).toEqual(['function_constructor']);
    expect(rules('src/a.ts', 'const f: Function = () => 1; f.call(null);')).toEqual([]);
  });

  it('rejects process.env access in member, element, dynamic and destructuring forms', () => {
    expect(rules('src/a.ts', 'const k = process.env.STRIPE_KEY;')).toEqual(['process_env']);
    expect(rules('src/a.ts', "const k = process['env'];")).toEqual(['process_env']);
    expect(rules('src/a.ts', 'const key = "env"; const k = process[key];')).toEqual(['process_env']);
    expect(rules('src/a.ts', 'const { env } = process;')).toEqual(['process_env']);
    expect(rules('src/a.ts', 'const { env: e } = globalThis.process;')).toEqual(['process_env']);
    expect(rules('src/a.ts', 'const { NODE_ENV } = process.env;')).toEqual(['process_env']);
    // Replaced statically by esbuild `define`, never reaches host environment.
    expect(rules('src/a.ts', 'if (process.env.NODE_ENV !== "production") console.log(1);')).toEqual([]);
  });

  it('allows import.meta.env.VITE_* and standard Vite keys, rejects other import.meta.env reads', () => {
    expect(rules('src/a.ts', 'const u = import.meta.env.VITE_API_URL; const m = import.meta.env.MODE; const d = import.meta.env.DEV;')).toEqual([]);
    expect(rules('src/a.ts', 'const s = import.meta.env.SECRET_KEY;')).toEqual(['import_meta_env']);
    expect(rules('src/a.ts', 'const all = import.meta.env;')).toEqual(['import_meta_env']);
    expect(rules('src/a.ts', 'const { env } = import.meta;')).toEqual(['import_meta_env']);
  });
});

describe('astGuard – parsing, positions and result shape', () => {
  it('parses TS, TSX, JS and JSX and reports {file, line, column, rule}', () => {
    const ts = scanSource('src/a.ts', 'interface P { a: number }\nconst x = <T,>(v: T) => v;\nimport("fs");');
    expect(ts).toEqual([{ file: 'src/a.ts', line: 3, column: 1, rule: 'forbidden_module', message: expect.any(String) }]);
    const tsx = scanSource('src/A.tsx', 'export function A(p: { n: number }) {\n  return <div onClick={() => eval("x")}>{p.n}</div>;\n}');
    expect(tsx).toEqual([{ file: 'src/A.tsx', line: 2, column: 30, rule: 'eval', message: expect.any(String) }]);
    expect(rules('src/a.js', 'export const f = (a) => a ?? 1;\nnew Function("x");')).toEqual(['function_constructor']);
    expect(rules('src/A.jsx', 'export default () => <p>{process.env.TOKEN}</p>;')).toEqual(['process_env']);
    expect(rules('src/a.mjs', 'import cp from "child_process";')).toEqual(['forbidden_module']);
  });

  it('unparsable source is rejected with a code (never a crash); the recovered tree is still scanned', () => {
    const bad = 'export const A = () => <div>;; function (';
    expect(() => scanSource('src/bad.tsx', bad)).not.toThrow();
    expect(scanSource('src/bad.tsx', bad)[0]).toMatchObject({ file: 'src/bad.tsx', rule: 'syntax_error' });
    expect(rules('src/bad.ts', 'const x = {;\nrequire("child_process");')).toEqual(['syntax_error', 'forbidden_module']);
    const result = astGuardFailure([{ path: 'src/bad.ts', content: 'const = ;' }]);
    expect(result).toMatchObject({ ok: false, html: null, moduleCount: 0 });
    expect(result!.errors[0].message).toMatch(new RegExp(`^\\[${AST_GUARD_CODE}:syntax_error\\] 1:\\d+ `));
    // Executor mode defers pure syntax errors to esbuild, but never a dangerous construct.
    expect(astGuardFailure([{ path: 'src/bad.ts', content: 'const = ;' }], { deferSyntaxErrors: true })).toBeNull();
    expect(astGuardFailure([{ path: 'src/bad.ts', content: 'const = ;\neval("1")' }], { deferSyntaxErrors: true })!.errors[0].message)
      .toContain(`[${AST_GUARD_CODE}:eval]`);
    expect(new SandboxError('sandbox_policy_blocked').status).toBe(422);
  });

  it('has no false positives on every repository blueprint template (TS/TSX/config files)', () => {
    let scanned = 0;
    for (const template of BLUEPRINT_REGISTRY) {
      const files = template.files.map(({ path, content }) => ({ path, content }));
      const result = scanFiles(files);
      expect({ id: template.id, findings: result.findings }).toEqual({ id: template.id, findings: [] });
      scanned += files.filter(f => /\.(ts|tsx)$/.test(f.path)).length;
    }
    expect(BLUEPRINT_REGISTRY.length).toBeGreaterThanOrEqual(19);
    expect(scanned).toBeGreaterThan(100);
  });

  it('skips non-code files and caps the number of findings', () => {
    expect(scanFiles([{ path: 'README.md', content: 'eval(process.env)' }, { path: 'src/a.css', content: 'eval{}' }]).ok).toBe(true);
    const many = Array.from({ length: 80 }, () => 'eval("x");').join('\n');
    expect(scanFiles([{ path: 'src/a.ts', content: many }]).findings).toHaveLength(50);
  });
});

describe('resourceLimiter', () => {
  it('defaults to a 10 s timeout and the measured 256 MB host budget; config is clamped to 128–512 MB (Docker parity)', () => {
    expect(DEFAULT_HOST_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_HOST_MEMORY_MB).toBe(256);
    expect(resolveResourceLimits({})).toMatchObject({ timeoutMs: 10_000, memoryLimitMb: 256 });
    expect(resolveResourceLimits({ SANDBOX_HOST_TIMEOUT_MS: '5000', SANDBOX_HOST_MEMORY_MB: '128' })).toMatchObject({ timeoutMs: 5000, memoryLimitMb: 128 });
    expect(resolveResourceLimits({ SANDBOX_HOST_MEMORY_MB: '50' }).memoryLimitMb).toBe(128);
    expect(resolveResourceLimits({ SANDBOX_HOST_MEMORY_MB: '4096', SANDBOX_HOST_TIMEOUT_MS: '999999' })).toMatchObject({ memoryLimitMb: 512, timeoutMs: 20_000 });
    expect(resolveResourceLimits({ SANDBOX_HOST_MEMORY_MB: '384' }).memoryLimitMb).toBe(384);
    expect(MAX_HOST_MEMORY_MB).toBe(512);
    expect(resolveResourceLimits({ SANDBOX_HOST_MEMORY_MB: 'abc', SANDBOX_HOST_TIMEOUT_MS: 'x' })).toMatchObject({ memoryLimitMb: 256, timeoutMs: 10_000 });
  });

  it('timeout kill-switch rejects a hanging build, aborts its signal and calls onKill', async () => {
    const onKill = vi.fn(); let seen: AbortSignal | undefined;
    const pending = runWithResourceLimits(signal => { seen = signal; return new Promise<never>(() => {}); },
      { limits: { timeoutMs: 30, memoryLimitMb: 256, sampleIntervalMs: 5 }, probe: () => 0, onKill });
    await expect(pending).rejects.toMatchObject({ code: 'sandbox_timeout', status: 504 });
    await vi.waitFor(() => expect(onKill).toHaveBeenCalledWith('timeout'));
    expect(seen?.aborted).toBe(true);
  });

  it('memory ceiling rejects with sandbox_memory_limit and kills the work', async () => {
    const onKill = vi.fn();
    const pending = runWithResourceLimits(() => new Promise<never>(() => {}),
      { limits: { timeoutMs: 5000, memoryLimitMb: 128, sampleIntervalMs: 5 }, probe: () => 129 * 1024 * 1024, onKill });
    await expect(pending).rejects.toMatchObject({ code: 'sandbox_memory_limit' });
    await vi.waitFor(() => expect(onKill).toHaveBeenCalledWith('memory'));
  });

  it('passes results through with peak stats, propagates errors and caller abort', async () => {
    const stats = vi.fn();
    await expect(runWithResourceLimits(async () => 42, { probe: () => 1024 }, stats)).resolves.toBe(42);
    expect(stats).toHaveBeenCalledWith(expect.objectContaining({ peakBytes: 1024 }));
    await expect(runWithResourceLimits(async () => { throw new Error('boom'); }, { probe: () => 0 })).rejects.toThrow('boom');
    const abort = new AbortController();
    const pending = runWithResourceLimits(() => new Promise<never>(() => {}), { signal: abort.signal, probe: () => 0 });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'sandbox_aborted' });
    expect(createProcessTreeProbe()()).toBeGreaterThanOrEqual(0);
  });
});

describe('diagnostic masking', () => {
  it.each([
    ['Stripe live key', fake('sk_', 'live_', 'FAKEunitCANARY0000'), 'FAKEunitCANARY0000'],
    ['Stripe test key', fake('rk_', 'test_', 'FAKEunitCANARY0001'), 'FAKEunitCANARY0001'],
    ['Stripe webhook secret', fake('whsec_', 'FAKEunitCANARY0002'), 'FAKEunitCANARY0002'],
    ['GitHub token', fake('ghp_', 'FAKEunitCANARY0003'), 'FAKEunitCANARY0003'],
    ['GitHub PAT', fake('github_', 'pat_', 'FAKE_unit_CANARY_0004'), 'FAKE_unit_CANARY_0004'],
    ['Bearer header', 'Authorization: Bearer FAKE.unit.CANARY-0005', 'FAKE.unit.CANARY-0005'],
    ['*_KEY= assignment', 'SUPABASE_SERVICE_ROLE_KEY=FAKEunitCANARY0006', 'FAKEunitCANARY0006'],
    ['*_SECRET: value', 'CRON_SECRET: "FAKEunitCANARY0007"', 'FAKEunitCANARY0007'],
    ['URL credentials', 'postgres://user:FAKEunitCANARY0008@db.local/x', 'FAKEunitCANARY0008'],
    ['Mistral key (base rules)', fake('mstrl_', 'FAKE_REDACTION_CANARY_9999'), 'FAKE_REDACTION_CANARY_9999'],
  ])('masks %s in compiler output', (_label, secret, body) => {
    const out = redactCompilerOutput(`✘ [ERROR] src/App.tsx:3:1: failed near ${secret} end`);
    expect(out).not.toContain(body);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('src/App.tsx:3:1');
  });

  it('keeps ordinary diagnostics intact', () => {
    const msg = 'src/App.tsx:1:8: ERROR: Could not resolve "./Missing" (Bearer of bad news)';
    expect(redactCompilerOutput(msg)).toBe(msg);
    expect(redactBuildDiagnostics({ ...good, errors: [{ file: 'src/a.ts', message: 'API_KEY=FAKEunitCANARY1234' }] }).errors[0].message)
      .toBe('API_KEY=[REDACTED]');
  });
});

describe('executor integration', () => {
  const blocked = [{ path: 'src/main.tsx', content: 'import { exec } from "child_process"; exec("id");' }];

  it('host executor rejects guarded code before the build and masks build diagnostics', async () => {
    const build = vi.spyOn(builder, 'buildProject');
    const result = await new HostExecutor().execute(blocked);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ file: 'src/main.tsx' });
    expect(result.errors[0].message).toContain(`[${AST_GUARD_CODE}:forbidden_module] 1:1`);
    expect(build).not.toHaveBeenCalled();
    build.mockResolvedValueOnce({ ok: false, html: null, durationMs: 1, moduleCount: 1,
      errors: [{ file: 'src/main.tsx', message: 'Authorization: Bearer FAKEunitCANARYhost01' }] });
    const masked = await new HostExecutor().execute([{ path: 'src/main.tsx', content: 'console.log(1)' }]);
    expect(JSON.stringify(masked)).not.toContain('FAKEunitCANARYhost01');
    // A pure syntax error still reaches esbuild so autofix gets the real compiler diagnostic.
    build.mockResolvedValueOnce({ ok: false, html: null, durationMs: 1, moduleCount: 1, errors: [{ file: 'src/main.tsx', message: 'Expected "}"' }] });
    await new HostExecutor().execute([{ path: 'src/main.tsx', content: 'const x = {' }]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('host executor applies the timeout kill-switch to a hanging local build', async () => {
    vi.spyOn(builder, 'buildProject').mockImplementation(() => new Promise<never>(() => {}));
    const onKill = vi.fn();
    const executor = new HostExecutor({ limits: { timeoutMs: 40, memoryLimitMb: 256, sampleIntervalMs: 10 }, probe: () => 0, onKill });
    await expect(executor.execute([{ path: 'src/main.tsx', content: 'while (true) {}' }])).rejects.toMatchObject({ code: 'sandbox_timeout' });
    await vi.waitFor(() => expect(onKill).toHaveBeenCalledWith('timeout'));
  });

  it('isolated executor never sends guarded code to the runner and masks remote diagnostics', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, html: null, durationMs: 1, moduleCount: 1,
      errors: [{ file: 'src/main.tsx', message: 'STRIPE_SECRET_KEY=FAKEunitCANARYremote1' }] }));
    const executor = new IsolatedExecutor('http://runner/', token, transport);
    expect((await executor.execute(blocked)).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    const remote = await executor.execute([{ path: 'src/main.tsx', content: 'console.log(1)' }]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(remote)).not.toContain('FAKEunitCANARYremote1');
  });
});
