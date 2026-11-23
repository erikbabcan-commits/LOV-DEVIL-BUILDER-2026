import { z } from 'zod';
import { Files } from './projectSchema';

export const repoFullName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/)
  .refine(name => !['.', '..'].includes(name.split('/')[1]));
export const ImportRequest = z.object({
  repoFullName,
  branch: z.string().min(1).max(255).refine(ref => !/[\s\\~^:?*\[\x00-\x1f\x7f]/.test(ref) &&
    !ref.includes('..') && !ref.includes('@{') && ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'))).optional(),
}).strict();
export const ImportResult = z.object({
  repoFullName, branch: z.string(), files: Files, skipped: z.number().int().nonnegative(),
});
export const RepoList = z.object({
  repos: z.array(z.object({ fullName: repoFullName, defaultBranch: z.string() })), more: z.boolean(),
});
export const importErrors = {
  invalid_import: 'Skontroluj názov repozitára a vetvu.',
  github_not_connected: 'Najprv pripoj svoj GitHub účet.',
  github_import_forbidden: 'Pripojenie nemá prístup k tomuto repozitáru.',
  github_import_missing: 'Repozitár alebo vetva sa nenašli.',
  github_import_limit: 'Výber prekračuje kapacitu VFS alebo GitHub vrátil neúplný strom.',
  github_import_empty: 'Repozitár neobsahuje podporované textové súbory.',
  github_import_failed: 'GitHub nedokončil čítanie. Skús to znova.',
} as const;
