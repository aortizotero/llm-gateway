import { ProviderError } from '../errors.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter } from './types.ts';

export interface FakeOptions {
  failRate?: number; // 0..1 share of calls that fail (default 0)
  failStatus?: number; // status of a failed call (default 503)
  latencyMs?: number; // also used to simulate hangs: set it above the gateway's per-hop timeout
  reply?: string;
  seed?: number; // fixed seed keeps tests and benchmarks reproducible
}

// mulberry32: tiny seeded PRNG, enough for reproducible failure patterns.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

// Deterministic stand-in for a real provider. Tests and the chaos bench use it; never real APIs.
// `set()` changes behaviour mid-run (e.g. the provider goes down, then recovers).
export function fake(initial: FakeOptions = {}) {
  let opts = { failRate: 0, failStatus: 503, latencyMs: 0, reply: 'ok', seed: 1, ...initial };
  let random = rng(opts.seed);
  const calls: ChatRequest[] = [];

  const adapter: ProviderAdapter & { calls: ChatRequest[]; set(o: FakeOptions): void } = {
    calls,
    set(o: FakeOptions) {
      opts = { ...opts, ...o };
      if (o.seed !== undefined) random = rng(o.seed);
    },
    async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      calls.push(req);
      if (opts.latencyMs) await sleep(opts.latencyMs, signal);
      signal.throwIfAborted();
      if (random() < opts.failRate) throw new ProviderError(opts.failStatus, `fake failure ${opts.failStatus}`);
      return {
        id: `fake-${calls.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: opts.reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  };
  return adapter;
}
