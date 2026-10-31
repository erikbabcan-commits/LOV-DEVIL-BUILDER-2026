// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { containsPotentialSecret, redactSecrets } from '../../../server/security/secrets';
import { buildProject } from '../../../server/sandbox/builder';

const { compile } = vi.hoisted(() => ({ compile: vi.fn() }));
vi.mock('esbuild', () => ({ build: compile }));

// Deliberately fake canaries, never usable credentials or key material.
const CANARY = 'mstrl_FAKE_REDACTION_CANARY_1234567890';
const KEY_BODY = 'FAKE_PRIVATE_KEY_BODY_NOT_A_REAL_KEY';
const PRIVATE_KEY_LABELS = [
  'PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY',
  'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY',
];
const safeFiles = () => [{ path: 'src/main.tsx', content: 'console.log("safe source");' }];

beforeEach(() => {
  compile.mockReset();
  compile.mockResolvedValue({
    outputFiles: [{ path: '/out/main.js', text: 'console.log("safe compiled source");' }],
  });
});

describe('private key redaction', () => {
  it.each(PRIVATE_KEY_LABELS)('redacts the entire %s block and preserves surrounding text', label => {
    const block = `-----BEGIN ${label}-----\n${KEY_BODY}\n-----END ${label}-----`;
    expect(containsPotentialSecret(block)).toBe(true);
    expect(containsPotentialSecret(block)).toBe(true);
    expect(redactSecrets(`before\n${block}\nafter`)).toBe('before\n[REDACTED]\nafter');
  });

  it.each(PRIVATE_KEY_LABELS)('redacts truncated %s through end of input', label => {
    const truncated = `-----BEGIN ${label}-----\n${KEY_BODY}\npossibly more key material`;
    expect(containsPotentialSecret(truncated)).toBe(true);
    expect(redactSecrets(`before\n${truncated}`)).toBe('before\n[REDACTED]');
    expect(redactSecrets(`-----BEGIN ${label}-----`)).toBe('[REDACTED]');
  });

  it('redacts multiple complete blocks independently', () => {
    const first = `-----BEGIN PRIVATE KEY-----${KEY_BODY}-----END PRIVATE KEY-----`;
    const second = `-----BEGIN RSA PRIVATE KEY-----${KEY_BODY}-----END RSA PRIVATE KEY-----`;
    expect(redactSecrets(`before ${first} between ${second} after`))
      .toBe('before [REDACTED] between [REDACTED] after');
  });

  it('treats a mismatched END marker as a truncated private key', () => {
    const value = `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n${KEY_BODY}`;
    expect(containsPotentialSecret(value)).toBe(true);
    expect(redactSecrets(value)).toBe('[REDACTED]');
  });

  it('preserves ordinary text without a private-key block', () => {
    const text = 'React source, ordinary diagnostics and a public project name.';
    expect(containsPotentialSecret(text)).toBe(false);
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    CANARY,
    'sk_FAKE_REDACTION_CANARY_1234567890',
    'ghp_FAKE_REDACTION_CANARY_1234567890',
    'gho_FAKE_REDACTION_CANARY_1234567890',
    'ghu_FAKE_REDACTION_CANARY_1234567890',
    'ghs_FAKE_REDACTION_CANARY_1234567890',
    'ghr_FAKE_REDACTION_CANARY_1234567890',
    'sk-FAKE_REDACTION_CANARY_1234567890',
    'sk-proj-FAKE_REDACTION_CANARY_1234567890',
    'sk-ant-api03-FAKE_REDACTION_CANARY_1234567890',
    'github_pat_FAKE_REDACTION_CANARY_1234567890',
    'sb_secret_FAKE_REDACTION_CANARY_1234567890',
    'AKIAFAKECANARY000000',
    'NPM_TOKEN=FAKE_REDACTION_CANARY_1234567890',
  ])('retains detection and redaction for credential pattern %#', value => {
    expect(containsPotentialSecret(value)).toBe(true);
    expect(redactSecrets(`before ${value} after`)).toBe('before [REDACTED] after');
  });
});

