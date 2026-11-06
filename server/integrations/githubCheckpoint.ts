import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isSafePath } from '../security/pathGuard';

export const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
export const gitBranch = z.string().min(1).max(200).regex(/^[a-zA-Z0-9._/-]+$/)
  .refine(value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const repository = z.object({ repositoryId: z.number().int().positive(),
  repoFullName: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  repoUrl: z.string().url() }).strict().refine(value => value.repoUrl === 'https://github.com/' + value.repoFullName);
const base = z.object({ version: z.literal(1), githubId: z.number().int().positive(), repository, branch: gitBranch });
const file = z.object({ path: z.string().min(1).max(200).refine(path =>
  (isSafePath(path) || ['styles.css', 'app.js'].includes(path)) && !path.split('/').some(part => ['.git', '.github', 'node_modules', '.vscode'].includes(part))), sha: gitSha }).strict();
export const GitHubCommitCheckpoint = base.extend({ stage: z.literal('commit_ready'), commitSha: gitSha, treeSha: gitSha, parentSha: gitSha,
  files: z.array(file).min(1).max(40).refine(files => new Set(files.map(file => file.path)).size === files.length) }).strict();
export const GitHubWriteCheckpoint = z.union([base.extend({ stage: z.literal('repository_created') }).strict(), GitHubCommitCheckpoint]);
export type WriteCheckpoint = z.infer<typeof GitHubWriteCheckpoint>;
export function gitBlobSha(content: string) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
