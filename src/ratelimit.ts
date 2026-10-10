// Token buckets per tenant, in memory (correct for a single instance; Redis is the v2 swap).
// A bucket may go negative: input tokens are taken up front as an estimate, output tokens are charged
// after the response, and a tenant in debt waits until the refill pays it off.

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();

  const refill = (key: string, perMinute: number): Bucket => {
    const t = now();
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { tokens: perMinute, updatedAt: t }));
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.updatedAt) / 60_000) * perMinute);
    b.updatedAt = t;
    return b;
  };

  return {
    // Takes n if available. Otherwise returns how many seconds until it would be.
    take(key: string, perMinute: number, n: number): { ok: true } | { ok: false; retryAfterSec: number } {
      const b = refill(key, perMinute);
      if (b.tokens >= n) {
        b.tokens -= n;
        return { ok: true };
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((n - b.tokens) / perMinute) * 60)) };
    },

    // Unconditional charge, used to settle actual usage after the fact.
    charge(key: string, perMinute: number, n: number): void {
      refill(key, perMinute).tokens -= n;
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
