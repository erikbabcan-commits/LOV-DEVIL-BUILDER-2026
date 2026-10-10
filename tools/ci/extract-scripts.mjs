import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(resolve(root, 'demo/index.html'), 'utf-8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
mkdirSync(resolve(root, 'tools/ci/build'), { recursive: true });
scripts.forEach((s, i) => writeFileSync(resolve(root, `tools/ci/build/app-block-${i}.js`), s));
console.log(`extracted ${scripts.length} script blocks`);
if (scripts.length === 0) process.exit(1);
