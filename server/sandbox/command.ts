import { spawn } from 'node:child_process';
import { SandboxError } from './errors';
import { MAX_OUTPUT_JSON_BYTES, MAX_STDERR_BYTES } from './policy';

export interface CommandOptions { signal?: AbortSignal; timeoutMs: number; maxStdout?: number; }
export interface CommandResult { code: number | null; stdout: string; stderr: string; }
export type DockerCommand = (args: string[], input: string | undefined, opts: CommandOptions) => Promise<CommandResult>;

/** Trusted CLI only. The JSON payload is stdin, never shell syntax or process arguments. */
export function dockerCommand(binary = 'docker'): DockerCommand {
  return (args, input, opts) => new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new SandboxError('sandbox_aborted')); return; }
    const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
      'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR'].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let outBytes = 0; let errBytes = 0; let failure: SandboxError | undefined;
    const kill = (error: SandboxError) => {
      failure ??= error;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const abort = () => kill(new SandboxError('sandbox_aborted'));
    const timer = setTimeout(() => kill(new SandboxError('sandbox_timeout')), Math.max(1, opts.timeoutMs));
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > (opts.maxStdout ?? MAX_OUTPUT_JSON_BYTES)) kill(new SandboxError('sandbox_output_limit'));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_STDERR_BYTES) kill(new SandboxError('sandbox_output_limit'));
      else stderr.push(chunk);
    });
    child.stdin.on('error', () => { /* EPIPE is classified using exit status/result validation. */ });
    child.on('error', () => { failure ??= new SandboxError('sandbox_unavailable'); });
    child.on('close', code => {
      clearTimeout(timer); opts.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
    if (opts.signal?.aborted) abort();
  });
}
