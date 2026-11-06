// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_STORAGE, readProjectStoragePolicy } from '../../../server/projects/storage';

describe('operator project storage capacity', () => {
  it('uses a bounded pilot default and accepts explicit capacity', () => {
    expect(readProjectStoragePolicy({})).toEqual(DEFAULT_PROJECT_STORAGE);
    expect(readProjectStoragePolicy({ PROJECT_STORAGE_MAX_BYTES: '1073741824', PROJECT_STORAGE_MAX_PROJECTS: '10000' })).toEqual({ maxBytes: 1073741824, maxProjects: 10000 });
  });
  it('rejects invalid and unbounded configuration without echoing its value', () => {
    for (const field of ['PROJECT_STORAGE_MAX_BYTES', 'PROJECT_STORAGE_MAX_PROJECTS']) {
      for (const value of ['0', '-1', '1.5', ' 10', '1e3', '9007199254740992', 'private-config-value']) {
        expect(() => readProjectStoragePolicy({ [field]: value })).toThrow('Invalid project storage configuration: ' + field);
        try { readProjectStoragePolicy({ [field]: value }); } catch (error) { expect(String(error)).not.toContain(value); }
      }
    }
    expect(() => readProjectStoragePolicy({ PROJECT_STORAGE_MAX_BYTES: '1073741825' })).toThrow();
    expect(() => readProjectStoragePolicy({ PROJECT_STORAGE_MAX_PROJECTS: '10001' })).toThrow();
  });
});
