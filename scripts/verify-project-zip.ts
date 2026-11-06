import JSZip from 'jszip';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BLUEPRINT_REGISTRY } from '../src/templates/registry';
import { createProjectZip } from '../src/services/export/projectZip';
import { createProjectZip as createLovableZip } from '../deploy/lovable-github/src/lib/forge-zip';

// Only trusted bundled fixtures. Never execute arbitrary user sources or install their packages.
if (process.argv.slice(2).some(arg => arg !== '--fresh-install')) throw new Error('Unsupported argument');
const fresh = process.argv.includes('--fresh-install');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'forge-zip-build-'));
const env: NodeJS.ProcessEnv = {
  PATH: dirname(process.execPath) + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: temporary, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', NODE_ENV: 'development',
  NPM_CONFIG_USERCONFIG: join(temporary, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(temporary, 'global.npmrc'),
  npm_config_registry: 'https://registry.npmjs.org', npm_config_audit: 'false', npm_config_fund: 'false',
};
async function command(program: string, args: string[], cwd: string, timeout: number) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-12_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Trusted build command failed: ' + output));
    });
  });
}
try {
  await writeFile(env.NPM_CONFIG_USERCONFIG!, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG!, '');
  let firstFolder = '', firstPackage = '';
  for (const template of BLUEPRINT_REGISTRY) {
    const sources = template.files.map(file => ({ name: file.path, content: file.content }));
    const expected = new Map(sources.map(file => [file.name, file.content]));
    const folder = join(temporary, template.id);
    await mkdir(folder, { mode: 0o700 });
    // Both production entrypoints must preserve every original file and produce identical sources.
    for (const [name, builder] of [['main', createProjectZip], ['lovable', createLovableZip]] as const) {
      const archive = await builder(sources, template.title, 1);
      const zip = await JSZip.loadAsync(archive.bytes, { checkCRC32: true });
      if (Object.keys(zip.files).length !== expected.size) throw new Error('Unexpected ZIP entry count');
      for (const [path, content] of expected) {
        const file = zip.file(path);
        if (!file || await file.async('string') !== content) throw new Error('ZIP source mismatch: ' + path);
        if (name === 'lovable') {
          const destination = join(folder, path);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, await file.async('uint8array'));
        }
      }
    }
    const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as Record<string, unknown>;
    const toolchain = JSON.stringify(Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'engines', 'scripts'].map(key => [key, manifest[key]])));
    if (!firstFolder) {
      firstFolder = folder; firstPackage = toolchain;
      if (fresh) {
        await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], folder, 120_000);
        console.log('PASS fresh npm install from exported trusted package.json; lifecycle scripts disabled');
      } else await symlink(join(root, 'node_modules'), join(folder, 'node_modules'), 'dir');
    } else {
      // All bundled blueprints declare the same toolchain. Fail rather than silently using mismatched dependencies.
      if (toolchain !== firstPackage) throw new Error('Blueprint toolchain changed; separate install required');
      await symlink(join(firstFolder, 'node_modules'), join(folder, 'node_modules'), 'dir');
    }
    await command('npm', ['run', 'build'], folder, 30_000);
    const html = await readFile(join(folder, 'dist/index.html'), 'utf8');
    if (!html.includes('<script') || !html.includes('/assets/')) throw new Error('Missing Vite build artifact');
    console.log('PASS ' + template.id + ' — both ZIPs CRC/source equality, extracted TypeScript + Vite build');
  }
  console.log('Verified ' + BLUEPRINT_REGISTRY.length + ' complete exported projects; dependency mode=' + (fresh ? 'fresh isolated npm install, shared identical toolchain' : 'existing local toolchain'));
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log('zip_build_cleanup=removed');
}
