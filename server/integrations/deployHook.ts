/**
 * Deploy Hook Trigger
 * Fires Vercel Deploy Hook or Netlify Build Hook after a GitHub provisioning.
 * No CLI required — just an HTTP POST to user-provided webhook URLs.
 */

import { z } from 'zod';

export const DeployHookRequest = z.object({
  webhookUrl: z
    .string()
    .url()
    .refine(
      (url) => {
        try {
          const u = new URL(url);
          return (
            u.protocol === 'https:' &&
            (u.hostname.endsWith('.vercel.com') ||
              u.hostname.endsWith('.netlify.com') ||
              u.hostname.endsWith('.netlify.app'))
          );
        } catch {
          return false;
        }
      },
      { message: 'Only Vercel and Netlify HTTPS webhook URLs are accepted' }
    ),
  provider: z.enum(['vercel', 'netlify']),
  repoFullName: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).optional(),
});

export type DeployHookInput = z.infer<typeof DeployHookRequest>;

export interface DeployTriggerResult {
  ok: true;
  provider: 'vercel' | 'netlify';
  jobId: string | null;
  statusUrl: string | null;
}

export interface DeployTriggerError {
  ok: false;
  error: 'invalid_url' | 'hook_rejected' | 'network_error' | 'timeout';
  message?: string;
}

export type DeployTriggerOutcome = DeployTriggerResult | DeployTriggerError;

export async function triggerDeployHook(
  input: DeployHookInput,
  opts: { signal?: AbortSignal; fetch?: typeof fetch } = {}
): Promise<DeployTriggerOutcome> {
  const f = opts.fetch ?? fetch;
  const signal = opts.signal ?? AbortSignal.timeout(15_000);

  try {
    signal.throwIfAborted();

    // Both Vercel and Netlify deploy hooks accept a simple POST with no body
    const res = await f(input.webhookUrl, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'lov-devil-builder', repo: input.repoFullName ?? null }),
    });

    if (res.status === 200 || res.status === 201) {
      let jobId: string | null = null;
      let statusUrl: string | null = null;

      try {
        const body = (await res.json()) as Record<string, unknown>;
        // Vercel returns { job: { id, state, createdAt } }
        if (body.job && typeof body.job === 'object') {
          const job = body.job as Record<string, unknown>;
          jobId = typeof job.id === 'string' ? job.id : null;
          if (jobId) statusUrl = `https://vercel.com/dashboard`;
        }
        // Netlify returns { id, state, ... }
        if (typeof body.id === 'string') {
          jobId = body.id;
          statusUrl = `https://app.netlify.com`;
        }
      } catch {
        // non-JSON responses are still OK
      }

      return { ok: true, provider: input.provider, jobId, statusUrl };
    }

    return {
      ok: false,
      error: 'hook_rejected',
      message: `Webhook returned HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return { ok: false, error: 'timeout', message: 'Deploy hook timed out' };
      }
    }
    return { ok: false, error: 'network_error', message: String(err) };
  }
}
