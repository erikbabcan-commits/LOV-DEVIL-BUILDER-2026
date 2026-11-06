import type { DbLike } from '../db/pool';
import { ProjectStorageUsage, type ProjectStorageSnapshot } from '../../shared/projectStorage';

export interface ProjectStoragePolicy { maxBytes: number; maxProjects: number }
// Per-account pilot capacity guards; these are not paid-plan entitlements.
export const DEFAULT_PROJECT_STORAGE: ProjectStoragePolicy = { maxBytes: 64 * 1024 * 1024, maxProjects: 100 };
export function readProjectStoragePolicy(env: Record<string,string | undefined>): ProjectStoragePolicy {
  const read = (name: string, fallback: number, maximum: number) => {
    const value = env[name];
    if (value === undefined || value === '') return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error('Invalid project storage configuration: ' + name);
    return Number(value);
  };
  return { maxBytes: read('PROJECT_STORAGE_MAX_BYTES', DEFAULT_PROJECT_STORAGE.maxBytes, 1024 * 1024 * 1024),
    maxProjects: read('PROJECT_STORAGE_MAX_PROJECTS', DEFAULT_PROJECT_STORAGE.maxProjects, 10000) };
}
export function validateProjectStoragePolicy(policy: ProjectStoragePolicy): void {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(policy.maxProjects) || policy.maxProjects < 1 || policy.maxProjects > 10000) throw new Error('Invalid project storage policy');
}
export async function projectStorageUsage(db: DbLike, owner: string, policy: ProjectStoragePolicy): Promise<ProjectStorageSnapshot> {
  const row = (await db.query(`SELECT COUNT(*) AS projects, COALESCE(SUM(octet_length(workspace::text)),0) AS bytes,
    COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END),0) AS trashed
    FROM builder_projects WHERE owner_id=$1`, [owner])).rows[0];
  const usedBytes = Number(row.bytes), usedProjects = Number(row.projects);
  return ProjectStorageUsage.parse({ usedBytes, usedProjects, trashedProjects: Number(row.trashed), limitBytes: policy.maxBytes, limitProjects: policy.maxProjects,
    warning: usedBytes >= policy.maxBytes * 0.8 || usedProjects >= policy.maxProjects * 0.8 });
}
export function fitsProjectStorage(usage: ProjectStorageSnapshot, nextBytes: number, nextProjects: number): boolean {
  // Existing over-limit accounts can keep or reduce usage; reads and restore
  // never require new capacity. No data is deleted to satisfy a reduced cap.
  return (nextBytes <= usage.limitBytes || nextBytes <= usage.usedBytes) &&
    (nextProjects <= usage.limitProjects || nextProjects <= usage.usedProjects);
}
