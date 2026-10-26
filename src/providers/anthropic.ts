import { errorFromResponse, GatewayError, ProviderError, toProviderError } from '../errors.ts';
import { parseSse, type SseEvent } from './sse.ts';
import type { ChatMessage, ChatRequest, ChatResponse, ProviderAdapter, StreamChunk } from './types.ts';

const FINISH_REASONS: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const DEFAULT_SAMPLING_ONLY = /^claude-(haiku-5|sonnet-5|opus-5|opus-4-[78]|fable|mythos)/;

function textOf(msg: ChatMessage): string {
  if (msg.content == null) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .map((part) => {
      if (part.type !== 'text') {
        throw new GatewayError(400, 'invalid_request_error', `Content part type "${part.type}" is not supported`);
      }
      return part.text ?? '';
    })
    .join('');
}

export function toAnthropic(req: ChatRequest, defaultMaxTokens: number) {
  // Anthropic takes system prompts as a top-level field, not as messages.
  const system = req.messages.filter((m) => m.role === 'system' || m.role === 'developer').map(textOf);
  const messages = req.messages
    .filter((m) => m.role !== 'system' && m.role !== 'developer')
    .map((m) => ({ role: m.role, content: textOf(m) }));

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? defaultMaxTokens,
  };
  if (system.length) body.system = system.join('\n\n');
  // Current-generation models 400 on non-default sampling values, so only older ones get them.
  if (!DEFAULT_SAMPLING_ONLY.test(req.model)) {
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
  }
  if (req.stop !== undefined) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  return body;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function fromAnthropic(res: AnthropicResponse): ChatResponse {
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const u = res.usage;
  const prompt = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: res.stop_reason ? (FINISH_REASONS[res.stop_reason] ?? 'stop') : null,
      },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: u.output_tokens, total_tokens: prompt + u.output_tokens },
  };
}

// Anthropic reports errors mid-stream as an `error` event with a type, not an HTTP status.
const STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
};

// Anthropic SSE (message_start → content_block_delta* → message_delta → message_stop) → OpenAI chunks.
export async function* fromAnthropicStream(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let id = '';
  let model = '';
  let input = 0;
  let output = 0;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: StreamChunk['choices'][0]['delta'], finish: string | null = null): StreamChunk => ({
    id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }],
  });

  for await (const ev of events) {
    const data = JSON.parse(ev.data);
    switch (data.type) {
      case 'message_start': {
        id = data.message.id;
        model = data.message.model;
        const u = data.message.usage ?? {};
        input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        output = u.output_tokens ?? 0;
        yield chunk({ role: 'assistant', content: '' });
        break;
      }
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') yield chunk({ content: data.delta.text });
        break;
      case 'message_delta':
        output = data.usage?.output_tokens ?? output;
        yield chunk({}, data.delta?.stop_reason ? (FINISH_REASONS[data.delta.stop_reason] ?? 'stop') : null);
        break;
      case 'error':
        throw new ProviderError(
          STREAM_ERROR_STATUS[data.error?.type] ?? 500,
          `anthropic stream error: ${data.error?.type}: ${data.error?.message}`,
        );
    }
  }
  yield { ...chunk({}), choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}

export function anthropic(baseUrl: string, apiKey: string, defaultMaxTokens: number): ProviderAdapter {
  const post = async (body: Record<string, unknown>, signal: AbortSignal): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw toProviderError(err);
    }
    if (!res.ok) throw await errorFromResponse('anthropic', res);
    return res;
  };

  return {
    async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      const res = await post(toAnthropic(req, defaultMaxTokens), signal);
      return fromAnthropic((await res.json()) as AnthropicResponse);
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
      const res = await post({ ...toAnthropic(req, defaultMaxTokens), stream: true }, signal);
      try {
        yield* fromAnthropicStream(parseSse(res.body!));
      } catch (err) {
        throw toProviderError(err);
      }
    },
  };
}
