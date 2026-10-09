import { z } from 'zod';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';

/* M3 Sandbox — izolovaný React/Vite runtime adapter (server-side build).
   Evaluácia: WebContainers (StackBlitz) vyžadujú API kľúč + COOP/COEP + browser-only
   — nepoužiteľné pre CI testy a self-host. Zvolený prístup: esbuild bundling
   vygenerovaného projektu NA SERVERI (izolovaný proces, žiadne npm install
   z nedôveryhodných zdrojov — dependencie sa resolvujú z lokálneho npm cache
   len pre explicitne schválené balíčky) → výstup = single-bundle HTML,
   ktorý sa spustí v sandbox iframe (allow-scripts, origin-null).
   Nikdy sa nespúšťa vygenerovaný kód v Hono host procese. */

export const SandboxFileSchema = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(200_000),
});
export type SandboxFile = z.infer<typeof SandboxFileSchema>;

export interface BuildResult {
  ok: boolean;
  html: string | null;
  errors: Array<{ file: string; message: string }>;
  durationMs: number;
  moduleCount: number;
}

/** Schválené dependencies — whitelist (sandbox policy). */
export const APPROVED_DEPS = new Set([
  'react', 'react-dom',
  '@types/react', '@types/react-dom',
]);

/** esbuild entry transform: TSX → JS. Izolovaný build bez sieťových zápisov. */
export async function buildProject(files: SandboxFile[]): Promise<BuildResult> {
  const started = Date.now();
  const errors: Array<{ file: string; message: string }> = [];
  const byPath = new Map<string, string>();
  for (const f of files) {
    if (!isSafePath(f.path)) { errors.push({ file: f.path, message: 'zakázaná cesta' }); continue; }
    byPath.set(f.path, f.content);
  }
  const size = withinSizeLimits(files);
  if (!size.ok) errors.push({ file: '-', message: size.reason ?? 'size limit' });
  if (errors.length) return { ok: false, html: null, errors, durationMs: Date.now() - started, moduleCount: 0 };

  const packageJson = byPath.get('package.json');
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson);
      const deps = Object.keys(pkg.dependencies ?? {});
      const bad = deps.filter(d => !APPROVED_DEPS.has(d));
      if (bad.length) errors.push({ file: 'package.json', message: 'ne schválené dependencies: ' + bad.join(', ') });
    } catch { errors.push({ file: 'package.json', message: 'nevalidný JSON' }); }
  }
  if (errors.length) return { ok: false, html: null, errors, durationMs: Date.now() - started, moduleCount: 0 };

  /* Dynamický import esbuild — build v izolovanom workeri by bol ideálny, 
     esbuild itself never executes the generated code (only compiles). */
  try {
    const esbuild = await import('esbuild');
    const entry = byPath.get('src/main.tsx');
    if (!entry) return { ok: false, html: null, errors: [{ file: 'src/main.tsx', message: 'chýba entry súbor' }], durationMs: Date.now() - started, moduleCount: 0 };

    /* virtuálny FS plugin — súbory z AI priamo do bundlera */
    const vfsPlugin: import('esbuild').Plugin = {
      name: 'forge-vfs',
      setup(build) {
        build.onResolve({ filter: /.*/, namespace: 'forge' }, args => {
          /* esbuild pre custom namespace nerešpektuje resolveDir z onLoad —
             relatívne importy riešime vzhľadom na importer (forge: namespace cesta) */
          const baseDir = args.importer && args.importer.includes('/')
            ? args.importer.slice(0, args.importer.lastIndexOf('/'))
            : '';
          const resolved = (args.path.startsWith('.') || args.path.startsWith('/')) && args.importer
            ? normalizeJoin(baseDir, args.path)
            : args.path.replace(/^\.\//, '');
          const candidates = [resolved, resolved + '.tsx', resolved + '.ts', resolved + '.jsx', resolved + '.js', resolved + '/index.tsx'];
          for (const c of candidates) if (byPath.has(c)) return { path: c, namespace: 'forge' };
          /* bare imports (react, react-dom, ...) → nechaj esbuild default resolve
             na host node_modules (compile-only bundling, schválené dependencies;
             esbuild nikdy nespúšťa generovaný kód) */
          if (!args.path.startsWith('.') && !args.path.startsWith('/')) return undefined;
          return { errors: [{ text: `modul nenájdený: ${args.path}` }] };
        });
        build.onLoad({ filter: /.*/, namespace: 'forge' }, args => {
          const content = byPath.get(args.path) ?? '';
          const loader = args.path.endsWith('.css') ? 'css' : args.path.endsWith('.json') ? 'json' : 'tsx';
          const resolveDir = args.path.includes('/') ? args.path.slice(0, args.path.lastIndexOf('/')) : '';
          return { contents: content, loader, resolveDir: process.cwd() };
        });
      },
    };

    const result = await esbuild.build({
      entryPoints: ['forge-entry:src/main.tsx'],
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'iife',
      jsx: 'automatic',
      platform: 'browser',
      plugins: [{
        name: 'forge-entry',
        setup(build) {
          build.onResolve({ filter: /^forge-entry:/ }, args => {
            const p = args.path.replace('forge-entry:', '');
            return { path: p, namespace: 'forge', pluginData: { resolveDir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '' } };
          });
        },
      }, vfsPlugin],
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });

    const appJs = result.outputFiles.find(o => o.path.endsWith('.js'))?.text ?? '';
    const appCss = result.outputFiles.filter(o => o.path.endsWith('.css')).map(o => o.text).join('\n').replace(/<\/style/gi, '<\\/style');

    const html = `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Forge Sandbox</title>
<style>body{margin:0;font-family:system-ui,sans-serif}</style>
${appCss ? `<style>${appCss}</style>\n` : ''}</head><body><div id="root"></div>
<script>
(function(){
  try{
    ${appJs.replace(/<\/script/gi, '<\\/script')}
  }catch(e){
    document.body.innerHTML = '<pre style="padding:20px;color:#f87171">Chyba runtime: ' + String(e && e.message || e) + '</pre>';
    console.error(e);
    window.parent.postMessage({ type:'forge-sandbox-error', message:String(e && e.message || e) }, '*');
  }
})();
</script>
</body></html>`;
    return { ok: true, html, errors: [], durationMs: Date.now() - started, moduleCount: byPath.size };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    /* esbuild errory obsahujú ✘ [ERROR] bloky so súborom */
    const fileMatch = msg.match(/\x1b?\[.*?\]\s*(.+?\.(?:tsx?|jsx?|css)):/);
    errors.push({ file: fileMatch ? fileMatch[1] : '-', message: msg.slice(0, 800) });
    return { ok: false, html: null, errors, durationMs: Date.now() - started, moduleCount: byPath.size };
  }
}

function normalizeJoin(dir: string, p: string): string {
  if (p.startsWith('/')) return p.slice(1);
  const segs = (dir ? dir.split('/') : []);
  for (const s of p.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') { segs.pop(); continue; }
    segs.push(s);
  }
  return segs.join('/');
}
