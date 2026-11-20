import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NetworkError, streamAgentEvents } from '../../src/services/ai/client';
import {
  backoffDelay, jobClientConfig, loadJobResume, resetJobClientForTests, runAgentJob, type JobTransport,
} from '../../src/services/ai/jobClient';
import { deleteJobCache, loadJobCaches, openDb, saveJobCache, DB_VERSION, JOB_CACHE_STORE } from '../../src/services/persistence/db';
import { selectPersistenceScope } from '../../src/services/persistence/projectStore';
import { useStore } from '../../src/stores/useAppStore';
import { JOB_NOT_CANCELLABLE_NOTICE } from '../../src/stores/slices/jobClientSlice';
import { JobTransportStatus } from '../../src/features/workspace/JobTransportStatus';
import type { AgentEvent } from '../../src/services/ai/types';
import type { GenerateInput } from '../../src/services/ai/client';

vi.mock('../../src/services/ai/client', async original => ({
  ...await original<typeof import('../../src/services/ai/client')>(),
  streamAgentEvents: vi.fn(),
}));

const defaults = { ...jobClientConfig };
const input: GenerateInput = { projectId: 'p1', prompt: 'Urob landing', mode: 'create', context: { files: [], history: [] } };
const T = '2026-11-20T17:00:00.000Z';
const ev = {
  started: { type: 'run_started', runId: 'job-1', model: 'mock' },
  a: { type: 'text_delta', delta: 'Ahoj ' },
  b: { type: 'text_delta', delta: 'svet' },
  validation: { type: 'validation', result: { ok: true, errors: [] } },
  stage: { type: 'stage', files: [{ path: 'src/App.tsx', content: 'export {}', action: 'create' }] },
  done: { type: 'done', runId: 'job-1', summary: 'Hotovo' },
} satisfies Record<string, AgentEvent>;
const view = (state: string, events: AgentEvent[], id = 'job-1') => ({ id, state, events, error: null, createdAt: T, updatedAt: T });
const detail = (state: string, events: AgentEvent[], id = 'job-1') => ({ ...view(state, events, id), tokensUsed: { input: 1, output: 2 }, resultPatch: null, errorPayload: null });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
function stubFetch(route: Route) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => route(url, init ?? {}));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const jobsMissing: Route = (url, init) => url === '/api/agent/jobs' && init.method === 'POST' ? new Response('', { status: 404 }) : new Response('{}', { status: 500 });
async function collect(iterable: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}
function transports() {
  const seen: JobTransport[] = [];
  return { seen, onTransport: (t: JobTransport) => { if (seen.at(-1) !== t) seen.push(t); } };
}

let serial = 0;
beforeEach(() => {
  Object.assign(jobClientConfig, { baseDelayMs: 5, maxDelayMs: 20, pollIntervalMs: 5, maxRetries: 3 });
  resetJobClientForTests();
  selectPersistenceScope({ kind: 'account', userId: 'job-client-' + ++serial });
  vi.mocked(streamAgentEvents).mockReset();
});
afterEach(() => {
  cleanup();
  Object.assign(jobClientConfig, defaults);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  selectPersistenceScope({ kind: 'pilot' });
});

