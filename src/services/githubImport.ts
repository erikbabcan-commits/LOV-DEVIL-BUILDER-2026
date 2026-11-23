import { apiUrl } from '../lib/api';
import { getGitHubConnection } from './githubConnect';
import { ImportResult, RepoList, importErrors } from '../../shared/githubImport';

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const connection = await getGitHubConnection();
  if (!connection.authenticated) throw new Error(importErrors.github_not_connected);
  const root = connection.mode === 'bridge' ? '/api/github-connect/' : '/api/github/';
  const headers = new Headers();
  if (body) {
    headers.set('Content-Type', 'application/json');
    if (connection.csrfToken) headers.set('X-CSRF-Token', connection.csrfToken);
  }
  const timeout = AbortSignal.timeout(65_000);
  const response = await fetch(apiUrl(root + path), {
    method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', headers,
    body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(Object.hasOwn(importErrors, data?.error)
    ? importErrors[data.error as keyof typeof importErrors] : importErrors.github_import_failed);
  return data;
}
export async function listGitHubRepos(page: number, signal?: AbortSignal) {
  return RepoList.parse(await request('repos?page=' + page, undefined, signal));
}
export async function pullGitHubFiles(repoFullName: string, branch?: string) {
  return ImportResult.parse(await request('import', { repoFullName, branch }));
}
