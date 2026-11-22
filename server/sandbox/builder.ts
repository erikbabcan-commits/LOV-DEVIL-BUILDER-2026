import { redactSecrets } from '../security/secrets';
import { MAX_BUNDLE_BYTES, validateFiles, isApprovedDependency, APPROVED_ESM_PACKAGES, type SandboxFile, type BuildResult } from './policy';
export { SandboxFileSchema, APPROVED_DEPS, APPROVED_ESM_PACKAGES, isApprovedDependency } from './policy';
export type { SandboxFile, BuildResult } from './policy';

/* M3 Sandbox — compile-only React adapter (server-side esbuild).
   Vygenerovaný projekt sa iba kompiluje; dependencies sú buď lokálne nainštalované
   a explicitne schválené, alebo dynamicky resolvované cez ESM Import Maps (esm.sh).
   Výsledné HTML je určené pre sandbox iframe (allow-scripts, origin-null).
   Vygenerovaný kód sa na serveri nespúšťa. Hard limity vynucuje DockerCompiler okolo
   tohto adaptéra; priamy HostExecutor je iba explicitný lokálny vývoj bez hard limitov. */

/* Bora P2-3: only these files are loaded as code. Must stay identical to
   AST_GUARD_EXTENSIONS in ./astGuard.ts (kept local: the Docker worker must not pull in
   the TypeScript compiler). Anything else (e.g. src/evil.txt) is never scanned by the
   AST guard, so importing it is refused here instead of being compiled as tsx. */
export const LOADABLE_SCRIPT_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;

export const APPROVED_RUNTIME_IMPORTS = new Set([
  'react', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  'react-dom', 'react-dom/client',
]);

export const ESM_CDN_REGISTRY: Record<string, string> = {
  'react': 'https://esm.sh/react@18.3.1',
  'react/': 'https://esm.sh/react@18.3.1/',
  'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
  'react/jsx-dev-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
  'react-dom': 'https://esm.sh/react-dom@18.3.1',
  'react-dom/': 'https://esm.sh/react-dom@18.3.1/',
  'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
  'framer-motion': 'https://esm.sh/framer-motion@11.11.17?external=react,react-dom',
  'lucide-react': 'https://esm.sh/lucide-react@0.460.0?external=react',
  'recharts': 'https://esm.sh/recharts@2.13.3?external=react,react-dom',
  'three': 'https://esm.sh/three@0.170.0',
  'three/': 'https://esm.sh/three@0.170.0/',
  'three.js': 'https://esm.sh/three@0.170.0',
  'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
  'clsx': 'https://esm.sh/clsx@2.1.1',
  'tailwind-merge': 'https://esm.sh/tailwind-merge@2.5.4',
  'class-variance-authority': 'https://esm.sh/class-variance-authority@0.7.1?external=clsx',
  'zustand': 'https://esm.sh/zustand@5.0.1?external=react',
  'date-fns': 'https://esm.sh/date-fns@4.1.0',
  'd3': 'https://esm.sh/d3@7.9.0',
  'chart.js': 'https://esm.sh/chart.js@4.4.6',
  'react-chartjs-2': 'https://esm.sh/react-chartjs-2@5.2.0?external=react,react-dom,chart.js',
  'lottie-web': 'https://esm.sh/lottie-web@5.12.2',
  'howler': 'https://esm.sh/howler@2.2.4',
  'roughjs': 'https://esm.sh/roughjs@4.6.6',
};

export function resolveEsmCdnUrl(specifier: string): string | null {
  if (ESM_CDN_REGISTRY[specifier]) return ESM_CDN_REGISTRY[specifier];
  const base = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  if (base.startsWith('@radix-ui/')) {
    return `https://esm.sh/${base}?external=react,react-dom`;
  }
  if (APPROVED_ESM_PACKAGES.has(base) || APPROVED_ESM_PACKAGES.has(specifier)) {
    return `https://esm.sh/${specifier}`;
  }
  return null;
}

