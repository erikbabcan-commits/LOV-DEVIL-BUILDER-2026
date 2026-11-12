import { assertProviderResponse, readJson } from './http';
import type { AIProvider, ChatMessage, CompletionChunk, CompletionResult, ProviderTransport } from './types';
import { safeModel, validUsage } from '../usage/validation';

/* Mistral provider — server-only. MISTRAL_API_KEY sa nikdy nedostane do klienta. */

export interface MistralConfig {
  apiKey: string;
  /** Chat-completions model; optional when agentId is used instead. */
  model?: string;
  /** Mistral Agents (console.mistral.ai) — agent id "ag:…". Volanie cez /v1/agents/completions. */
  agentId?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Agent id z Mistral Console: "ag:" + UUID hex s pomlčkami. */
export const MISTRAL_AGENT_ID_PATTERN = /^ag:[0-9a-fA-F-]{8,64}$/;

export class MistralProvider implements AIProvider {
  readonly name = 'mistral';
  readonly model: string;
  private readonly agentId?: string;
  private readonly cfg: Required<Pick<MistralConfig, 'apiKey' | 'model' | 'baseUrl' | 'timeoutMs'>>;

  constructor(cfg: MistralConfig, private transport: ProviderTransport) {
    if (cfg.agentId) {
      if (!MISTRAL_AGENT_ID_PATTERN.test(cfg.agentId)) throw new Error('invalid_mistral_agent_id');
      this.agentId = cfg.agentId;
      this.model = cfg.agentId;
    } else {
      if (!cfg.model) throw new Error('invalid_provider_configuration');
      this.model = cfg.model;
    }
    this.cfg = {
      apiKey: cfg.apiKey,
      model: this.model,
      baseUrl: cfg.baseUrl ?? 'https://api.mistral.ai/v1',
      timeoutMs: cfg.timeoutMs ?? 120_000,
    };
  }

  private body(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; stream: boolean }) {
    return {
      // Agents completion: agent_id určuje model na strane Mistralu; model saposiela len pri chat-completions.
      ...(this.agentId ? { agent_id: this.agentId } : { model: this.cfg.model }),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.2,
      stream: opts.stream,
    };
  }

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<CompletionResult> {
    const res = await this.transport.postChat(this.body(messages, { ...opts, stream: false }), opts?.signal);
    await assertProviderResponse(res);
    const data = (await readJson(res)) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('mistral: prázdna odpoveď');
    const usage = { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens };
    return {
      text,
      finishReason: data.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
      usage: validUsage(usage) ? usage : { promptTokens: 0, completionTokens: 0 },
      usageReported: validUsage(usage),
      model: safeModel(data.model) ?? undefined,
    };
  }

  async *stream(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): AsyncIterable<CompletionChunk> {
    const res = await this.transport.postChat(this.body(messages, { ...opts, stream: true }), opts?.signal);
    await assertProviderResponse(res);
    if (!res.body) throw new Error('mistral: empty stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 8_000_000) throw new Error('mistral: stream limit');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') return;
          let j: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> };
          try { j = JSON.parse(payload); } catch { continue; }
          const ch = j.choices?.[0];
          const usage = { promptTokens: j.usage?.prompt_tokens, completionTokens: j.usage?.completion_tokens };
          const model = safeModel(j.model) ?? undefined;
          if (validUsage(usage)) yield { usage, model };
          if (ch?.delta?.content) yield { delta: ch.delta.content, model };
          if (ch?.finish_reason) yield { finishReason: ch.finish_reason === 'stop' ? 'stop' : ch.finish_reason === 'length' ? 'length' : 'error', model };
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* preserve provider failure */ }
      reader.releaseLock();
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
        redirect: 'error',
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
