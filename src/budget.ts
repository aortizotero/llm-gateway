import type { Config } from './config.ts';
import type { ChatRequest } from './providers/types.ts';
import { costMicros, type Pricing } from './pricing.ts';
import type { Hop } from './router.ts';

// Rough upper estimate (~3 chars per token, below the usual ~4) so pre-checks err on the safe side.
export function estimateInputTokens(req: ChatRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) chars += p.text?.length ?? 0;
  }
  return Math.ceil(chars / 3) + 4 * req.messages.length;
}

// Worst case across the chain: any hop might be the one that answers. Some providers bill more output
// than max_tokens (Gemini's thinking tokens were seen at 1.5×), so each provider declares its overrun factor.
export function maxCostMicros(config: Config, pricing: Pricing, hops: Hop[], inputTokens: number, maxTokens: number): number {
  return Math.max(
    ...hops.map((h) => {
      const overrun = config.providers[h.provider].maxTokensOverrun ?? 1;
      return costMicros(pricing, `${h.provider}:${h.model}`, inputTokens, Math.ceil(maxTokens * overrun));
    }),
  );
}
