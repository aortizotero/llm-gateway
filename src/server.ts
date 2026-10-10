import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { adminRoutes } from './admin.ts';
import { authenticate } from './auth.ts';
import { createBreakers, type Breakers } from './breaker.ts';
import { estimateInputTokens, maxCostMicros } from './budget.ts';
import { buildAdapters, loadConfig, validatePricing, type Config } from './config.ts';
import { openDb, type Db, type RequestRow } from './db.ts';
import { GatewayError, isRetryable } from './errors.ts';
import { costMicros, hasPrice, loadPricing, type Pricing } from './pricing.ts';
import type { ChatRequest, ProviderAdapter } from './providers/types.ts';
import { createRateLimiter, type RateLimiter } from './ratelimit.ts';
import { resolveChain, route, type RouteResult } from './router.ts';

// API profile from docs/RULES.md #13.
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function parseChatRequest(body: unknown, config: Config): ChatRequest {
  const bad = (msg: string) => new GatewayError(400, 'invalid_request_error', msg);
  if (!body || typeof body !== 'object') throw bad('Body must be a JSON object');
  const req = body as ChatRequest;
  if (typeof req.model !== 'string' || !req.model) throw bad('"model" is required');
  if (!Array.isArray(req.messages) || !req.messages.length) throw bad('"messages" must be a non-empty array');
  if (req.stream) throw bad('Streaming is not supported yet');
  if (req.tools || req.functions) throw bad('Tool calling is not supported');
  if (typeof req.n === 'number' && req.n > 1) throw bad('"n" > 1 is not supported');

  // Every request gets an explicit output cap: budgets reserve against it, so it must bound the cost.
  const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? config.defaults.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > config.defaults.maxTokensCeiling) {
    throw bad(`"max_tokens" must be an integer between 1 and ${config.defaults.maxTokensCeiling}`);
  }
  const { max_completion_tokens: _, ...rest } = req;
  return { ...rest, max_tokens: maxTokens };
}

export interface AppDeps {
  config: Config;
  pricing: Pricing;
  db: Db;
  adapters: Record<string, ProviderAdapter>;
  breakers?: Breakers;
  limiter?: RateLimiter;
  adminKey?: string;
  log?: boolean;
}

export function createApp(deps: AppDeps) {
  const { config, pricing, db, adapters, adminKey, log = true } = deps;
  const breakers = deps.breakers ?? createBreakers(config.breaker);
  const limiter = deps.limiter ?? createRateLimiter();
  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
  });

  app.use(
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json(new GatewayError(413, 'request_too_large', 'Body exceeds 1 MB').toJSON(), 413),
    }),
  );

  app.route('/admin', adminRoutes({ db, config, breakers, adminKey }));

  app.post('/v1/chat/completions', async (c) => {
    const started = performance.now();
    const tenant = authenticate(c, db);
    const body = await c.req.json().catch(() => {
      throw new GatewayError(400, 'invalid_request_error', 'Body is not valid JSON');
    });
    const req = parseChatRequest(body, config);
    const { alias, hops } = resolveChain(req.model, config);
    for (const h of hops) {
      if (!hasPrice(pricing, `${h.provider}:${h.model}`)) {
        throw new GatewayError(400, 'model_not_priced', `No price configured for ${h.provider}:${h.model}`);
      }
    }

    // Rate limits: tokens/min is charged with the input estimate now and the real output later.
    const estimatedInput = estimateInputTokens(req);
    if (estimatedInput > tenant.tpm) {
      throw new GatewayError(400, 'request_exceeds_tpm', `Request is larger than this key's ${tenant.tpm} tokens/min limit`);
    }
    const tpm = limiter.take(`${tenant.id}:tpm`, tenant.tpm, estimatedInput);
    const rpm = tpm.ok ? limiter.take(`${tenant.id}:rpm`, tenant.rpm, 1) : tpm;
    if (!rpm.ok) {
      if (tpm.ok) limiter.charge(`${tenant.id}:tpm`, tenant.tpm, -estimatedInput);
      c.header('Retry-After', String(rpm.retryAfterSec));
      throw new GatewayError(429, 'rate_limit_exceeded', `Rate limit exceeded, retry in ${rpm.retryAfterSec}s`);
    }

    const reserved = maxCostMicros(config, pricing, hops, estimatedInput, req.max_tokens as number);
    if (!db.reserve(tenant, reserved)) {
      throw new GatewayError(402, 'budget_exceeded', 'Monthly budget exhausted for this key');
    }

    const record = (r: Partial<RequestRow> & { status: number }) =>
      db.settle(
        { tenantId: tenant.id, alias, provider: null, model: null, inputTokens: 0, outputTokens: 0, costUsdMicros: 0,
          latencyMs: Math.round(performance.now() - started), attempts: 0, error: null, ...r },
        reserved,
      );

    let result: RouteResult;
    try {
      result = await route(req, hops, adapters, breakers, config);
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 500;
      record({ status, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    // A non-retryable upstream error is the client's fault and passes through; the rest means no provider could serve.
    const status = !result.error ? 200 : isRetryable(result.error.status) ? 503 : result.error.status;
    const provider = result.hop?.provider ?? null;
    const model = result.hop?.model ?? null;
    const usage = result.response?.usage;
    const cost = usage ? costMicros(pricing, `${provider}:${model}`, usage.prompt_tokens, usage.completion_tokens) : 0;

    record({
      provider,
      model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsdMicros: cost,
      attempts: result.attempts,
      status,
      error: result.error?.message ?? null,
    });
    if (usage) limiter.charge(`${tenant.id}:tpm`, tenant.tpm, usage.prompt_tokens + usage.completion_tokens - estimatedInput);
    if (log) {
      console.log(JSON.stringify({ tenantId: tenant.id, alias, provider, model, status, attempts: result.attempts, usage, costUsdMicros: cost }));
    }

    c.header('x-gateway-attempts', String(result.attempts));
    c.header('x-gateway-cost-usd', (cost / 1_000_000).toFixed(6));
    if (provider) c.header('x-gateway-provider', `${provider}:${model}`);
    if (result.error) {
      const code = status === 503 ? 'no_provider_available' : 'invalid_request_error';
      return c.json({ ...new GatewayError(status, code, result.error.message).toJSON(), attempts: result.trail }, status as 400);
    }
    return c.json(result.response);
  });

  app.onError((err, c) => {
    if (err instanceof GatewayError) return c.json(err.toJSON(), err.status as 400);
    console.error(err);
    return c.json(new GatewayError(500, 'internal_error', 'Internal gateway error').toJSON(), 500);
  });

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const pricing = loadPricing();
  validatePricing(config, pricing);
  const app = createApp({
    config,
    pricing,
    db: openDb(process.env.DB_PATH ?? 'data/gateway.db'),
    adapters: buildAdapters(config),
    adminKey: process.env.GATEWAY_ADMIN_KEY,
  });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => console.log(`llm-gateway listening on :${port}`));
}
