/* Workstream A: Provider-nezávislé rozhranie AI služby.
   MistralProvider je jedna implementácia; mock transport pre testy je druhá. */

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface CompletionChunk { delta?: string; finishReason?: 'stop' | 'length' | 'error' }

export interface CompletionResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface AIProvider {
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
