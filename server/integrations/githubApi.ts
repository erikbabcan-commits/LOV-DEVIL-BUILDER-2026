/** Fixed-host, bounded, abortable server transport. Never follows redirects or
 * retries a request. Callers construct paths from validated identifiers. */
export function githubApi(input: { token: string; assertAuthorized: () => Promise<void>; fetch?: typeof fetch }, signal: AbortSignal) {
  return async (path: string, method = 'GET', body?: unknown, allowMissing = false): Promise<unknown> => {
    signal.throwIfAborted(); await input.assertAuthorized(); signal.throwIfAborted();
    const response = await (input.fetch ?? fetch)('https://api.github.com' + path, {
      method, signal, redirect: 'error', headers: { Authorization: 'Bearer ' + input.token,
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (allowMissing && response.status === 404) { void response.body?.cancel().catch(() => undefined); return null; }
    if (!response.ok || !response.body) { void response.body?.cancel().catch(() => undefined); throw new Error('github_request_failed'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 131072) throw new Error('github_response_too_large');
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => undefined); }
  };
}
