/* Workstream A: Provider-nezávislé rozhranie AI služby.
   MistralProvider je jedna implementácia; mock transport pre testy je druhá. */

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface CompletionChunk { delta?: string; finishReason?: 'stop' | 'length' | 'error'; model?: string; usage?: CompletionResult['usage'] }

export interface CompletionResult {
  text: string;
  /** 'length' = output useknutý na max_tokens (volajúci môže požiadať o pokračovanie). */
  finishReason?: 'stop' | 'length';
  usage: { promptTokens: number; completionTokens: number };
  /** false means the numeric placeholders are NOT reported consumption. */
  usageReported?: boolean;
  model?: string;
}

export interface AIProvider {
  /** Operator-verified total window; conservative default when absent. */
  readonly contextWindowTokens?: number;
  readonly name: string;
  readonly model: string;
  /** jednorazová completion (JSON výstupy plánu/súborov) */
  complete(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<CompletionResult>;
  /** streamovaná completion — textové delty pre UI */
  stream(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): AsyncIterable<CompletionChunk>;
}

/** Transport = HTTP vrstva (v produkte fetch na Mistral API; v testoch mock). */
export interface ProviderTransport {
  postChat(body: unknown, signal?: AbortSignal): Promise<Response>;
}
