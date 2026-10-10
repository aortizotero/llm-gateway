import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { adminRoutes } from './admin.ts';
import { authenticate } from './auth.ts';
import { createBreakers, type Breakers } from './breaker.ts';
import { estimateInputTokens, maxCostMicros } from './budget.ts';
import { buildAdapters, loadConfig, validatePricing, type Config } from './config.ts';
import { openDb, type Db } from './db.ts';
import { GatewayError, isRetryable, type ProviderError } from './errors.ts';
import { costMicros, hasPrice, loadPricing, type Pricing } from './pricing.ts';
import type { ChatRequest, ProviderAdapter, Usage } from './providers/types.ts';
import { createRateLimiter, type RateLimiter } from './ratelimit.ts';
import { resolveChain, route, routeStream, type Attempt, type Hop, type RouteResult, type StreamRouteResult } from './router.ts';

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
  if (req.tools || req.functions) throw bad('Tool calling is not supported');
  if (typeof req.n === 'number' && req.n > 1) throw bad('"n" > 1 is not supported');

  // Every request gets an explicit output cap: budgets reserve against it, so it must bound the cost.
  const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? config.defaults.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > config.defaults.maxTokensCeiling) {
    throw bad(`"max_tokens" must be an integer between 1 and ${config.defaults.maxTokensCeiling}`);
  }
  // stream_options is the gateway's business with each provider, never forwarded as-is.
  const { max_completion_tokens: _, stream_options: __, ...rest } = req;
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
    const includeUsage = (body as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage === true;
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

    // Settles the reservation, charges tokens/min with actual usage, writes the ledger row. Returns the cost.
    // Unknown usage (stream cut short) is charged at the full reservation: never under-charge.
    const finish = (r: { hop: Hop | null; attempts: number; status: number; usage?: Usage; error?: string; streamed?: boolean }): number => {
      const provider = r.hop?.provider ?? null;
      const model = r.hop?.model ?? null;
      const cost = r.usage
        ? costMicros(pricing, `${provider}:${model}`, r.usage.prompt_tokens, r.usage.completion_tokens)
        : r.streamed ? reserved : 0;
      db.settle(
        {
          tenantId: tenant.id, alias, provider, model,
          inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0, costUsdMicros: cost,
          latencyMs: Math.round(performance.now() - started), attempts: r.attempts, status: r.status, error: r.error ?? null,
        },
        reserved,
      );
      if (r.usage) {
        limiter.charge(`${tenant.id}:tpm`, tenant.tpm, r.usage.prompt_tokens + r.usage.completion_tokens - estimatedInput);
      }
      if (log) {
        console.log(JSON.stringify({ tenantId: tenant.id, alias, provider, model, stream: Boolean(req.stream), status: r.status, attempts: r.attempts, usage: r.usage, costUsdMicros: cost }));
      }
      return cost;
    };

    // A non-retryable upstream error is the client's fault and passes through; the rest means no provider could serve.
    const failure = (result: { hop: Hop | null; attempts: number; trail: Attempt[]; error: ProviderError }) => {
      const status = isRetryable(result.error.status) ? 503 : result.error.status;
      finish({ ...result, status, error: result.error.message });
      const code = status === 503 ? 'no_provider_available' : 'invalid_request_error';
      return c.json({ ...new GatewayError(status, code, result.error.message).toJSON(), attempts: result.trail }, status as 400);
    };

    const routed = req.stream
      ? routeStream(req, hops, adapters, breakers, config)
      : route(req, hops, adapters, breakers, config);
    let result: RouteResult | StreamRouteResult;
    try {
      result = await routed;
    } catch (err) {
      finish({ hop: null, attempts: 0, status: err instanceof GatewayError ? err.status : 500, error: String(err) });
      throw err;
    }

    c.header('x-gateway-attempts', String(result.attempts));
    if (result.hop) c.header('x-gateway-provider', `${result.hop.provider}:${result.hop.model}`);
    if (result.error) return failure({ ...result, error: result.error });

    if ('response' in result && result.response) {
      const cost = finish({ ...result, status: 200, usage: result.response.usage });
      c.header('x-gateway-cost-usd', (cost / 1_000_000).toFixed(6));
      return c.json(result.response);
    }

    // Streaming: committed to one provider. The cost is only known at the end, so it is in the ledger, not a header.
    const { hop, attempts } = result;
    const chunks = (result as StreamRouteResult).chunks!;
    return streamSSE(c, async (stream) => {
      let usage: Usage | undefined;
      let status = 200;
      let error: string | undefined;
      stream.onAbort(() => {
        status = 499; // client closed the connection
        void chunks.return(undefined);
      });
      try {
        for await (const chunk of chunks) {
          if (chunk.usage) {
            usage = chunk.usage;
            if (!includeUsage) continue;
          }
          await stream.writeSSE({ data: JSON.stringify(chunk) });
        }
        if (status === 200) await stream.writeSSE({ data: '[DONE]' });
      } catch (err) {
        status = 502;
        error = err instanceof Error ? err.message : String(err);
        const event = new GatewayError(502, 'upstream_error', `Provider failed mid-stream: ${error}`).toJSON();
        await stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      } finally {
        finish({ hop, attempts, status, usage, error, streamed: true });
      }
    });
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
