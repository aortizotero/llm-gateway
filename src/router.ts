import type { Breakers } from './breaker.ts';
import type { Config } from './config.ts';
import { GatewayError, isRetryable, ProviderError, toProviderError } from './errors.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter } from './providers/types.ts';

export interface Hop {
  provider: string;
  model: string;
}

// "smart" → the alias chain from config; "anthropic:claude-haiku-5-5" → a chain of one.
export function resolveChain(model: string, config: Config): { alias: string | null; hops: Hop[] } {
  const toHop = (s: string): Hop => {
    const i = s.indexOf(':');
    return { provider: s.slice(0, i), model: s.slice(i + 1) };
  };
  if (config.aliases[model]) return { alias: model, hops: config.aliases[model].map(toHop) };

  const hop = model.includes(':') ? toHop(model) : null;
  if (!hop || !hop.model || !config.providers[hop.provider]) {
    throw new GatewayError(
      404,
      'model_not_found',
      `Unknown model "${model}". Use an alias (${Object.keys(config.aliases).join(', ')}) or "provider:model".`,
    );
  }
  return { alias: null, hops: [hop] };
}

export interface Attempt {
  hop: string; // "provider:model"
  status: number | 'skipped'; // 'skipped' = circuit open
  error?: string;
}

export interface RouteResult {
  hop: Hop | null; // the hop that answered, or the last one tried
  attempts: number; // real upstream calls, skips excluded
  trail: Attempt[];
  response?: ChatResponse;
  error?: ProviderError;
}

export async function route(
  req: ChatRequest,
  hops: Hop[],
  adapters: Record<string, ProviderAdapter>,
  breakers: Breakers,
  config: Config,
): Promise<RouteResult> {
  const trail: Attempt[] = [];
  let attempts = 0;
  let last: Hop | null = null;
  let lastError: ProviderError | undefined;

  for (const hop of hops) {
    const key = `${hop.provider}:${hop.model}`;
    if (!breakers.canPass(key)) {
      trail.push({ hop: key, status: 'skipped' });
      continue;
    }
    attempts++;
    last = hop;
    try {
      const response = await adapters[hop.provider].chat(
        { ...req, model: hop.model },
        AbortSignal.timeout(config.timeouts.perHopMs),
      );
      breakers.success(key);
      trail.push({ hop: key, status: 200 });
      return { hop, attempts, trail, response };
    } catch (err) {
      if (err instanceof GatewayError) {
        breakers.neutral(key);
        throw err;
      }
      lastError = toProviderError(err);
      trail.push({ hop: key, status: lastError.status, error: lastError.message });
      if (!isRetryable(lastError.status)) {
        breakers.neutral(key);
        return { hop, attempts, trail, error: lastError };
      }
      breakers.failure(key);
    }
  }

  const tried = attempts ? `all ${attempts} attempted providers failed` : 'every provider circuit is open';
  return { hop: last, attempts, trail, error: new ProviderError(503, `No provider available: ${tried}`) };
}
