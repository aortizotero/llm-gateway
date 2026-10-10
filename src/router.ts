import type { Breakers } from './breaker.ts';
import type { Config } from './config.ts';
import { GatewayError, isRetryable, ProviderError, toProviderError } from './errors.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter, StreamChunk } from './providers/types.ts';

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

  return { hop: last, attempts, trail, error: noProvider(attempts, lastError) };
}

function noProvider(attempts: number, lastError?: ProviderError): ProviderError {
  const tried = attempts
    ? `all ${attempts} attempted providers failed; last error: ${lastError?.message}`
    : 'every provider circuit is open';
  return new ProviderError(503, `No provider available: ${tried}`);
}

export interface StreamRouteResult {
  hop: Hop | null;
  attempts: number;
  trail: Attempt[];
  chunks?: AsyncGenerator<StreamChunk>; // starts with what was buffered before committing
  error?: ProviderError;
}

const hasOutput = (c: StreamChunk) =>
  Boolean(c.usage) || c.choices.some((ch) => Boolean(ch.delta.content) || ch.finish_reason !== null);

// Streaming fallback is only possible before anything reaches the client. Each hop is read until its
// first real output (role-only chunks are buffered); an error or a slow first token moves on to the
// next hop. Once committed, a mid-stream failure can only be reported, never retried.
export async function routeStream(
  req: ChatRequest,
  hops: Hop[],
  adapters: Record<string, ProviderAdapter>,
  breakers: Breakers,
  config: Config,
): Promise<StreamRouteResult> {
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

    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new DOMException(`No data for ${ms} ms`, 'TimeoutError')), ms);
    };
    arm(config.timeouts.firstTokenMs);

    const it = adapters[hop.provider].stream({ ...req, model: hop.model }, ctrl.signal)[Symbol.asyncIterator]();
    const buffered: StreamChunk[] = [];
    try {
      while (true) {
        const r = await it.next();
        if (r.done) break;
        buffered.push(r.value);
        if (hasOutput(r.value)) break;
      }
    } catch (err) {
      clearTimeout(timer);
      ctrl.abort();
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
      continue;
    }

    breakers.success(key);
    trail.push({ hop: key, status: 200 });
    arm(config.timeouts.perHopMs); // from now on: max silence between chunks

    async function* relay(): AsyncGenerator<StreamChunk> {
      try {
        yield* buffered;
        while (true) {
          const r = await it.next();
          if (r.done) return;
          arm(config.timeouts.perHopMs);
          yield r.value;
        }
      } catch (err) {
        const e = toProviderError(err);
        if (isRetryable(e.status)) breakers.failure(key);
        throw e;
      } finally {
        clearTimeout(timer);
        ctrl.abort(); // no-op after a clean finish; cancels the upstream call if the client left early
      }
    }
    return { hop, attempts, trail, chunks: relay() };
  }

  return { hop: last, attempts, trail, error: noProvider(attempts, lastError) };
}
