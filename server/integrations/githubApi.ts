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
    if (response.status === 401) { void response.body?.cancel().catch(() => undefined); throw new Error('github_unauthorized'); }
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

export type GitHubRequest = ReturnType<typeof githubApi>;

const sha = /^[a-f0-9]{40}$/;

function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/** Read-only compare of two commits or refs. Additive helper; no writes. */
export async function githubCompare(
  api: GitHubRequest,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<{ baseSha: string; headSha: string; status: string; changedPaths: string[] } | null> {
  const path =
    "/repos/" +
    encodeURIComponent(owner) +
    "/" +
    encodeURIComponent(repo) +
    "/compare/" +
    encodeURIComponent(base) +
    "..." +
    encodeURIComponent(head);
  const raw = await api(path, "GET", undefined, true);
  if (raw === null) return null;
  const body = raw as {
    status?: string;
    base_commit?: { sha?: string };
    merge_base_commit?: { sha?: string };
    files?: Array<{ filename?: string }>;
  };
  const files = Array.isArray(body.files) ? body.files : [];
  return {
    baseSha: typeof body.merge_base_commit?.sha === "string" ? body.merge_base_commit.sha : base,
    headSha: typeof body.base_commit?.sha === "string" ? body.base_commit.sha : head,
    status: typeof body.status === "string" ? body.status : "diverged",
    changedPaths: files
      .map((file) => file.filename)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  };
}

export async function githubGetRepo(
  api: GitHubRequest,
  owner: string,
  repo: string,
): Promise<{
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { id: number; login: string };
} | null> {
  return (await api(
    "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo),
    "GET",
    undefined,
    true,
  )) as Awaited<ReturnType<typeof githubGetRepo>>;
}

export async function githubGetRef(
  api: GitHubRequest,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ sha: string; ref: string } | null> {
  const raw = await api(
    "/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repo) +
      "/git/ref/heads/" +
      encodeBranch(branch),
    "GET",
    undefined,
    true,
  );
  if (raw === null) return null;
  const body = raw as { ref?: string; object?: { sha?: string } };
  if (typeof body.object?.sha !== "string" || !sha.test(body.object.sha)) return null;
  return { sha: body.object.sha, ref: typeof body.ref === "string" ? body.ref : "refs/heads/" + branch };
}

export async function githubCreateRef(
  api: GitHubRequest,
  owner: string,
  repo: string,
  branch: string,
  shaValue: string,
): Promise<void> {
  await api(
    "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/git/refs",
    "POST",
    { ref: "refs/heads/" + branch, sha: shaValue },
  );
}

/** Update a non-default branch tip. Callers must pass the repo default branch so main/master cannot be patched. */
export async function githubUpdateRef(
  api: GitHubRequest,
  owner: string,
  repo: string,
  branch: string,
  shaValue: string,
  defaultBranch: string,
): Promise<void> {
  if (isProtectedBranch(branch, defaultBranch)) throw new Error("default_branch_forbidden");
  await api(
    "/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repo) +
      "/git/refs/heads/" +
      encodeBranch(branch),
    "PATCH",
    { sha: shaValue, force: false },
  );
}

export function isProtectedBranch(branch: string, defaultBranch: string): boolean {
  const name = branch.toLowerCase();
  return name === defaultBranch.toLowerCase() || name === "main" || name === "master" || name === "heads/main" || name === "heads/master";
}

export async function githubListOpenPulls(
  api: GitHubRequest,
  owner: string,
  repo: string,
  headBranch: string,
  baseBranch: string,
): Promise<Array<{ number: number; html_url: string; head: string; base: string; state: string }>> {
  const raw = await api(
    "/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repo) +
      "/pulls?state=open&head=" +
      encodeURIComponent(owner + ":" + headBranch) +
      "&base=" +
      encodeURIComponent(baseBranch),
  );
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const item = row as {
      number?: number;
      html_url?: string;
      state?: string;
      head?: { ref?: string };
      base?: { ref?: string };
    };
    if (!Number.isInteger(item.number) || typeof item.html_url !== "string") return [];
    return [
      {
        number: item.number!,
        html_url: item.html_url,
        head: item.head?.ref ?? "",
        base: item.base?.ref ?? "",
        state: item.state ?? "open",
      },
    ];
  });
}

export async function githubCreatePull(
  api: GitHubRequest,
  owner: string,
  repo: string,
  input: { title: string; head: string; base: string; body: string },
): Promise<{ number: number; html_url: string }> {
  const raw = (await api(
    "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/pulls",
    "POST",
    input,
  )) as { number?: number; html_url?: string };
  if (!Number.isInteger(raw.number) || typeof raw.html_url !== "string") throw new Error("github_request_failed");
  return { number: raw.number!, html_url: raw.html_url };
}

export async function githubUpdatePull(
  api: GitHubRequest,
  owner: string,
  repo: string,
  number: number,
  input: { title: string; body: string },
): Promise<{ number: number; html_url: string }> {
  const raw = (await api(
    "/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repo) +
      "/pulls/" +
      encodeURIComponent(String(number)),
    "PATCH",
    input,
  )) as { number?: number; html_url?: string };
  if (!Number.isInteger(raw.number) || typeof raw.html_url !== "string") throw new Error("github_request_failed");
  return { number: raw.number!, html_url: raw.html_url };
}
