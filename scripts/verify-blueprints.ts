import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BLUEPRINT_REGISTRY } from '../src/templates/registry';
import { validateFiles } from '../server/sandbox/policy';

// Only bundled, policy-validated templates. Never npm install or execute input scripts.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'forge-blueprints-'));
const env = { ...process.env, MISTRAL_API_KEY: '', NODE_ENV: 'production' };
try {
  for (const template of BLUEPRINT_REGISTRY) {
    const errors = validateFiles(template.files);
    if (errors.length) throw new Error('Invalid trusted blueprint: ' + template.id);
    const folder = join(temporary, template.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const file of template.files) {
      const target = join(folder, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await symlink(join(root, 'node_modules'), join(folder, 'node_modules'), 'dir');
    for (const [tool, args] of [
      ['typescript/bin/tsc', ['--noEmit', '-p', folder]],
      ['vite/bin/vite.js', ['build', '--logLevel', 'error']],
    ] as const) {
      const result = spawnSync(process.execPath, [join(root, 'node_modules', tool), ...args], {
        cwd: folder, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 256_000,
      });
      if (result.status !== 0) throw new Error(template.id + ' / ' + tool + ': ' +
        (result.error?.message ?? result.stdout + result.stderr).slice(0, 4000));
    }
    console.log('PASS ' + template.id + ' — TypeScript + Vite build');
  }
  console.log('Verified ' + BLUEPRINT_REGISTRY.length + ' complete project builds.');
} finally { await rm(temporary, { recursive: true, force: true }); }
