import { errorFromResponse, GatewayError, toProviderError } from '../errors.ts';
import type { ChatMessage, ChatRequest, ChatResponse, ProviderAdapter } from './types.ts';

const FINISH_REASONS: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

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
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
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

export function anthropic(baseUrl: string, apiKey: string, defaultMaxTokens: number): ProviderAdapter {
  return {
    async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      const body = toAnthropic(req, defaultMaxTokens);
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
      return fromAnthropic((await res.json()) as AnthropicResponse);
    },
  };
}
