import { readFileSync, readdirSync } from 'node:fs';
import { SandboxError } from './errors';

/* Agent 4 — resource limiter for the LOCAL (non-Docker) host executor.
   Docker isolation (`--memory=512m --memory-swap=512m --cpus=0.5 --pids-limit=128`, dockerCompiler.ts)
   is the production hard limit. Raised from 256 MB to 512 MB (Erik, t664u): the policy-max input
   peaks at 244–265 MB for the whole worker process tree, which the old 256 MB cgroup would OOM-kill.

   Measurement (20. 11. 2026, box: 8 vCPU / 16 GB, Node 24.22.1, esbuild 0.28.2,
   production worker bundle `worker.mjs` exactly like deploy/Dockerfile.sandbox, peak RSS of
   the whole process tree sampled every 5 ms, 3 runs per input):
   - idle node process ........................................  41.8 MB
   - minimal project (1 file) .................................  70–75 MB (node 63 + esbuild 8)
   - all 19 repo blueprints (13 files, 7.6–10.6 kB source) ....  84.7–88.8 MB (node ~64 + esbuild ~23)
   - synthetic 15 files / 0.7 MB source (builds OK) ...........  145–147 MB (node ~80 + esbuild ~75)
   - synthetic 23 files / 1.1 MB (hits 2 MB bundle cap) .......  174–185 MB
   - synthetic 40 files / 1.98 MB (policy max input) ..........  244–265 MB (node ~100 + esbuild ~149)
   - for comparison full `vite build` of a blueprint ..........  248–262 MB (not used by the sandbox)
   Host mode accounts only what the build adds (growth of node + esbuild child RSS over the
   start of the build), so the ~42–64 MB idle node baseline is excluded. Default 256 MB: every
   measured policy-valid input fits in host mode (build growth ≤ ~165 MB), typical projects use ~1/3 of it.
   Configurable within 128–512 MB (SANDBOX_HOST_MEMORY_MB); the upper bound matches the Docker limit.
   50 MB would break normal builds. */

export const DEFAULT_HOST_TIMEOUT_MS = 10_000;
export const DEFAULT_HOST_MEMORY_MB = 256;
export const MIN_HOST_MEMORY_MB = 128;
export const MAX_HOST_MEMORY_MB = 512; // = Docker --memory (dockerCompiler.ts)
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 20_000; // never above the Docker worker deadline

export interface ResourceLimits { timeoutMs: number; memoryLimitMb: number; sampleIntervalMs: number; }
/** Returns bytes currently attributable to the build. */
export type MemoryProbe = () => number;

export function resolveResourceLimits(env: NodeJS.ProcessEnv = process.env): ResourceLimits {
  const timeout = Number(env.SANDBOX_HOST_TIMEOUT_MS ?? DEFAULT_HOST_TIMEOUT_MS);
  const memory = Number(env.SANDBOX_HOST_MEMORY_MB ?? DEFAULT_HOST_MEMORY_MB);
  return {
    timeoutMs: Number.isFinite(timeout) ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(timeout))) : DEFAULT_HOST_TIMEOUT_MS,
    // Out-of-range values are clamped, never lowered below 128 MB.
    memoryLimitMb: Number.isFinite(memory) ? Math.min(MAX_HOST_MEMORY_MB, Math.max(MIN_HOST_MEMORY_MB, Math.trunc(memory))) : DEFAULT_HOST_MEMORY_MB,
    sampleIntervalMs: 25,
  };
}

function rssBytes(pid: number | 'self'): number {
  try {
    const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
    return match ? Number(match[1]) * 1024 : 0;
  } catch { return 0; }
}
function descendants(): number[] {
  const out: number[] = [];
  const queue: Array<number | 'self'> = ['self'];
  while (queue.length && out.length < 64) {
    const pid = queue.shift()!;
    let tasks: string[] = [];
    try { tasks = readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const task of tasks) {
      try {
        for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) {
          out.push(Number(child)); queue.push(Number(child));
        }
      } catch { /* kernel without CONFIG_PROC_CHILDREN */ }
    }
  }
  return out;
}

/** Growth of the whole process tree RSS (node + esbuild service child) since the probe was created.
    Unrelated pre-existing children (tsx/vitest esbuild services) are cancelled out by the baseline.
    Non-Linux fallback: node RSS growth only. */
export function createProcessTreeProbe(): MemoryProbe {
  const linux = process.platform === 'linux';
  const treeRss = () => linux
    ? (rssBytes('self') || process.memoryUsage().rss) + descendants().reduce((sum, pid) => sum + rssBytes(pid), 0)
    : process.memoryUsage().rss;
  const baseline = treeRss();
  return () => Math.max(0, treeRss() - baseline);
}

export interface LimiterOptions {
  limits?: ResourceLimits;
  signal?: AbortSignal;
  probe?: MemoryProbe;
  /** Kill-switch: must terminate the work (e.g. esbuild.stop() kills the esbuild child). */
  onKill?: (reason: 'timeout' | 'memory') => void | Promise<void>;
}
export interface LimiterStats { peakBytes: number; durationMs: number; }

/** Races the task against a timeout and a sampled memory ceiling; the first breach kills the work. */
export function runWithResourceLimits<T>(task: (signal: AbortSignal) => Promise<T>, options: LimiterOptions = {},
  stats?: (value: LimiterStats) => void): Promise<T> {
  const limits = options.limits ?? resolveResourceLimits();
  const limitBytes = limits.memoryLimitMb * 1024 * 1024;
  if (options.signal?.aborted) return Promise.reject(new SandboxError('sandbox_aborted'));
  const probe = options.probe ?? createProcessTreeProbe();
  const controller = new AbortController();
  const started = Date.now();
  let peak = 0;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(sampler);
      options.signal?.removeEventListener('abort', onAbort);
      stats?.({ peakBytes: peak, durationMs: Date.now() - started });
      fn();
    };
    const kill = (reason: 'timeout' | 'memory', error: SandboxError) => {
      controller.abort();
      finish(() => reject(error));
      Promise.resolve().then(() => options.onKill?.(reason)).catch(() => undefined);
    };
    const sample = () => {
      const used = probe();
      if (used > peak) peak = used;
      if (used > limitBytes) kill('memory', new SandboxError('sandbox_memory_limit'));
    };
    const onAbort = () => { controller.abort(); finish(() => reject(new SandboxError('sandbox_aborted'))); };
    const timer = setTimeout(() => kill('timeout', new SandboxError('sandbox_timeout')), limits.timeoutMs);
    const sampler = setInterval(sample, limits.sampleIntervalMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => task(controller.signal)).then(
      value => { sample(); finish(() => resolve(value)); },
      error => finish(() => reject(error)),
    );
  });
}
