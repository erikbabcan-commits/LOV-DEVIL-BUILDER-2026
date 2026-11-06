// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerCompiler } from '../../server/sandbox/dockerCompiler';
import { dockerCommand } from '../../server/sandbox/command';
import { createRunnerServer } from '../../server/sandbox/runner';
import { IsolatedExecutor } from '../../server/sandbox/executor';
import { createApp } from '../../server/index';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { BLUEPRINT_REGISTRY } from '../../src/templates/registry';

// Opt in only on a dedicated Linux Docker daemon. Never point this at production.
const enabled = process.env.SANDBOX_DOCKER_E2E === '1';
const command = dockerCommand();
const files = [{ path: 'src/main.tsx', content: 'import {createRoot} from "react-dom/client"; createRoot(document.getElementById("root")!).render(<h1>ISOLATED_OK</h1>);' }];
const signal = () => new AbortController().signal;
const run = (args: string[]) => command(args, undefined, { timeoutMs: 5000, maxStdout: 100_000 });
async function containers() {
  const result = await run(['ps', '-aq', '--filter', 'label=lov-devil.sandbox=ws4']);
  expect(result.code).toBe(0);
  return result.stdout.trim().split(/\s+/).filter(Boolean).sort();
}
describe.skipIf(!enabled)('real Linux Docker compile isolation', () => {
  let baseline: string[];
  beforeAll(async () => {
    expect(await new DockerCompiler().ready()).toBe(true);
    baseline = await containers();
  }, 15_000);
  afterAll(async () => { if (baseline) expect(await containers()).toEqual(baseline); });

  it.each(BLUEPRINT_REGISTRY.map(template => [template.id, template] as const))('isolates the complete %s blueprint build', async (_id, template) => {
    const files = template.files.map(({ path, content }) => ({ path, content }));
    const result = await new DockerCompiler().compile(files, signal());
    expect(result.errors).toEqual([]); expect(result.ok).toBe(true);
    expect(result.html).toContain("connect-src 'none'");
    expect(await containers()).toEqual(baseline);
  }, 25_000);

  it('compiles through API → authenticated private runner → real Docker worker', async () => {
    const token = randomBytes(32).toString('hex');
    const server = createRunnerServer(token);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const sandbox = new IsolatedExecutor(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token);
      const app = createApp({}, null, { sandbox });
      expect((await app.request('/api/sandbox/ready')).status).toBe(200);
      const response = await app.request('/api/sandbox/build', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
      expect(response.status).toBe(200); expect((await response.json()).html).toContain('ISOLATED_OK');
      expect(await containers()).toEqual(baseline);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it('compiles React with CSP and returns syntax/import diagnostics without executing source', async () => {
    const worker = new DockerCompiler();
    const good = await worker.compile(files, signal());
    expect(good.ok).toBe(true); expect(good.html).toContain('ISOLATED_OK');
    expect(good.html).toContain("connect-src 'none'");
    const broken = await worker.compile([{ path: 'src/main.tsx', content: 'const x = {' }], signal());
    expect(broken.ok).toBe(false); expect(broken.errors.length).toBeGreaterThan(0);
    const forbidden = await worker.compile([{ path: 'src/main.tsx', content: 'import "node:fs";' }], signal());
    expect(forbidden.ok).toBe(false);
    // A top-level throw would crash the worker if generated JS were evaluated.
    expect((await worker.compile([{ path: 'src/main.tsx', content: 'throw new Error("must never execute");' }], signal())).ok).toBe(true);
    expect(await containers()).toEqual(baseline);
  }, 60_000);

  it('enforces kernel limits, non-root, no network/socket/secrets and bounded tmpfs', async () => {
    const result = await new DockerCompiler('lov-devil-sandbox-test:constraints').compile(files, signal());
    const probe = JSON.parse(result.html!);
    expect(probe).toMatchObject({ uid: 65532, interfaces: ['lo'], memory: '268435456', swap: '0', pids: '128',
      writeDenied: true, rootReadOnly: true, networkBlocked: true, dockerSocketPresent: false, hostMountPresent: false,
      capEff: '0000000000000000', noNewPrivs: '1', seccomp: '2', secretPresent: false, tmpfsBytes: 33554432 });
    const [quota, period] = probe.cpu.split(' ').map(Number); expect(quota / period).toBe(0.5);
    expect(await containers()).toEqual(baseline);
  }, 25_000);

  it('hard-kills a hanging worker with a child process and removes its cgroup/container', async () => {
    const started = Date.now();
    const pending = new DockerCompiler('lov-devil-sandbox-test:hang', command, 5000).compile(files, signal());
    const failed = expect(pending).rejects.toMatchObject({ code: 'sandbox_timeout' });
    let sawChild = false;
    while (Date.now() - started < 4500) {
      const running = await run(['ps', '-q', '--filter', 'label=lov-devil.sandbox=ws4']);
      const container = running.stdout.trim().split(/\s+/).find(Boolean);
      if (container) {
        // Docker needs the PID column to map host processes to the container.
        const top = await run(['top', container, '-eo', 'pid,args']);
        if (top.stdout.includes('setInterval')) { sawChild = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await failed; expect(sawChild).toBe(true);
    expect(Date.now() - started).toBeLessThan(16_000);
    expect(await containers()).toEqual(baseline);
  }, 20_000);

  it('contains a controlled OOM and removes the failed worker', async () => {
    await expect(new DockerCompiler('lov-devil-sandbox-test:oom').compile(files, signal()))
      .rejects.toMatchObject({ code: 'sandbox_worker_failed' });
    expect(await containers()).toEqual(baseline);
  }, 25_000);

  it.each(['output', 'invalid'])('bounds %s response and still cleans up', async scenario => {
    await expect(new DockerCompiler('lov-devil-sandbox-test:' + scenario).compile(files, signal()))
      .rejects.toMatchObject({ code: scenario === 'output' ? 'sandbox_output_limit' : 'sandbox_protocol' });
    expect(await containers()).toEqual(baseline);
  }, 25_000);

  it('cancels a running container and its child before releasing the caller', async () => {
    const controller = new AbortController();
    const pending = new DockerCompiler('lov-devil-sandbox-test:hang').compile(files, controller.signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'sandbox_aborted' });
    // Poll only our labelled set until the newly generated container is running.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const running = await run(['ps', '-q', '--filter', 'label=lov-devil.sandbox=ws4']);
      if (running.stdout.trim()) break;
      if (Date.now() > deadline) throw new Error('fixture did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    controller.abort(); await failed;
    expect(await containers()).toEqual(baseline);
  }, 25_000);

  it('runs the deployed runner image with its private socket and resource limits', async () => {
    const endpoint = process.env.DOCKER_HOST ?? (await run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
    if (!endpoint.startsWith('unix:///')) throw new Error('runner image test requires a local Unix Docker socket');
    const name = 'lov-runner-test-' + randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    try {
      const started = await run(['run', '-d', '--name', name, '--label', 'lov-devil.runner-test=ws4',
        '--network=none', '--read-only', '--memory=192m', '--memory-swap=192m', '--cpus=0.25', '--pids-limit=64',
        '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--tmpfs=/tmp:size=16777216,noexec,nosuid,nodev',
        '--mount', `type=bind,source=${endpoint.slice(7)},target=/var/run/docker.sock`,
        '--env', 'SANDBOX_RUNNER_TOKEN=' + token, 'lov-devil-sandbox-runner:ws4']);
      expect(started.code).toBe(0);
      const program = `
        const headers={Authorization:'Bearer '+process.env.SANDBOX_RUNNER_TOKEN,'Content-Type':'application/json'};
        let ready=false;
        for(let n=0;n<30;n++) {
          try {ready=(await fetch('http://127.0.0.1:8790/ready',{headers})).ok;} catch {}
          if(ready)break; await new Promise(r=>setTimeout(r,100));
        }
        if(!ready)process.exit(2);
        const res=await fetch('http://127.0.0.1:8790/v1/compile',{method:'POST',headers,body:JSON.stringify(${JSON.stringify({ files })})});
        const result=await res.json();
        if(!res.ok||!result.ok||!result.html.includes('ISOLATED_OK'))process.exit(3);
        console.log('RUNNER_CONTAINER_BUILD_OK');`;
      const result = await command(['exec', name, 'node', '--input-type=module', '-e', program], undefined,
        { timeoutMs: 30_000, maxStdout: 2000 });
      expect(result.code).toBe(0); expect(result.stdout).toContain('RUNNER_CONTAINER_BUILD_OK');
      expect(await containers()).toEqual(baseline);
    } finally {
      const removed = await run(['rm', '--force', name]); expect(removed.code).toBe(0);
    }
  }, 40_000);
});
