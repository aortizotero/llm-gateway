import { errorFromResponse, ProviderError, toProviderError } from '../errors.ts';
import { parseSse } from './sse.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter, StreamChunk, Usage } from './types.ts';

// Gemini bills thinking tokens as output but leaves them out of completion_tokens
// (seen: prompt 12 + completion 7, total 798). Count whatever total has beyond the prompt as output.
export function billableUsage(usage: Usage | undefined): Usage {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const completion = Math.max(usage.completion_tokens, usage.total_tokens - usage.prompt_tokens);
  return { prompt_tokens: usage.prompt_tokens, completion_tokens: completion, total_tokens: usage.prompt_tokens + completion };
}

// OpenAI sends usage once in a final chunk; Gemini repeats a cumulative usage on every chunk.
// Either way: strip it from content chunks, keep the latest, emit it once at the end.
export async function* normalizeStream(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  let usage: Usage | undefined;
  let last: StreamChunk | undefined;
  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    last = chunk;
    if (chunk.choices?.length) yield { ...chunk, usage: undefined };
  }
  if (last) yield { ...last, choices: [], usage: billableUsage(usage) };
}

async function post(name: string, url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw toProviderError(err);
  }
  if (!res.ok) throw await errorFromResponse(name, res);
  return res;
}

// Any API that speaks OpenAI chat completions: Google Gemini, OpenAI, OpenRouter.
export function openaiCompat(name: string, baseUrl: string, apiKey: string): ProviderAdapter {
  const url = `${baseUrl}/chat/completions`;
  return {
    async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      const res = await post(name, url, apiKey, { ...req, stream: false }, signal);
      const body = (await res.json()) as ChatResponse;
      return { ...body, object: 'chat.completion', usage: billableUsage(body.usage) };
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
      const body = { ...req, stream: true, stream_options: { include_usage: true } };
      const res = await post(name, url, apiKey, body, signal);
      async function* chunks(): AsyncGenerator<StreamChunk> {
        try {
          for await (const ev of parseSse(res.body!)) {
            if (ev.data === '[DONE]') return;
            const data = JSON.parse(ev.data) as StreamChunk & { error?: { message?: string; code?: number } };
            if (data.error) throw new ProviderError(data.error.code ?? 500, `${name} stream error: ${data.error.message}`);
            yield data;
          }
        } catch (err) {
          throw toProviderError(err);
        }
      }
      yield* normalizeStream(chunks());
    },
  };
}
