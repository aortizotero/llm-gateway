// Internal request/response shape = OpenAI chat completions. Adapters translate to/from it.

export type ContentPart = { type: string; text?: string };

export interface ChatMessage {
  role: string;
  content: string | ContentPart[] | null;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null };
    finish_reason: string | null;
  }>;
  usage: Usage;
}

export interface ProviderAdapter {
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}
