// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DockerCompiler, workerCreateArgs } from '../../../server/sandbox/dockerCompiler';
import { SandboxError } from '../../../server/sandbox/errors';
import type { DockerCommand } from '../../../server/sandbox/command';

const id = 'sha256:' + 'a'.repeat(64);
const good = { ok: true, html: 'ok', errors: [], durationMs: 1, moduleCount: 1 };
function fake(scenario: 'good' | 'hang' | 'invalid' | 'cleanup' | 'create-timeout' = 'good') {
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    const result = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
    if (args[0] === 'info') return result(JSON.stringify({ OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true }));
    if (args[0] === 'image') return result(id);
    if (args[0] === 'ps') return result();
    if (args[0] === 'create') {
      if (scenario === 'create-timeout') throw new SandboxError('sandbox_timeout');
      return result('container-id');
    }
    if (args[0] === 'start') {
      if (scenario === 'hang') throw new SandboxError('sandbox_timeout');
      return result(scenario === 'invalid' ? '{}' : JSON.stringify(good));
    }
    if (args.includes('{{json .State}}')) return result('{"Running":false,"ExitCode":0,"OOMKilled":false}');
    if (args[0] === 'rm') return result();
    return scenario === 'cleanup' ? result('still-exists') : result('', 1, 'Error: No such object');
  };
  return { calls, command };
}

describe('trusted Docker orchestration', () => {
  it('uses fixed resource flags, immutable image and no host mounts or app env', async () => {
    const { command, calls } = fake(); const worker = new DockerCompiler(undefined, command);
    expect(await worker.compile([], new AbortController().signal)).toEqual(good);
    const args = calls.find(args => args[0] === 'create')!;
    expect(args).toEqual(workerCreateArgs(args[args.indexOf('--name') + 1], id));
    expect(args).toContain('--network=none'); expect(args).toContain('--memory-swap=256m');
    expect(args).toContain('--user=65532:65532'); expect(args).toContain('--read-only');
    expect(args).toContain('--cpus=0.5'); expect(args).toContain('--pids-limit=128');
    expect(args).toContain('--cap-drop=ALL'); expect(args.some(x => /socket|MISTRAL|--volume|--mount/.test(x))).toBe(false);
    expect(calls.at(-2)![0]).toBe('rm'); expect(calls.at(-1)![0]).toBe('inspect');
  });

  it.each(['hang', 'invalid'] as const)('force removes worker after %s before rejecting', async scenario => {
    const { command, calls } = fake(scenario);
    await expect(new DockerCompiler(undefined, command).compile([], new AbortController().signal))
      .rejects.toMatchObject({ code: scenario === 'hang' ? 'sandbox_timeout' : 'sandbox_protocol' });
    expect(calls.some(args => args[0] === 'rm' && args[1] === '--force')).toBe(true);
  });

  it.each(['cleanup', 'create-timeout'] as const)('quarantines on %s rather than admitting another worker', async scenario => {
    const { command, calls } = fake(scenario); const worker = new DockerCompiler(undefined, command);
    await expect(worker.compile([], new AbortController().signal)).rejects.toMatchObject({ code: 'sandbox_cleanup_failed' });
    expect(await worker.ready()).toBe(false);
    await expect(worker.compile([], new AbortController().signal)).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(1);
  });

  it('fails closed when the platform cannot enforce memory limits', async () => {
    const command: DockerCommand = async () => ({ code: 0, stdout: '{"OSType":"linux","MemoryLimit":false}', stderr: '' });
    const worker = new DockerCompiler(undefined, command);
    expect(await worker.ready()).toBe(false);
    await expect(worker.compile([], new AbortController().signal)).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  });

  it('refuses cold-start readiness while an orphan from a prior runner exists', async () => {
    const { command } = fake();
    const worker = new DockerCompiler(undefined, (args, input, opts) => args[0] === 'ps'
      ? Promise.resolve({ code: 0, stdout: 'orphan-container-id', stderr: '' }) : command(args, input, opts));
    expect(await worker.ready()).toBe(false);
    await expect(worker.compile([], new AbortController().signal)).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  });
});
