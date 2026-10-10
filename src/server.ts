import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate } from './auth.ts';
import { createBreakers, type Breakers } from './breaker.ts';
import { buildAdapters, loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './db.ts';
import { GatewayError, isRetryable } from './errors.ts';
import type { ChatRequest, ProviderAdapter } from './providers/types.ts';
import { resolveChain, route } from './router.ts';

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

function parseChatRequest(body: unknown): ChatRequest {
  const bad = (msg: string) => new GatewayError(400, 'invalid_request_error', msg);
  if (!body || typeof body !== 'object') throw bad('Body must be a JSON object');
  const req = body as ChatRequest;
  if (typeof req.model !== 'string' || !req.model) throw bad('"model" is required');
  if (!Array.isArray(req.messages) || !req.messages.length) throw bad('"messages" must be a non-empty array');
  if (req.stream) throw bad('Streaming is not supported yet');
  if (req.tools || req.functions) throw bad('Tool calling is not supported');
  if (typeof req.n === 'number' && req.n > 1) throw bad('"n" > 1 is not supported');
  return req;
}

export interface AppDeps {
  config: Config;
  db: Db;
  adapters: Record<string, ProviderAdapter>;
  breakers?: Breakers;
  log?: boolean;
}

export function createApp({ config, db, adapters, breakers = createBreakers(config.breaker), log = true }: AppDeps) {
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

  app.post('/v1/chat/completions', async (c) => {
    const started = performance.now();
    const tenantId = authenticate(c, db);
    const body = await c.req.json().catch(() => {
      throw new GatewayError(400, 'invalid_request_error', 'Body is not valid JSON');
    });
    const req = parseChatRequest(body);
    const { alias, hops } = resolveChain(req.model, config);

    const result = await route(req, hops, adapters, breakers, config);
    const latencyMs = Math.round(performance.now() - started);
    const usage = result.response?.usage;

    // A non-retryable upstream error is the client's fault and passes through; the rest means no provider could serve.
    const status = !result.error ? 200 : isRetryable(result.error.status) ? 503 : result.error.status;
    const provider = result.hop?.provider ?? null;
    const model = result.hop?.model ?? null;

    db.recordRequest({
      tenantId,
      alias,
      provider,
      model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsdMicros: 0, // pricing lands in M3
      latencyMs,
      attempts: result.attempts,
      status,
      error: result.error?.message ?? null,
    });
    if (log) console.log(JSON.stringify({ tenantId, alias, provider, model, status, latencyMs, attempts: result.attempts, usage }));

    c.header('x-gateway-attempts', String(result.attempts));
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
  const app = createApp({ config, db: openDb(process.env.DB_PATH ?? 'data/gateway.db'), adapters: buildAdapters(config) });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => console.log(`llm-gateway listening on :${port}`));
}
