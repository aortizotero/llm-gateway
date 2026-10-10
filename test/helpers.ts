import { createBreakers } from '../src/breaker.ts';
import type { Config } from '../src/config.ts';
import { openDb, type Limits } from '../src/db.ts';
import type { Pricing } from '../src/pricing.ts';
import { fake } from '../src/providers/fake.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { createRateLimiter } from '../src/ratelimit.ts';
import { createApp } from '../src/server.ts';

export const config: Config = {
  providers: {
    primary: { type: 'openai-compat', baseUrl: 'http://unused', keyEnv: 'UNUSED' },
    backup: { type: 'openai-compat', baseUrl: 'http://unused', keyEnv: 'UNUSED' },
  },
  aliases: { smart: ['primary:model-a', 'backup:model-b'] },
  timeouts: { perHopMs: 100 },
  breaker: { window: 20, minFailures: 5, failureRate: 0.5, openMs: 30000 },
  defaults: { maxTokens: 100, maxTokensCeiling: 1000, rpm: 1e6, tpm: 1e9, monthlyBudgetUsd: 50 },
};

// Fake usage is 10 input + 5 output tokens: model-a costs 20 µ$, model-b 200 µ$ per call.
export const pricing: Pricing = {
  'primary:model-a': [{ input: 1, output: 2 }],
  'backup:model-b': [{ input: 10, output: 20 }],
  'backup:model-z': [{ input: 1, output: 1 }],
};

export const ADMIN_KEY = 'test-admin-key';

export function setup(
  adapters: Record<string, ProviderAdapter> = { primary: fake(), backup: fake() },
  limits: Partial<Limits> = {},
  now?: () => number,
) {
  const db = openDb(':memory:');
  const tenantId = db.createTenant('Acme', { ...config.defaults, ...limits });
  const { key } = db.createKey(tenantId);
  const app = createApp({
    config,
    pricing,
    db,
    adapters,
    breakers: createBreakers(config.breaker),
    limiter: createRateLimiter(now),
    adminKey: ADMIN_KEY,
    log: false,
  });
  const call = (body: unknown, auth = `Bearer ${key}`) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });
  const admin = (method: string, path: string, body?: unknown, auth = `Bearer ${ADMIN_KEY}`) =>
    app.request(`/admin${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ledger = () => db.raw.prepare('SELECT * FROM requests').all() as Record<string, unknown>[];
  return { db, tenantId, key, call, admin, ledger };
}

export const chat = (model = 'smart', extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

export const down = (failStatus = 503) => fake({ failRate: 1, failStatus });
