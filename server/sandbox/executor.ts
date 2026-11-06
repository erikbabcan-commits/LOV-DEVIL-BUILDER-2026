import { buildProject } from './builder';
import { CompileQueue } from './queue';
import { SandboxError, type SandboxErrorCode } from './errors';
import { MAX_OUTPUT_JSON_BYTES, parseBuildResult, validationFailure, type BuildResult, type SandboxFile } from './policy';

export interface SandboxReadiness { ready: boolean; mode: 'host' | 'isolated'; }
export interface SandboxExecutor {
  execute(files: SandboxFile[], signal?: AbortSignal): Promise<BuildResult>;
  ready(): Promise<SandboxReadiness>;
}
const hostQueue = new CompileQueue();
export class HostExecutor implements SandboxExecutor {
  async ready(): Promise<SandboxReadiness> { return { ready: true, mode: 'host' }; }
  execute(files: SandboxFile[], signal?: AbortSignal) {
    return hostQueue.run(async abort => {
      const result = await buildProject(files);
      if (abort.aborted) throw new SandboxError('sandbox_aborted');
      return result;
    }, signal);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SandboxError('sandbox_protocol');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_OUTPUT_JSON_BYTES) { await reader.cancel(); throw new SandboxError('sandbox_output_limit'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SandboxError('sandbox_protocol'); }
  } finally { reader.releaseLock(); }
}
const remoteErrors = new Set<SandboxErrorCode>(['sandbox_busy', 'sandbox_queue_timeout', 'sandbox_timeout',
  'sandbox_aborted', 'sandbox_unavailable', 'sandbox_protocol', 'sandbox_worker_failed', 'sandbox_output_limit', 'sandbox_cleanup_failed']);

export class IsolatedExecutor implements SandboxExecutor {
  private readonly url: URL;
  constructor(url: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password ||
        this.url.search || this.url.hash || this.url.pathname !== '/' || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
      throw new Error('Invalid runner configuration');
  }
  private async request(path: string, files?: SandboxFile[], signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new SandboxError('sandbox_aborted');
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, files ? 90_000 : 7000);
    try {
      const response = await this.transport(new URL(path, this.url), {
        method: files ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: files ? JSON.stringify({ files }) : undefined, redirect: 'error', signal: controller.signal,
      });
      const data = await responseJson(response);
      if (!response.ok) {
        const code = (data as { error?: SandboxErrorCode })?.error;
        throw new SandboxError(code && remoteErrors.has(code) ? code : 'sandbox_unavailable');
      }
      return data;
    } catch (error) {
      if (signal?.aborted) throw new SandboxError('sandbox_aborted');
      if (error instanceof SandboxError) throw error;
      throw new SandboxError('sandbox_unavailable');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async ready(): Promise<SandboxReadiness> {
    try { return { ready: (await this.request('/ready') as { ready?: boolean }).ready === true, mode: 'isolated' }; }
    catch { return { ready: false, mode: 'isolated' }; }
  }
  async execute(files: SandboxFile[], signal?: AbortSignal): Promise<BuildResult> {
    const invalid = validationFailure(files);
    if (invalid) return invalid;
    const data = await this.request('/v1/compile', files, signal);
    try { return parseBuildResult(data); } catch { throw new SandboxError('sandbox_protocol'); }
  }
}

class UnavailableExecutor implements SandboxExecutor {
  async ready(): Promise<SandboxReadiness> { return { ready: false, mode: 'isolated' }; }
  async execute(): Promise<BuildResult> { throw new SandboxError('sandbox_unavailable'); }
}

export function createSandboxExecutor(env: NodeJS.ProcessEnv = process.env): SandboxExecutor {
  if (env.SANDBOX_MODE === 'host') return new HostExecutor();
  if (env.SANDBOX_MODE && env.SANDBOX_MODE !== 'isolated') return new UnavailableExecutor();
  try { return new IsolatedExecutor(env.SANDBOX_RUNNER_URL ?? '', env.SANDBOX_RUNNER_TOKEN ?? ''); }
  catch { return new UnavailableExecutor(); }
}
let cached: { key: string; executor: SandboxExecutor } | undefined;
export function getSandboxExecutor(): SandboxExecutor {
  const key = JSON.stringify([process.env.SANDBOX_MODE, process.env.SANDBOX_RUNNER_URL, process.env.SANDBOX_RUNNER_TOKEN]);
  if (cached?.key !== key) cached = { key, executor: createSandboxExecutor() };
  return cached.executor;
}
