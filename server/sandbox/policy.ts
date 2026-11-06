import { z } from 'zod';
import { isSafePath, MAX_FILES, withinSizeLimits } from '../security/pathGuard';
import { containsPotentialSecret, redactSecrets } from '../security/secrets';

export const SandboxFileSchema = z.object({ path: z.string().min(1).max(200), content: z.string().max(200_000) }).strict();
export type SandboxFile = z.infer<typeof SandboxFileSchema>;
export interface BuildResult {
  ok: boolean;
  html: string | null;
  errors: Array<{ file: string; message: string }>;
  durationMs: number;
  moduleCount: number;
}
export const APPROVED_DEPS = new Set(['react', 'react-dom', '@types/react', '@types/react-dom']);
export const MAX_BUNDLE_BYTES = 2_000_000;
// JSON escaping can expand the existing 2 MB source limit by up to six times.
export const MAX_INPUT_JSON_BYTES = 13_000_000;
export const MAX_OUTPUT_JSON_BYTES = 8_000_000;
export const MAX_STDERR_BYTES = 16_384;
export const CompileRequestSchema = z.object({ files: SandboxFileSchema.array().max(MAX_FILES) }).strict();
const ResultSchema = z.object({
  ok: z.boolean(), html: z.string().max(3_000_000).nullable(),
  errors: z.array(z.object({ file: z.string().max(1000), message: z.string().max(2000) }).strict()).max(100),
  durationMs: z.number().finite().nonnegative(), moduleCount: z.number().int().min(0).max(MAX_FILES),
}).strict();

export function validateFiles(files: SandboxFile[]): BuildResult['errors'] {
  const errors: BuildResult['errors'] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (containsPotentialSecret(file.path) || containsPotentialSecret(file.content))
      errors.push({ file: file.path, message: 'potenciálne tajomstvo v ceste alebo obsahu zdrojového súboru' });
    else if (!isSafePath(file.path)) errors.push({ file: file.path, message: 'zakázaná cesta' });
    else if (seen.has(file.path)) errors.push({ file: file.path, message: 'duplicitná cesta' });
    seen.add(file.path);
  }
  const size = withinSizeLimits(files);
  if (!size.ok) errors.push({ file: '-', message: size.reason ?? 'size limit' });
  const manifest = files.find(file => file.path === 'package.json');
  if (manifest) {
    try {
      const pkg = JSON.parse(manifest.content);
      const bad = Object.keys(pkg.dependencies ?? {}).filter(name => !APPROVED_DEPS.has(name));
      if (bad.length) errors.push({ file: 'package.json', message: 'ne schválené dependencies: ' + bad.join(', ') });
    } catch { errors.push({ file: 'package.json', message: 'nevalidný JSON' }); }
  }
  return errors.map(error => ({ file: redactSecrets(error.file), message: redactSecrets(error.message) }));
}

export function validationFailure(files: SandboxFile[]): BuildResult | null {
  const errors = validateFiles(files);
  return errors.length ? { ok: false, html: null, errors, durationMs: 0, moduleCount: 0 } : null;
}

export function parseBuildResult(value: unknown): BuildResult {
  const result = ResultSchema.parse(value);
  if ((result.ok && result.html === null) || (!result.ok && result.html !== null) ||
      (result.html !== null && (Buffer.byteLength(result.html) > 3_000_000 || containsPotentialSecret(result.html))))
    throw new Error('Invalid compile result');
  return { ...result, errors: result.errors.map(error => ({
    file: redactSecrets(error.file).slice(0, 200), message: redactSecrets(error.message).slice(0, 800),
  })) };
}
