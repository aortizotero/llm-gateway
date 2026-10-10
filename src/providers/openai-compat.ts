import { errorFromResponse, toProviderError } from '../errors.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter, Usage } from './types.ts';

// Gemini bills thinking tokens as output but leaves them out of completion_tokens
// (seen: prompt 12 + completion 7, total 798). Count whatever total has beyond the prompt as output.
export function billableUsage(usage: Usage | undefined): Usage {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const completion = Math.max(usage.completion_tokens, usage.total_tokens - usage.prompt_tokens);
  return { prompt_tokens: usage.prompt_tokens, completion_tokens: completion, total_tokens: usage.prompt_tokens + completion };
}

// Any API that speaks OpenAI chat completions: Google Gemini, OpenAI, OpenRouter.
export function openaiCompat(name: string, baseUrl: string, apiKey: string): ProviderAdapter {
  return {
    async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ ...req, stream: false }),
          signal,
        });
      } catch (err) {
        throw toProviderError(err);
      }
      if (!res.ok) throw await errorFromResponse(name, res);

      const body = (await res.json()) as ChatResponse;
      return { ...body, object: 'chat.completion', usage: billableUsage(body.usage) };
    },
  };
}
