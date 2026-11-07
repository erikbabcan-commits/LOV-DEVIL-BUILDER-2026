/** The complete Cloud-to-Hono surface. Keep the Lovable proxy allowlist identical. */
const accountExportPath = /^\/api\/account\/export\/(?:profile|(?:projects|auth|ai|publish|github|billing)(?:\/[A-Za-z0-9_-]{1,512})?)$/;

export function isCloudApiRoute(method: string, path: string): boolean {
  if (method === 'GET') return path === '/api/auth/me' || path === '/api/sandbox/ready' ||
    accountExportPath.test(path) ||
    path === '/api/ai-models' || path === '/api/ai-usage' || path === '/api/billing' || path === '/api/publish' || /^\/api\/publish\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path) ||
    /^\/api\/publish\/project\/[A-Za-z0-9_-]{1,128}\/[1-9][0-9]{0,9}\/[A-Za-z0-9_-]{1,128}$/.test(path) || path === '/api/project-storage' || path === '/api/projects' || /^\/api\/projects\/[A-Za-z0-9_-]{1,128}$/.test(path);
  if (method !== 'POST') return false;
  return ['/api/sandbox/build', '/api/sandbox/autofix', '/api/agent/generate', '/api/billing/checkout', '/api/billing/portal', '/api/publish'].includes(path) ||
    /^\/api\/publish\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/withdraw$/i.test(path) ||
    /^\/api\/projects\/[A-Za-z0-9_-]{1,128}(?:\/(?:delete|restore))?$/.test(path);
}

/** Query parameters are supported only on the project listing. Reject duplicates. */
export function isCloudApiQuery(method: string, path: string, query: URLSearchParams): boolean {
  if (query.size === 0) return true;
  if (method !== 'GET' || path !== '/api/projects') return false;
  const seen = new Set<string>();
  for (const [key, value] of query) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === 'deleted' ? !['0', '1'].includes(value) : key === 'cursor' ? !/^[A-Za-z0-9_-]{1,128}$/.test(value) : true) return false;
  }
  return true;
}
