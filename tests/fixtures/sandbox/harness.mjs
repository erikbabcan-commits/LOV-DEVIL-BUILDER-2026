import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';

// Trusted test image only. Production accepts files, never this scenario selector.
for await (const _ of process.stdin) { /* consume bounded fixture input */ }
const scenario = process.env.SCENARIO;
if (scenario === 'hang') {
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
} else if (scenario === 'oom') {
  const allocations = [];
  for (;;) allocations.push(Buffer.alloc(16 * 1024 * 1024, 0x41));
} else if (scenario === 'output') {
  const chunk = 'x'.repeat(1024 * 1024);
  for (let n = 0; n < 12; n++) process.stdout.write(chunk);
} else if (scenario === 'invalid') {
  process.stdout.write('invalid worker response');
} else {
  const read = name => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const rootMount = fs.readFileSync('/proc/mounts', 'utf8').split('\n').find(line => line.split(' ')[1] === '/');
  let writeDenied = false;
  try { fs.writeFileSync('/app/write-probe', 'blocked'); } catch { writeDenied = true; }
  fs.writeFileSync('/tmp/private-probe', 'temporary');
  const networkBlocked = await new Promise(resolve => {
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    socket.setTimeout(300);
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
    socket.on('timeout', () => { socket.destroy(); resolve(true); });
  });
  const probe = {
    uid: process.getuid(), interfaces: Object.keys(os.networkInterfaces()), memory: read('memory.max'), swap: read('memory.swap.max'),
    cpu: read('cpu.max'), pids: read('pids.max'), writeDenied, rootReadOnly: rootMount?.split(' ')[3].split(',').includes('ro'), networkBlocked,
    dockerSocketPresent: fs.existsSync('/var/run/docker.sock'), hostMountPresent: fs.existsSync('/host'),
    capEff: /^CapEff:\s+(\w+)/m.exec(status)?.[1], noNewPrivs: /^NoNewPrivs:\s+(\d+)/m.exec(status)?.[1],
    seccomp: /^Seccomp:\s+(\d+)/m.exec(status)?.[1],
    secretPresent: ['MISTRAL_API_KEY', 'JWT_SECRET', 'DATABASE_URL', 'SANDBOX_RUNNER_TOKEN'].some(k => k in process.env),
    tmpfsBytes: fs.statfsSync('/tmp').bsize * fs.statfsSync('/tmp').blocks,
  };
  process.stdout.write(JSON.stringify({ ok: true, html: JSON.stringify(probe), errors: [], durationMs: 1, moduleCount: 0 }));
}
