import { redactSecrets } from '../security/secrets';
import { MAX_BUNDLE_BYTES, validateFiles, type SandboxFile, type BuildResult } from './policy';
export { SandboxFileSchema, APPROVED_DEPS } from './policy';
export type { SandboxFile, BuildResult } from './policy';

/* M3 Sandbox — compile-only React adapter (server-side esbuild).
   Vygenerovaný projekt sa iba kompiluje; dependencies sú lokálne nainštalované
   a explicitne schválené, bez npm install zo vstupu. Výsledné single-bundle HTML
   je určené pre sandbox iframe (allow-scripts, origin-null). Vygenerovaný kód sa
   na serveri nespúšťa. Hard limity vynucuje DockerCompiler okolo tohto adaptéra;
   priamy HostExecutor je iba explicitný lokálny vývoj bez hard limitov. */

const APPROVED_RUNTIME_IMPORTS = new Set([
  'react', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  'react-dom', 'react-dom/client',
]);

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
          const loader = args.path.endsWith('.css') ? 'css' : args.path.endsWith('.json') ? 'json' : 'tsx';
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

    if (Buffer.byteLength(appJs, 'utf8') + Buffer.byteLength(appCss, 'utf8') > MAX_BUNDLE_BYTES) {
      errors.push({ file: '-', message: 'výsledný bundle prekračuje bezpečnostný limit' });
      return failure(byPath.size);
    }

    const html = `<!doctype html>
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