export function detectDynamicEsmPackages(files: SandboxFile[]): Set<string> {
  const dynamicPackages = new Set<string>();

  const manifest = files.find(file => file.path === 'package.json');
  if (manifest) {
    try {
      const pkg = JSON.parse(manifest.content);
      for (const name of Object.keys(pkg.dependencies ?? {})) {
        if (!APPROVED_RUNTIME_IMPORTS.has(name) && isApprovedDependency(name)) {
          dynamicPackages.add(name);
        }
      }
    } catch { /* ignored */ }
  }

  const importRegex = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"./\s][^'"\s]*)['"]/g;
  for (const file of files) {
    if (!LOADABLE_SCRIPT_EXTENSIONS.test(file.path)) continue;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(file.content)) !== null) {
      const spec = match[1];
      const base = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!APPROVED_RUNTIME_IMPORTS.has(spec) && (isApprovedDependency(spec) || isApprovedDependency(base))) {
        dynamicPackages.add(spec);
      }
    }
  }

  return dynamicPackages;
}

/** Pure compile adapter: TSX → JS. Production callers go through SandboxExecutor. */
export async function buildProject(files: SandboxFile[]): Promise<BuildResult> {
  const started = Date.now();
  const errors = validateFiles(files);
  const failure = (moduleCount = 0): BuildResult => ({
    ok: false,
    html: null,
    errors: errors.map(error => ({
      file: redactSecrets(error.file),
      message: redactSecrets(error.message),
    })),
    durationMs: Date.now() - started,
    moduleCount,
  });
  const byPath = new Map<string, string>();
  if (errors.length) return failure();
  for (const file of files) byPath.set(file.path, file.content);

  const dynamicPackages = detectDynamicEsmPackages(files);
  const useDynamicEsm = dynamicPackages.size > 0;

  /* esbuild iba kompiluje; izoláciu zabezpečuje volajúci worker/executor. */
  try {
    const esbuild = await import('esbuild');
    const entry = byPath.get('src/main.tsx');
    if (!entry) {
      errors.push({ file: 'src/main.tsx', message: 'chýba entry súbor' });
      return failure();
    }

    /* virtuálny FS plugin — súbory z AI priamo do bundlera */
    const vfsPlugin: import('esbuild').Plugin = {
      name: 'forge-vfs',
      setup(build) {
        build.onResolve({ filter: /^[^./]/, namespace: 'forge' }, async args => {
          if (useDynamicEsm) {
            if (APPROVED_RUNTIME_IMPORTS.has(args.path)) {
              return { path: args.path, external: true };
            }
            const base = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
            if (isApprovedDependency(args.path) || isApprovedDependency(base)) {
              dynamicPackages.add(args.path);
              return { path: args.path, external: true };
            }
            return { errors: [{ text: redactSecrets(`nepovolený import: ${args.path}`) }] };
          }
          if (!APPROVED_RUNTIME_IMPORTS.has(args.path)) return { errors: [{ text: redactSecrets(`nepovolený import: ${args.path}`) }] };
          return build.resolve(args.path, { resolveDir: process.cwd(), kind: 'import-statement' });
        });
        /* Resolve ./, ../ and root-relative paths only inside the virtual project. */
        build.onResolve({ filter: /^(?:\.{1,2}\/|\/)/, namespace: 'forge' }, args => {
          const importerPath = args.importer?.replace(/^[^:]+:/, '') ?? '';
          const baseDir = importerPath.includes('/')
            ? importerPath.slice(0, importerPath.lastIndexOf('/'))
            : '';
          const resolved = normalizeJoin(baseDir, args.path);
          if (resolved === null) return { errors: [{ text: 'import opúšťa koreň projektu' }] };
          const candidates = [resolved, resolved + '.tsx', resolved + '.ts', resolved + '.jsx', resolved + '.js', resolved + '/index.tsx'];
          for (const c of candidates) if (byPath.has(c)) return { path: c, namespace: 'forge' };
          return { errors: [{ text: redactSecrets(`modul nenájdený: ${args.path}`) }] };
        });
        build.onLoad({ filter: /.*/, namespace: 'forge' }, args => {
          const content = byPath.get(args.path) ?? '';
          const loader = args.path.endsWith('.css') ? 'css' : args.path.endsWith('.json') ? 'json'
            : LOADABLE_SCRIPT_EXTENSIONS.test(args.path) ? 'tsx' : null;
          if (loader === null) return { errors: [{ text: redactSecrets(`nepodporovaný typ súboru pre import: ${args.path}`) }] };
          /* resolveDir: esbuild pre custom namespace ignoruje resolveDir z onLoad.
             Používame importer path (bez namespace prefixu) ako base directory */
          const importerPath = ((args as unknown as { importer?: string }).importer)?.replace(/^[^:]+:/, '') ?? '';
          const resolveDir = importerPath.includes('/')
            ? importerPath.slice(0, importerPath.lastIndexOf('/'))
            : process.cwd();
          return { contents: content, loader, resolveDir };
        });
      },
    };

    const result = await esbuild.build({
      entryPoints: ['forge-entry:src/main.tsx'],
      bundle: true,
      write: false,
      outdir: 'out',
      format: useDynamicEsm ? 'esm' : 'iife',
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

    if (Buffer.byteLength(appJs, 'utf8') + Buffer.byteLength(appCss, 'utf8') > MAX_BUNDLE_BYTES) {
      errors.push({ file: '-', message: 'výsledný bundle prekračuje bezpečnostný limit' });
      return failure(byPath.size);
    }

    let html: string;
    if (useDynamicEsm) {
      const importMap: Record<string, string> = {
        'react': 'https://esm.sh/react@18.3.1',
        'react/': 'https://esm.sh/react@18.3.1/',
        'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
        'react/jsx-dev-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
        'react-dom': 'https://esm.sh/react-dom@18.3.1',
        'react-dom/': 'https://esm.sh/react-dom@18.3.1/',
        'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
      };
      for (const pkg of dynamicPackages) {
        const url = resolveEsmCdnUrl(pkg);
        if (url) {
          importMap[pkg] = url;
          if (!pkg.endsWith('/')) importMap[pkg + '/'] = url.split('?')[0] + '/';
        }
      }

      html = `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Forge Sandbox</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline' https://esm.sh; img-src data: blob: https:; font-src https://esm.sh; connect-src https://esm.sh; form-action 'none'; base-uri 'none'">
<style>body{margin:0;font-family:system-ui,sans-serif}</style>
${appCss ? `<style>${appCss}</style>\n` : ''}<script type="importmap">
${JSON.stringify({ imports: importMap }, null, 2)}
</script>
</head><body><div id="root"></div>
<script>
window.addEventListener('error', function(e) {
  var msg = (e && e.error && e.error.message) || (e && e.message) || String(e);
  var root = document.getElementById('root');
  if (root && !root.hasChildNodes()) {
    root.innerHTML = '<pre style="padding:20px;color:#f87171">Chyba runtime: ' + msg + '</pre>';
  }
  console.error(e);
  window.parent.postMessage({ type: 'forge-sandbox-error', message: String(msg) }, '*');
});
window.addEventListener('unhandledrejection', function(e) {
  var msg = (e && e.reason && e.reason.message) || String(e && e.reason || 'Unhandled rejection');
  window.parent.postMessage({ type: 'forge-sandbox-error', message: String(msg) }, '*');
});
</script>
<script type="module">
${appJs.replace(/<\/script/gi, '<\\/script')}
</script>
</body></html>`;
    } else {
      html = `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><title>Forge Sandbox</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">
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
    }
    return { ok: true, html, errors: [], durationMs: Date.now() - started, moduleCount: byPath.size };
  } catch (e) {
    // Redact before truncation, otherwise a credential crossing the cut survives.
    const msg = redactSecrets(e instanceof Error ? e.message : String(e));
    /* esbuild errory obsahujú ✘ [ERROR] bloky so súborom */
    // eslint-disable-next-line no-control-regex -- strip/match ANSI escape prefix in esbuild diagnostics
    const fileMatch = msg.match(/\x1b?\[.*?\]\s*(.+?\.(?:tsx?|jsx?|css)):/);
    errors.push({ file: fileMatch ? fileMatch[1] : '-', message: msg.slice(0, 800) });
    return failure(byPath.size);
  }
}

function normalizeJoin(dir: string, p: string): string | null {
  if (p.startsWith('/')) return p.slice(1);
  const segs = (dir ? dir.split('/') : []);
  for (const s of p.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') { if (!segs.length) return null; segs.pop(); continue; }
    segs.push(s);
  }
  return segs.join('/');
}