describe('sandbox diagnostic redaction', () => {
  it.each(['src/', '../'])('rejects a credential-shaped %s file path without compiling or leaking it', async prefix => {
    const files = [{ path: `${prefix}${CANARY}.tsx`, content: 'console.log("unchanged source");' }];
    const snapshot = JSON.stringify(files);
    const result = await buildProject(files);
    expect(result.ok).toBe(false);
    expect(result.html).toBeNull();
    expect(result.moduleCount).toBe(0);
    expect(result.errors[0].file).toBe(`${prefix}[REDACTED].tsx`);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(files)).toBe(snapshot);
    expect(compile).not.toHaveBeenCalled();
  });

  it('redacts credential-shaped paths echoed by the size-limit diagnostic', async () => {
    const result = await buildProject([{ path: `src/${CANARY}.tsx`, content: 'ž'.repeat(100_001) }]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1].message).toContain('src/[REDACTED].tsx:');
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(compile).not.toHaveBeenCalled();
  });

  it('rejects source credentials without silently changing or compiling the source', async () => {
    const content = `const token = "${CANARY}";`;
    const files = [{ path: 'src/main.tsx', content }];
    const result = await buildProject(files);
    expect(result.ok).toBe(false);
    expect(result.html).toBeNull();
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(files[0].content).toBe(content);
    expect(compile).not.toHaveBeenCalled();
  });

  it('rejects a truncated private key without returning its material', async () => {
    const result = await buildProject([{
      path: 'src/main.tsx',
      content: `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}`,
    }]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY_BODY);
    expect(compile).not.toHaveBeenCalled();
  });

  it('redacts a dependency name decoded from JSON escapes', async () => {
    const packageJson = JSON.stringify({ dependencies: { [CANARY]: '1.0.0' } })
      .replace(CANARY, '\\u006d' + CANARY.slice(1));
    expect(containsPotentialSecret(packageJson)).toBe(false);
    const result = await buildProject([
      { path: 'package.json', content: packageJson }, ...safeFiles(),
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(compile).not.toHaveBeenCalled();
  });

  it('redacts both the file and message from compiler diagnostics', async () => {
    compile.mockRejectedValueOnce(new Error(`[ERROR] src/${CANARY}.tsx: upstream detail ${CANARY}`));
    const result = await buildProject(safeFiles());
    expect(result.ok).toBe(false);
    expect(result.errors[0].file).toBe('src/[REDACTED].tsx');
    expect(result.errors[0].message).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('redacts before the 800-character diagnostic cutoff', async () => {
    const message = 'x'.repeat(790) + ` ${CANARY} trailing diagnostic`;
    compile.mockRejectedValueOnce(new Error(message));
    const result = await buildProject(safeFiles());
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toBe(redactSecrets(message).slice(0, 800));
    expect(result.errors[0].message).not.toContain('mstrl_');
    expect(result.errors[0].message.length).toBeLessThanOrEqual(800);
  });

  it.each([true, false])('redacts private key body/end in a compiler error, complete=%s', async complete => {
    const key = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${complete ? '-----END PRIVATE KEY-----' : ''}`;
    compile.mockRejectedValueOnce(new Error(`compiler details: ${key}`));
    const result = await buildProject(safeFiles());
    expect(result.ok).toBe(false);
    expect(result.errors[0].message.trim()).toBe('compiler details: [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(KEY_BODY);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  it('redacts a thrown diagnostic that is not an Error object', async () => {
    compile.mockRejectedValueOnce(`compiler failure: ${CANARY}`);
    const result = await buildProject(safeFiles());
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toBe('compiler failure: [REDACTED]');
  });

  it('preserves a normal credential-free build', async () => {
    const result = await buildProject(safeFiles());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.html).toContain('safe compiled source');
    expect(compile).toHaveBeenCalledOnce();
  });
});
