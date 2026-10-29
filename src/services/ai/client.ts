import type { AgentEvent, Plan, GeneratedFile } from './types';

/* AI klient: volá Hono backend, parsuje SSE eventy, podporuje cancel.
   Ak backend nie je dostupný / AI nie je nakonfigurovaná, UI to jasne hlási —
   nikdy sa tišie neprepne na šablóny. */

export type AgentEventHandler = (ev: AgentEvent) => void;

export interface AgentRunHandle {
  runId: string | null;
  cancel(): void;
  finished: Promise<void>;
}

export const AI_API_BASE: string = import.meta.env?.VITE_AI_API_BASE ?? '';

export class AiNotConfiguredError extends Error {
  constructor() { super('AI engine nie je nakonfigurovaný (MISTRAL_API_KEY chýba na serveri). Použi Instant Draft mód alebo nastav kľúč.'); }
}
export class NetworkError extends Error {
  constructor(public retriable: boolean) { super('AI server nie je dostupný.'); }
}

export interface GenerateInput {
  projectId: string;
  prompt: string;
  mode: 'create' | 'iterate' | 'fix';
  context: {
    projectTitle?: string;
    files: Array<{ path: string; content: string }>;
    history: Array<{ v: number; prompt: string }>;
  };
}

export async function* streamAgentEvents(input: GenerateInput, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  let res: Response;
  try {
    res = await fetch(AI_API_BASE + '/api/agent/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return;
    throw new NetworkError(true);
  }
  if (res.status === 503) {
    const j = await res.json().catch(() => ({}));
    throw new AiNotConfiguredError();
  }
  if (res.status === 429) throw new NetworkError(false);
  if (!res.ok) throw new NetworkError(true);
  if (!res.body) throw new NetworkError(true);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        yield JSON.parse(line.slice(5).trim()) as AgentEvent;
      } catch { /* malformed SSE — ignoruj */ }
    }
  }
}

/* helpers pre apply do VFS */

export function isTerminal(ev: AgentEvent): boolean {
  return ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled';
}

export function filesFromStage(events: AgentEvent[]): GeneratedFile[] {
  const stage = events.find(e => e.type === 'stage');
  return stage && stage.type === 'stage' ? stage.files : [];
}
