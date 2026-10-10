import { readFileSync } from 'node:fs';

interface Rate {
  input: number; // USD per 1M tokens
  output: number;
}

interface PricePeriod extends Rate {
  from?: string; // YYYY-MM-DD, UTC; absent = always
  longContext?: Rate & { aboveInputTokens: number };
}

export type Pricing = Record<string, PricePeriod[]>;

export function loadPricing(path = 'config/pricing.json'): Pricing {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_'))) as Pricing;
}

export function hasPrice(pricing: Pricing, hop: string): boolean {
  return Boolean(pricing[hop]?.length);
}

// USD per 1M tokens equals micro-dollars per token, so tokens × rate is already in micro-dollars.
// Rounded up: the gateway never under-charges by a fraction.
export function costMicros(
  pricing: Pricing,
  hop: string,
  inputTokens: number,
  outputTokens: number,
  now: Date = new Date(),
): number {
  const today = now.toISOString().slice(0, 10);
  const period = (pricing[hop] ?? [])
    .filter((p) => !p.from || p.from <= today)
    .sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''))
    .at(-1);
  if (!period) throw new Error(`No price configured for ${hop}`);

  const rate = period.longContext && inputTokens > period.longContext.aboveInputTokens ? period.longContext : period;
  return Math.ceil(inputTokens * rate.input + outputTokens * rate.output);
}
