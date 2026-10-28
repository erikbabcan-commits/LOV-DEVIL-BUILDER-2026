// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { runAgent, validateFiles } from '../../../server/agent/run';
import type { AgentEvent, GeneratedFile, GenerateRequest, Plan } from '../../../server/agent/schemas';
import type { AIProvider } from '../../../server/providers/types';

// Deliberately fake credential-shaped data; never sent to a real provider.
const canary = 'mstrl_' + 'TEST_CONTEXT_ONLY_1234567890';

function requestFixture(mode: GenerateRequest['mode'] = 'create'): GenerateRequest {
  return {
    projectId: 'project-fixture', prompt: 'Build a CRM', mode,
    context: {
      projectTitle: 'CRM fixture',
      files: [{ path: 'src/App.tsx', content: 'export default function App(){ return null; }' }],
      history: [{ v: 1, prompt: 'Add a dashboard' }],
    },
  };
}

function planFixture(): Plan {
  return {
    summary: 'Build a CRM',
    steps: [{ id: 'scaffold', title: 'Create app', detail: 'One React component' }],
    filesPlanned: ['src/App.tsx'],
  };
}

const safeFiles: GeneratedFile[] = [
  { path: 'src/App.tsx', content: 'export default function App(){ return null; }', action: 'create' },
];

function providerFixture(plan: Plan = planFixture(), files: GeneratedFile[] = safeFiles) {
  const usage = { promptTokens: 1, completionTokens: 1 };
  const complete = vi.fn<AIProvider['complete']>()
    .mockResolvedValueOnce({ text: JSON.stringify(plan), usage })
    .mockResolvedValueOnce({ text: JSON.stringify({ files }), usage });
  const stream = vi.fn<AIProvider['stream']>(async function* () {
    yield { finishReason: 'stop' as const };
  });
  const provider: AIProvider = { name: 'mock', model: 'mock-local', complete, stream };
  return { provider, complete, stream };
}

async function collect(request: GenerateRequest, provider: AIProvider): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(request, { runId: 'run-fixture', provider, maxFiles: 40 })) {
    events.push(event);
  }
  return events;
}

const inputCases: [string, (request: GenerateRequest) => void][] = [
  ['prompt', request => { request.prompt = canary; }],
  ['projectId', request => { request.projectId = canary; }],
  ['context.projectTitle', request => { request.context.projectTitle = canary; }],
  ['context.files.path', request => { request.context.files[0].path = `src/${canary}.tsx`; }],
  ['context.files.content', request => { request.context.files[0].content = `const token = "${canary}";`; }],
  ['context.history.prompt', request => { request.context.history[0].prompt = `Use ${canary}`; }],
];

describe.each(['create', 'iterate', 'fix'] as const)('pre-provider context guard (%s)', mode => {
  it.each(inputCases)('rejects a canary in %s before any provider invocation', async (_name, inject) => {
    const request = requestFixture(mode);
    inject(request);
    const { provider, complete, stream } = providerFixture();
    const events = await collect(request, provider);

    expect(complete).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'secret_in_context', retriable: false });
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('preserves a normal request and completes both mock calls', async () => {
    const { provider, complete, stream } = providerFixture();
    const events = await collect(requestFixture(mode), provider);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(stream).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'stage', files: safeFiles });
    expect(events.at(-1)).toMatchObject({ type: 'done', runId: 'run-fixture' });
  });
});

const planCases: [string, (plan: Plan) => void][] = [
  ['summary', plan => { plan.summary = canary; }],
  ['steps.id', plan => { plan.steps[0].id = canary; }],
  ['steps.title', plan => { plan.steps[0].title = canary; }],
  ['steps.detail', plan => { plan.steps[0].detail = canary; }],
  ['filesPlanned', plan => { plan.filesPlanned[0] = `src/${canary}.tsx`; }],
];

describe('model metadata and generated path secret guard', () => {
  it.each(planCases)('rejects plan %s before emitting it or starting generation', async (_name, inject) => {
    const plan = planFixture();
    inject(plan);
    const { provider, complete } = providerFixture(plan);
    const events = await collect(requestFixture(), provider);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.type === 'plan' || event.type === 'stage')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'secret_in_output', retriable: false });
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('does not stage or echo a credential-shaped generated path', async () => {
    const files = [{ ...safeFiles[0], path: `src/${canary}.tsx` }];
    const { provider, complete } = providerFixture(planFixture(), files);
    const events = await collect(requestFixture(), provider);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(events.some(event => event.type === 'stage' || event.type === 'file_started' || event.type === 'done')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'validation_failed' });
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it('redacts generated paths from every relevant validation diagnostic', () => {
    const path = `src/../${canary}.tsx`;
    const result = validateFiles([
      { path, content: '', action: 'create' },
      { path, content: canary, action: 'create' },
    ], 40);

    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.code === 'invalid_path')).toBe(true);
    expect(result.errors.some(error => error.code === 'empty')).toBe(true);
    expect(result.errors.some(error => error.message.includes('duplicitná'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('redacts a generated credential-shaped path from byte-limit errors', () => {
    const result = validateFiles([
      { path: `src/${canary}.tsx`, content: 'ž'.repeat(100_001), action: 'create' },
    ], 40);

    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.code === 'too_large')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