describe('transport state machine', () => {
  it('uses capped exponential backoff', () => {
    expect([1, 2, 3, 4, 10].map(n => backoffDelay(n, defaults))).toEqual([400, 800, 1600, 3200, 8000]);
  });

  it('B: POSTs /api/agent/jobs with Idempotency-Key, polls ?detail=1 and yields every event exactly once', async () => {
    vi.stubEnv('VITE_AGENT_JOBS_CLIENT', '1');
    let polls = 0;
    const fetch = stubFetch(url => {
      if (url === '/api/agent/jobs') return Response.json({ job: view('queued', []), replayed: false }, { status: 202 });
      polls++;
      return Response.json(polls === 1 ? detail('running', [ev.started, ev.a]) : detail('succeeded', [ev.started, ev.a, ev.b, ev.done]));
    });
    const iterated = vi.fn();
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { iterated(); yield ev.started; });
    const t = transports();
    const events = await collect(runAgentJob(input, new AbortController().signal, t));
    expect(events).toEqual([ev.started, ev.a, ev.b, ev.done]);
    const post = fetch.mock.calls[0];
    expect(new Headers(post[1].headers).get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(fetch.mock.calls[1][0]).toBe('/api/agent/jobs/job-1?detail=1');
    expect(t.seen).toEqual(['background', 'idle']);
    expect(iterated).not.toHaveBeenCalled(); // SSE fallback prepared but never opened
  });

  it('B: a 200 Idempotent-Replay is a success and never starts a second run', async () => {
    vi.stubEnv('VITE_AGENT_JOBS_CLIENT', '1');
    stubFetch(url => url === '/api/agent/jobs'
      ? Response.json({ job: view('succeeded', [ev.started, ev.done]), replayed: true }, { status: 200, headers: { 'Idempotent-Replay': 'true' } })
      : Response.json(view('succeeded', [ev.started, ev.done])));
    const iterated = vi.fn();
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { iterated(); yield ev.started; });
    expect(await collect(runAgentJob(input, new AbortController().signal))).toEqual([ev.started, ev.done]);
    expect(iterated).not.toHaveBeenCalled();
  });

  it('feature-detects a missing POST /api/agent/jobs (404) and falls back to SSE, probing only once', async () => {
    vi.stubEnv('VITE_AGENT_JOBS_CLIENT', '1');
    const fetch = stubFetch(jobsMissing);
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.done; });
    const t = transports();
    expect(await collect(runAgentJob(input, new AbortController().signal, t))).toEqual([ev.started, ev.done]);
    await collect(runAgentJob(input, new AbortController().signal));
    expect(fetch.mock.calls.filter(c => c[0] === '/api/agent/jobs')).toHaveLength(1);
    expect(streamAgentEvents).toHaveBeenCalledTimes(2);
    expect(t.seen).toEqual(['streaming', 'idle']);
  });

  it('falls back to SSE when the server answers POST /api/agent/jobs with 503 agent_jobs_disabled (Bora P1-2)', async () => {
    vi.stubEnv('VITE_AGENT_JOBS_CLIENT', '1');
    const fetch = stubFetch((url, init) => url === '/api/agent/jobs' && init.method === 'POST'
      ? Response.json({ error: 'agent_jobs_disabled' }, { status: 503 }) : new Response('{}', { status: 500 }));
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.done; });
    const t = transports();
    expect(await collect(runAgentJob(input, new AbortController().signal, t))).toEqual([ev.started, ev.done]);
    expect(fetch.mock.calls.filter(c => c[0] === '/api/agent/jobs')).toHaveLength(1);
    expect(fetch.mock.calls.some(c => String(c[0]).startsWith('/api/agent/jobs/'))).toBe(false);
    expect(streamAgentEvents).toHaveBeenCalledTimes(1);
    expect(t.seen).toEqual(['streaming', 'idle']);
    // Typed contract code: the next run in this session skips the durable POST entirely.
    await collect(runAgentJob(input, new AbortController().signal));
    expect(fetch.mock.calls.filter(c => c[0] === '/api/agent/jobs')).toHaveLength(1);
    expect(streamAgentEvents).toHaveBeenCalledTimes(2);
  });

  it('keeps typed contract codes from POST /api/agent/jobs (429 too_many_active_jobs is not rate_limit)', async () => {
    const { createAgentJob, AgentJobError } = await import('../../src/services/ai/jobs');
    for (const [status, error] of [[429, 'too_many_active_jobs'], [409, 'idempotency_key_reused'], [503, 'agent_jobs_disabled'], [429, 'rate_limit']] as const) {
      stubFetch(() => Response.json({ error }, { status }));
      const failure = await createAgentJob(input, 'key-1', new AbortController().signal).catch(e => e);
      expect(failure).toBeInstanceOf(AgentJobError);
      expect(failure.code).toBe(error);
    }
  });

  it('with VITE_AGENT_JOBS_CLIENT off (default) never calls POST /api/agent/jobs and passes an Idempotency-Key to SSE', async () => {
    const fetch = stubFetch(() => new Response('{}', { status: 500 }));
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.done; });
    const t = transports();
    expect(await collect(runAgentJob(input, new AbortController().signal, t))).toEqual([ev.started, ev.done]);
    await collect(runAgentJob(input, new AbortController().signal));
    expect(fetch.mock.calls.filter(c => c[0] === '/api/agent/jobs')).toHaveLength(0);
    const keys = vi.mocked(streamAgentEvents).mock.calls.map(c => c[2]);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(keys[0]).not.toBe(keys[1]); // a fresh key per run, never a replay of the previous run
    expect(t.seen).toEqual(['streaming', 'idle']);
  });

  it('SSE /api/agent/generate request carries the Idempotency-Key header', async () => {
    const real = await vi.importActual<typeof import('../../src/services/ai/client')>('../../src/services/ai/client');
    const fetch = stubFetch(() => new Response('data: ' + JSON.stringify(ev.done) + '\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    expect(await collect(real.streamAgentEvents(input, new AbortController().signal, 'key_123'))).toEqual([ev.done]);
    expect(fetch.mock.calls[0][0]).toBe('/api/agent/generate');
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Idempotency-Key')).toBe('key_123');
  });

  it('switches SSE → reconnecting → polling on a network error and skips events already streamed', async () => {
    let gets = 0;
    stubFetch((url, init) => {
      if (url === '/api/agent/jobs') return jobsMissing(url, init);
      gets++;
      if (gets === 1) throw new TypeError('offline');
      return Response.json(view('succeeded', [ev.started, ev.a, ev.b, ev.validation, ev.stage, ev.done]));
    });
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.a; throw new NetworkError(true); });
    const t = transports();
    const events = await collect(runAgentJob(input, new AbortController().signal, t));
    expect(events).toEqual([ev.started, ev.a, ev.b, ev.validation, ev.stage, ev.done]);
    expect(t.seen).toEqual(['streaming', 'reconnecting', 'idle']);
    await waitFor(async () => expect(await loadJobCaches()).toEqual([]));
  });

  it('treats a stream that closes without a terminal event as interrupted and continues by polling', async () => {
    let gets = 0;
    stubFetch((url, init) => {
      if (url === '/api/agent/jobs') return jobsMissing(url, init);
      return Response.json(++gets === 1 ? view('running', [ev.started, ev.a]) : view('cancelled', [ev.started, ev.a]));
    });
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.a; });
    const t = transports();
    const events = await collect(runAgentJob(input, new AbortController().signal, t));
    // terminal job without terminal event → synthesized `cancelled`, so the UI never hangs
    expect(events).toEqual([ev.started, ev.a, { type: 'cancelled', runId: 'job-1' }]);
    expect(t.seen).toEqual(['streaming', 'reconnecting', 'polling', 'idle']);
  });

  it('gives up after the backoff limit, reports failed, rethrows the SSE error and keeps the cache for a reload', async () => {
    const fetch = stubFetch((url, init) => {
      if (url === '/api/agent/jobs') return jobsMissing(url, init);
      throw new TypeError('offline');
    });
    const original = new NetworkError(true);
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.a; throw original; });
    const t = transports();
    await expect(collect(runAgentJob(input, new AbortController().signal, { ...t, messageId: 'm1' }))).rejects.toBe(original);
    expect(fetch.mock.calls.filter(c => String(c[0]).startsWith('/api/agent/jobs/'))).toHaveLength(jobClientConfig.maxRetries + 1);
    expect(t.seen).toEqual(['streaming', 'reconnecting', 'failed']);
    await waitFor(async () => expect((await loadJobCaches())[0]).toMatchObject({ jobId: 'job-1', prompt: 'Urob landing', messageId: 'm1', seen: 2, events: [ev.started, ev.a] }));
  });

  it('stops immediately when the server has no durable job (404 job_not_found)', async () => {
    stubFetch((url, init) => url === '/api/agent/jobs' ? jobsMissing(url, init) : Response.json({ error: 'job_not_found' }, { status: 404 }));
    const original = new NetworkError(true);
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; throw original; });
    await expect(collect(runAgentJob(input, new AbortController().signal))).rejects.toBe(original);
  });
});

