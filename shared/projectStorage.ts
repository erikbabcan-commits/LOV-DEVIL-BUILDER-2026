import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ProjectStorageUsage = z.object({ usedBytes: count, limitBytes: count.positive(),
  usedProjects: count, limitProjects: count.positive(), trashedProjects: count, warning: z.boolean() });
export type ProjectStorageSnapshot = z.infer<typeof ProjectStorageUsage>;
