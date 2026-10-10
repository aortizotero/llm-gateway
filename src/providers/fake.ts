import { ProviderError } from '../errors.ts';
import type { ChatRequest, ChatResponse, ProviderAdapter, StreamChunk } from './types.ts';

export interface FakeOptions {
  failRate?: number; // 0..1 share of calls that fail (default 0)
  failStatus?: number; // status of a failed call (default 503)
  latencyMs?: number; // also used to simulate hangs: set it above the gateway's per-hop timeout
  reply?: string; // streamed one word per chunk
  chunkDelayMs?: number; // pause between streamed content chunks (not before the first)
  failAfterChunks?: number; // stream: fail mid-response after this many content chunks
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

const defaults = { failRate: 0, failStatus: 503, latencyMs: 0, reply: 'ok', seed: 1 };

// Deterministic stand-in for a real provider. Tests and the chaos bench use it; never real APIs.
// `set()` changes behaviour mid-run (e.g. the provider goes down, then recovers).
export function fake(initial: FakeOptions = {}) {
  let opts: FakeOptions & typeof defaults = { ...defaults, ...initial };
  let random = rng(opts.seed);
  const calls: ChatRequest[] = [];

  const start = async (req: ChatRequest, signal: AbortSignal) => {
    calls.push(req);
    if (opts.latencyMs) await sleep(opts.latencyMs, signal);
    signal.throwIfAborted();
    if (random() < opts.failRate) throw new ProviderError(opts.failStatus, `fake failure ${opts.failStatus}`);
  };

  const adapter: ProviderAdapter & { calls: ChatRequest[]; set(o: FakeOptions): void } = {
    calls,
    set(o: FakeOptions) {
      opts = { ...opts, ...o };
      if (o.seed !== undefined) random = rng(o.seed);
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
      await start(req, signal);
      const base = { id: `fake-${calls.length}`, object: 'chat.completion.chunk' as const, created: 0, model: req.model };
      const words = opts.reply.split(' ');
      yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
      for (const [i, word] of words.entries()) {
        if (opts.failAfterChunks !== undefined && i >= opts.failAfterChunks) {
          throw new ProviderError(opts.failStatus, `fake mid-stream failure ${opts.failStatus}`);
        }
        if (opts.chunkDelayMs && i) await sleep(opts.chunkDelayMs, signal);
        yield { ...base, choices: [{ index: 0, delta: { content: i ? ` ${word}` : word }, finish_reason: null }] };
      }
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      yield { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length } };
    },

    async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      await start(req, signal);
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
