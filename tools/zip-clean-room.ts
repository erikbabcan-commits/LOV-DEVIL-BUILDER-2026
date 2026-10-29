import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { buildZipBlob, type ZipArchiveFile } from '../src/services/export/zipArchive';

const proofRoot = process.env.ZIP_PROOF_DIR;
if (!proofRoot || !path.isAbsolute(proofRoot)) throw new Error('ZIP_PROOF_DIR must be an absolute disposable directory');
if (fs.existsSync(proofRoot)) throw new Error(`Refusing to overwrite existing proof directory: ${proofRoot}`);

const files: ZipArchiveFile[] = [
  { path: 'package.json', content: JSON.stringify({ name: 'lov-devil-zip-proof', private: true, version: '1.0.0', type: 'module', scripts: { build: 'vite build' }, dependencies: { '@vitejs/plugin-react': '4.3.4', vite: '6.4.4', typescript: '5.6.3', react: '18.3.1', 'react-dom': '18.3.1' }, devDependencies: {} }, null, 2) },
  { path: 'index.html', content: '<!doctype html><html><head><meta charset="UTF-8"><title>ZIP Proof</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
  { path: 'src/main.tsx', content: 'import React from "react";import{createRoot}from"react-dom/client";import"./style.css";createRoot(document.getElementById("root")!).render(<main><h1>LOV-DEVIL ZIP proof</h1></main>);' },
  { path: 'src/style.css', content: 'body{font-family:system-ui;margin:2rem}h1{color:#7c3aed}' },
  { path: 'vite.config.ts', content: 'import{defineConfig}from"vite";import react from"@vitejs/plugin-react";export default defineConfig({plugins:[react()]});' },
];

const readme = '# LOV-DEVIL clean-room proof\n\nTrusted deterministic fixture.\n';
const blob = await buildZipBlob(files, readme);
const filename = 'lov-devil-clean-room.zip';
fs.mkdirSync(proofRoot, { recursive: false });
const archive = Buffer.from(await blob.arrayBuffer());
const zipPath = path.join(proofRoot, filename);
fs.writeFileSync(zipPath, archive);
const extractDir = path.join(proofRoot, 'extracted');
fs.mkdirSync(extractDir);
const zip = await JSZip.loadAsync(archive);
const extracted: string[] = [];
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const target = path.resolve(extractDir, name);
  if (!target.startsWith(extractDir + path.sep)) throw new Error(`Unsafe archive path: ${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, await entry.async('nodebuffer'));
  extracted.push(name);
}
const required = ['package.json', 'index.html', 'src/main.tsx', 'src/style.css', 'vite.config.ts', 'README.md'];
for (const name of required) if (!extracted.includes(name)) throw new Error(`Missing exported file: ${name}`);
console.log(JSON.stringify({ proofRoot, zipPath, extractDir, sha256: crypto.createHash('sha256').update(archive).digest('hex'), bytes: archive.length, files: extracted.sort() }));
