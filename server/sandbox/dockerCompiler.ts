import { randomUUID } from 'node:crypto';
import { dockerCommand, type DockerCommand } from './command';
import { SandboxError } from './errors';
import { parseBuildResult, type SandboxFile, type BuildResult } from './policy';

export interface CompilerWorker {
  ready(): Promise<boolean>;
  compile(files: SandboxFile[], signal: AbortSignal): Promise<BuildResult>;
}

export function workerCreateArgs(name: string, image: string): string[] {
  return ['create', '-i', '--name', name, '--label', 'lov-devil.sandbox=ws4',
    '--init', '--pull=never', '--network=none', '--read-only', '--memory=256m', '--memory-swap=256m',
    '--cpus=0.5', '--pids-limit=128', '--user=65532:65532', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--log-driver=none',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=33554432,uid=65532,gid=65532,mode=700',
    '--workdir=/app', '--env', 'NODE_ENV=production', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', image];
}

/** This class belongs ONLY to the trusted runner, never to the public API process. */
export class DockerCompiler implements CompilerWorker {
  private imageId?: string;
  private quarantined = false;
  constructor(private readonly image = 'lov-devil-sandbox:ws4', private readonly command: DockerCommand = dockerCommand(),
    private readonly executionMs = 20_000) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(image) || executionMs < 1 || executionMs > 20_000)
      throw new Error('Invalid trusted worker configuration');
  }
  async ready(): Promise<boolean> {
    if (this.quarantined) return false;
    try {
      const info = await this.command(['info', '--format', '{{json .}}'], undefined, { timeoutMs: 3000, maxStdout: 128_000 });
      const data = JSON.parse(info.stdout);
      // Docker's JSON field is CpuCfsQuota (the Go template field is CPUCfsQuota).
      if (info.code !== 0 || data.OSType !== 'linux' || data.MemoryLimit !== true || data.SwapLimit !== true ||
          data.CpuCfsQuota !== true || data.PidsLimit !== true) return false;
      if (!this.imageId) {
        const leftovers = await this.command(['ps', '-aq', '--filter', 'label=lov-devil.sandbox=ws4'], undefined, { timeoutMs: 3000, maxStdout: 100_000 });
        // Never overlap a previous runner's orphan after a crash/restart. An operator
        // must reconcile these containers before readiness can recover.
        if (leftovers.code !== 0 || leftovers.stdout.trim()) return false;
      }
      const image = await this.command(['image', 'inspect', '--format', '{{.Id}}', this.imageId ?? this.image], undefined, { timeoutMs: 3000, maxStdout: 1000 });
      if (image.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) return false;
      // Pin one immutable image for this runner lifetime.
      this.imageId ??= image.stdout.trim();
      return true;
    } catch { return false; }
  }
  private async cleanup(name: string) {
    // CLI cancellation does not kill the daemon-side container. Remove it by our own generated name.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.command(['rm', '--force', name], undefined, { timeoutMs: 3000, maxStdout: 1000 }).catch(() => undefined);
      try {
        const check = await this.command(['inspect', '--format', '{{.Id}}', name], undefined, { timeoutMs: 3000, maxStdout: 1000 });
        if (check.code !== 0 && /No such (object|container)/i.test(check.stderr)) return;
      } catch { /* cannot prove cleanup yet */ }
    }
    this.quarantined = true;
    throw new SandboxError('sandbox_cleanup_failed');
  }
  async compile(files: SandboxFile[], signal: AbortSignal): Promise<BuildResult> {
    if (this.quarantined || (!this.imageId && !(await this.ready()))) throw new SandboxError('sandbox_unavailable');
    if (signal.aborted) throw new SandboxError('sandbox_aborted');
    const name = 'lov-sandbox-' + randomUUID();
    const deadline = Date.now() + this.executionMs;
    let createUncertain = true;
    try {
      // Do not cancel create halfway through a daemon request. Finish the bounded create,
      // then honour cancellation before start, so cleanup has a confirmed object to remove.
      const created = await this.command(workerCreateArgs(name, this.imageId!), undefined,
        { timeoutMs: Math.min(5000, deadline - Date.now()), maxStdout: 1000 });
      createUncertain = false;
      if (created.code !== 0) throw new SandboxError('sandbox_unavailable');
      if (signal.aborted) throw new SandboxError('sandbox_aborted');
      if (Date.now() >= deadline) throw new SandboxError('sandbox_timeout');
      const result = await this.command(['start', '--attach', '--interactive', name], JSON.stringify({ files }),
        { signal, timeoutMs: deadline - Date.now() });
      const inspected = await this.command(['inspect', '--format', '{{json .State}}', name], undefined,
        { signal, timeoutMs: 3000, maxStdout: 8000 });
      const state = JSON.parse(inspected.stdout);
      if (result.code !== 0 || inspected.code !== 0 || state.Running || state.ExitCode !== 0 || state.OOMKilled)
        throw new SandboxError('sandbox_worker_failed');
      try { return parseBuildResult(JSON.parse(result.stdout)); }
      catch { throw new SandboxError('sandbox_protocol'); }
    } catch (error) {
      if (createUncertain) {
        // A daemon may finish a timed-out create after an absence check. Quarantine
        // before cleanup and never admit another build until operator reconciliation.
        this.quarantined = true;
        throw new SandboxError('sandbox_cleanup_failed');
      }
      throw error;
    } finally {
      // The queue retains its slot until cleanup is confirmed; cleanup failure
      // still takes priority over a build result or error and quarantines the runner.
      await this.cleanup(name);
    }
  }
}