describe('forge_job_cache (IndexedDB)', () => {
  it('upgrades a v2 database to v3 by adding only forge_job_cache and keeping existing data', async () => {
    const name = 'forge-upgrade-' + serial;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('byProject', 'projectId');
        db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        db.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'lastProject', value: 'kept' });
        db.createObjectStore('runs', { keyPath: 'id' });
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    const db = await openDb(name);
    expect(DB_VERSION).toBe(3);
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames].sort()).toEqual(['files', JOB_CACHE_STORE, 'meta', 'projects', 'runs', 'snapshots'].sort());
    const kept = await new Promise(resolve => { const r = db.transaction('meta').objectStore('meta').get('lastProject'); r.onsuccess = () => resolve(r.result); });
    expect(kept).toEqual({ key: 'lastProject', value: 'kept' });
  });

  it('restores the newest fresh record and drops expired ones', async () => {
    const now = Date.now();
    await saveJobCache({ jobId: 'old', projectId: 'p', prompt: 'x', messageId: null, events: [], seen: 0, updatedAt: now - 31 * 60_000 });
    await saveJobCache({ jobId: 'job-1', projectId: 'p', prompt: 'Urob landing', messageId: 'm1', events: [ev.started], seen: 1, updatedAt: now });
    expect(await loadJobResume(now)).toEqual({ id: 'job-1', prompt: 'Urob landing', messageId: 'm1', events: [ev.started], seen: 1 });
    await waitFor(async () => expect((await loadJobCaches()).map(r => r.jobId)).toEqual(['job-1']));
    await deleteJobCache(null);
    expect(await loadJobResume(now)).toBeNull();
  });

  it('never leaks an unhandled rejection when IndexedDB is unavailable', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const saved = globalThis.indexedDB;
    try {
      // @ts-expect-error simulate a browser without IndexedDB
      delete globalThis.indexedDB;
      selectPersistenceScope({ kind: 'account', userId: 'no-idb-' + serial });
      stubFetch(jobsMissing);
      vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; yield ev.a; yield ev.done; });
      expect(await collect(runAgentJob(input, new AbortController().signal))).toHaveLength(3);
      expect(await loadJobResume()).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      globalThis.indexedDB = saved;
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('store + UI', () => {
  it('resumes after reload from the cache into the same chat message without duplicate text', async () => {
    useStore.getState().newProject();
    useStore.setState({ messages: [{ id: 'u1', role: 'user', text: 'Urob landing' }, { id: 'm1', role: 'assistant', text: 'Ahoj ' }], generating: false, aiAbort: null, pendingReview: null });
    await saveJobCache({ jobId: 'job-1', projectId: useStore.getState().projectId, prompt: 'Urob landing', messageId: 'm1', events: [ev.started, ev.a], seen: 2, updatedAt: Date.now() });
    const fetch = stubFetch(() => Response.json(view('succeeded', [ev.started, ev.a, ev.b, ev.done])));
    await useStore.getState().resumeAgentJob();
    expect(fetch.mock.calls[0][0]).toBe('/api/agent/jobs/job-1?detail=1');
    const assistants = useStore.getState().messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ id: 'm1', text: 'Ahoj svet', done: true });
    expect(useStore.getState().jobTransport).toBe('idle');
    await waitFor(async () => expect(await loadJobCaches()).toEqual([]));
  });

  it('generateWithAi recovers a dropped stream and still waits for review before applying files', async () => {
    useStore.getState().newProject();
    useStore.setState({ messages: [], generating: false, aiAbort: null, pendingReview: null, edEditing: false, codeDraftDirty: false });
    stubFetch((url, init) => url === '/api/agent/jobs' ? jobsMissing(url, init)
      : Response.json(view('succeeded', [ev.started, ev.validation, ev.stage, ev.done])));
    vi.mocked(streamAgentEvents).mockImplementation(async function* () { yield ev.started; throw new NetworkError(true); });
    await useStore.getState().generateWithAi('Urob landing', 'create');
    expect(useStore.getState().pendingReview).toMatchObject({ runId: 'job-1' });
    expect(useStore.getState().snapshots).toHaveLength(0);
    expect(useStore.getState().jobTransport).toBe('idle');
    expect(useStore.getState().messages.filter(m => m.role === 'assistant')).toHaveLength(1);
  });

  it('shows the exact Slovak transport texts and cancels via POST …/cancel; 409 is neutral', async () => {
    const fetch = stubFetch(() => Response.json({ error: 'job_not_cancellable' }, { status: 409 }));
    const toast = vi.spyOn(useStore.getState(), 'toast');
    act(() => useStore.getState().setJobTransport('reconnecting', 'job-9'));
    render(createElement(JobTransportStatus));
    expect(screen.getByRole('status')).toHaveTextContent('Obnovujem prerušené spojenie...');
    act(() => useStore.getState().setJobTransport('polling'));
    expect(screen.getByRole('status')).toHaveTextContent('Pokračujem v generovaní na pozadí');
    act(() => useStore.getState().setJobTransport('background'));
    expect(screen.getByRole('status')).toHaveTextContent('Pokračujem v generovaní na pozadí');
    fireEvent.click(screen.getByRole('button', { name: 'Zrušiť prebiehajúci beh' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(JOB_NOT_CANCELLABLE_NOTICE));
    expect(fetch.mock.calls[0][0]).toBe('/api/agent/jobs/job-9/cancel');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(toast).not.toHaveBeenCalled();
    act(() => useStore.getState().setJobTransport('idle'));
    expect(useStore.getState().activeJobId).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zrušiť prebiehajúci beh' })).not.toBeInTheDocument();
  });
});
