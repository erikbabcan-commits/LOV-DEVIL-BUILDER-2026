import type { AIProvider, ChatMessage, CompletionChunk, CompletionResult, ProviderTransport } from './types';

/* Mistral provider — server-only. MISTRAL_API_KEY sa nikdy nedostane do klienta. */

export interface MistralConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class MistralProvider implements AIProvider {
  readonly name = 'mistral';
  readonly model: string;
  private readonly cfg: Required<Pick<MistralConfig, 'apiKey' | 'model' | 'baseUrl' | 'timeoutMs'>>;

  constructor(cfg: MistralConfig, private transport: ProviderTransport) {
    this.model = cfg.model;
    this.cfg = {
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl ?? 'https://api.mistral.ai/v1',
      timeoutMs: cfg.timeoutMs ?? 120_000,
    };
  }

  private body(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; stream: boolean }) {
    return {
      model: this.cfg.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.2,
      stream: opts.stream,
    };
  }

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<CompletionResult> {
    const res = await this.transport.postChat(this.body(messages, { ...opts, stream: false }), opts?.signal);
    if (!res.ok) throw new Error(`mistral: HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('mistral: prázdna odpoveď');
    return {
      text,
      usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  async *stream(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): AsyncIterable<CompletionChunk> {
    const res = await this.transport.postChat(this.body(messages, { ...opts, stream: true }), opts?.signal);
    if (!res.ok || !res.body) throw new Error(`mistral stream: HTTP ${res.status}`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          };
          const ch = j.choices?.[0];
          if (ch?.delta?.content) yield { delta: ch.delta.content };
          if (ch?.finish_reason) yield { finishReason: ch.finish_reason === 'stop' ? 'stop' : 'length' };
        } catch { /* ignoruj malformed SSE riadky */ }
      }
    }
  }
}

/** Reálny fetch transport s timeoutom (server-only). */
export function makeFetchTransport(cfg: { apiKey: string; baseUrl: string; timeoutMs: number }): ProviderTransport {
  return {
    async postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
      const timeout = AbortSignal.timeout(cfg.timeoutMs);
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
      return fetch(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: merged,
      });
    },
  };
}
