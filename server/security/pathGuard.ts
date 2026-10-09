/* Workstream D: bezpečnosť ciest a limitov — vygenerované cesty sú NESPOĽAHODIVÉ. */

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 200_000;
export const MAX_TOTAL_BYTES = 2_000_000;

const ALLOWED_ROOTS = ['src/', 'public/'] as const;
const ALLOWED_ROOT_FILES = new Set([
  'package.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'README.md', '.gitignore',
]);

/** Path traversal + whitelist ochrana. Vracia true ak je cesta bezpečná pre aplikovanie. */
export function isSafePath(p: string): boolean {
  if (!p || p.length > 200) return false;
  if (p.includes('\0')) return false;
  // normalizácia: žiadne .. segmenty, žiadne absolútne cesty, žiadne windows drive
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false;
  const segs = p.split('/');
  if (segs.some(s => s === '..' || s === '.' || s === '')) return false;
  // hidden files (okrem povolených) zakázané
  if (segs.some(s => s.startsWith('.') && !ALLOWED_ROOT_FILES.has(p))) return false;
  const isRootFile = ALLOWED_ROOT_FILES.has(p);
  const inAllowedRoot = segs.length > 1 && (ALLOWED_ROOTS as readonly string[]).some(r => p.startsWith(r));
  return isRootFile || inAllowedRoot;
}

/** Veľkostné limity výstupu modelu. */
export function withinSizeLimits(files: { path: string; content: string }[]): { ok: boolean; reason?: string } {
  if (files.length > MAX_FILES) return { ok: false, reason: `file count ${files.length} > ${MAX_FILES}` };
  let total = 0;
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) return { ok: false, reason: `${f.path}: ${bytes} > ${MAX_FILE_BYTES} B` };
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, reason: `total ${total} > ${MAX_TOTAL_BYTES} B` };
  return { ok: true };
}
