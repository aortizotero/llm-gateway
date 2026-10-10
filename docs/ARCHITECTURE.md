# Architecture — LLM Gateway

## 1. Overview

```
                 ┌──────────────────────────── LLM Gateway (1 Node process) ────────────────────────────┐
 Client app      │                                                                                      │
 (OpenAI SDK) ──►│ auth ─► rate limit ─► budget pre-check ─► router ─► provider adapter ─► provider API │
  base_url=GW    │  │          │               │                │  ▲            │                      │
                 │  │          │               │                │  │ next hop   │                      │
                 │  ▼          ▼               ▼                ▼  │ on retryable error                │
                 │ keys     token buckets    ledger         circuit breakers                            │
                 │ (SQLite) (memory)         (SQLite)       (memory)                                    │
                 │                                                                                      │
                 │ ◄───────────── usage recorded + budget charged after response ───────────────────── │
                 └──────────────────────────────────────────────────────────────────────────────────────┘
```

One process, one SQLite file. Everything that must survive a restart (keys, budgets, ledger) is in SQLite. Everything that is fine to lose on restart (rate-limit buckets, breaker state) is in memory.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥ 24, TypeScript run via native type stripping | No build step; types without a compile pipeline. |
| HTTP | `hono` + `@hono/node-server` | Tiny, first-class SSE streaming, typed context. Only runtime deps. |
| Provider calls | Native `fetch` + `AbortSignal.timeout` | Full control of timeouts and error classification; no SDK retries hiding failures. |
| Storage | `node:sqlite` (built-in) | Zero external services in v1. WAL mode. |
| Tests | `node:test` (built-in) | No test framework dependency. |
| Config | `config/gateway.json` + env vars for secrets | Chains and limits are reviewable in git; secrets never are. |
| Deploy | Docker container on Coolify (long-running) | Streaming, in-memory breakers and token buckets need a long-lived process, which serverless functions are not. |

## 3. Request lifecycle

1. **Auth** — `Authorization: Bearer gw_...`. SHA-256 the key, look up `api_keys` → `tenant`. Missing/revoked → `401`.
2. **Rate limit** — token bucket per tenant for requests/min; a second bucket for tokens/min charged with the estimated input tokens. Empty → `429` + `Retry-After`.
3. **Budget pre-check** — `spent_this_month + estimated_max_cost > budget` → `402`. Estimated max cost = input tokens estimate × input price + `max_tokens` × output price of the *most expensive* model in the chain. Conservative on purpose.
4. **Resolve chain** — `model` field: alias (`smart`) → ordered list from config; concrete `provider:model` → chain of one.
5. **Attempt loop** — for each hop:
   - breaker open → skip (counts as a skipped hop, not an attempt)
   - call adapter with per-hop timeout
   - success → record breaker success, break
   - retryable error → record breaker failure, next hop
   - non-retryable error → return it to client immediately (it would fail on every provider)
6. **All hops failed** → `503` with the list of attempts in the body.
7. **Record** — insert ledger row; add actual cost to the tenant's month spend (single SQL transaction).

## 4. Components (`src/`)

```
src/
  server.ts            app wiring, routes
  config.ts            load + validate gateway.json and env
  auth.ts              key hashing, lookup middleware
  ratelimit.ts         token bucket (in memory, per tenant)
  budget.ts            estimate, pre-check, charge
  router.ts            chain resolution + attempt loop
  breaker.ts           circuit breaker per provider:model
  errors.ts            error classification (retryable or not)
  db.ts                node:sqlite schema + queries
  admin.ts             admin routes
  providers/
    types.ts           ChatRequest / ChatResponse / StreamChunk (OpenAI shape)
    openai-compat.ts   passthrough for any OpenAI-compatible API (Google Gemini; OpenAI/OpenRouter optional)
    anthropic.ts       OpenAI ⇄ Anthropic Messages translation, incl. SSE events
    fake.ts            configurable failure rate + latency, for tests and chaos bench
bench/
  chaos.ts             runs N requests against the gateway with fake providers, prints table
test/
  *.test.ts
config/
  gateway.json         providers, aliases/chains, breaker + default limits
  pricing.json         USD per 1M tokens, per provider:model (filled from provider pages)
```

## 5. Key designs

### Provider adapter contract
```ts
interface ProviderAdapter {
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}
```
Internal shape = OpenAI chat completions. Each adapter translates to/from its provider. Usage (tokens) must always be returned; for streams, adapters request usage in the final chunk (`stream_options.include_usage` for OpenAI-compatible APIs, `message_delta` usage for Anthropic). **Gemini thinking tokens:** Gemini bills hidden reasoning as output but omits it from `completion_tokens` (observed: prompt 12, completion 7, total 798). `billableUsage()` counts `total - prompt` as output.

### Error classification (`errors.ts`)
| Signal | Retryable | Counts for breaker |
|---|---|---|
| Timeout / network error | yes | yes |
| 429 from provider | yes | yes |
| 5xx, Anthropic 529 overloaded | yes | yes |
| 401, 403 from a provider | yes (the gateway's provider key is bad; the next provider may work) | yes |
| 400, 404, 422 | no (would fail on every provider; passed through to the client) | no (neutral: releases a half-open probe) |

### Circuit breaker
Per `provider:model`. Rolling window of the last 20 outcomes. Opens when ≥ 5 failures **and** failure rate ≥ 50%. Stays open 30 s, then half-open: lets exactly one probe through; success closes, failure re-opens. All numbers in `config/gateway.json`. With concurrent traffic, up to `concurrency` requests can reach a dead provider before the circuit opens (they were in flight when the failures were recorded).

### Streaming fallback
The adapter's async iterator is pulled until the **first content chunk** arrives *before* writing SSE headers' body to the client. An error before that point → next hop, invisible to the client. After the first chunk is flushed, an error is sent as a final SSE `error` event and the stream closes. This is the only correct behaviour: you cannot un-send tokens.

### Budget accounting
- Month spend in `tenant_spend(tenant_id, period, usd_micros)`; money stored as integer **micro-dollars**, never floats.
- Pre-check is conservative (max tokens × most expensive hop); charge is actual usage.
- Overshoot is bounded by concurrent in-flight requests — documented, tested, acceptable for v1. Fully strict would require reserving cost before the call (v2 option: reserve → settle).

### Rate limiting
In-memory token bucket per tenant. Correct for one instance. Multi-instance needs Redis (v2) — the interface is a single `take(tenantId, n)` function so swapping the backend touches one file.

## 6. Data model (SQLite)

```sql
tenants      (id TEXT PK, name TEXT, monthly_budget_usd_micros INTEGER, rpm INTEGER, tpm INTEGER, created_at TEXT)
api_keys     (id TEXT PK, tenant_id TEXT FK, key_hash TEXT UNIQUE, prefix TEXT, revoked_at TEXT, created_at TEXT)
tenant_spend (tenant_id TEXT, period TEXT /* 'YYYY-MM' */, usd_micros INTEGER, PRIMARY KEY (tenant_id, period))
requests     (id TEXT PK, tenant_id TEXT, alias TEXT, provider TEXT, model TEXT,
              input_tokens INTEGER, output_tokens INTEGER, cost_usd_micros INTEGER,
              latency_ms INTEGER, attempts INTEGER, status INTEGER, error TEXT, created_at TEXT)
```

## 7. Configuration example

```json
{
  "providers": {
    "anthropic":  { "type": "anthropic",     "baseUrl": "https://api.anthropic.com", "keyEnv": "ANTHROPIC_API_KEY" },
    "google":     { "type": "openai-compat", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "keyEnv": "GEMINI_API_KEY" }
  },
  "aliases": {
    "smart": ["anthropic:claude-sonnet-5-5", "google:gemini-3.5-flash"],
    "fast":  ["anthropic:claude-haiku-5-5", "google:gemini-3.1-flash-lite"]
  },
  "timeouts": { "perHopMs": 30000, "firstTokenMs": 10000 },
  "breaker":  { "window": 20, "minFailures": 5, "failureRate": 0.5, "openMs": 30000 },
  "defaults": { "rpm": 60, "tpm": 100000, "monthlyBudgetUsd": 50 }
}
```
Gemini Pro models need a paid Gemini API tier; the free tier returns `429` with `limit: 0`. Upgrade the `smart` backup hop once billing is enabled.

## 8. HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/chat/completions` | tenant key | Proxy (stream or not) |
| GET | `/v1/models` | tenant key | Aliases + concrete models available |
| GET | `/healthz`, `/readyz` | none | Probes |
| POST | `/admin/tenants` | admin key | Create tenant |
| POST | `/admin/tenants/:id/keys` | admin key | Issue key (returned once) |
| DELETE | `/admin/keys/:id` | admin key | Revoke |
| PATCH | `/admin/tenants/:id` | admin key | Budget / limits |
| GET | `/admin/usage?tenant=&period=` | admin key | Spend + request counts |
| GET | `/admin/breakers` | admin key | Breaker states |

Errors use the OpenAI error shape: `{ "error": { "message", "type", "code" } }`.

## 9. Deployment

- `Dockerfile` (node:24-slim), SQLite file on a mounted volume `/data`.
- Any container host behind HTTPS (reference deployment: Coolify). Secrets as host env vars.
- Security headers set in the app (no `vercel.json` here) per `docs/RULES.md`.

## 10. Decisions log

| Date | Decision | Alternatives rejected |
|---|---|---|
| 2026-10-10 | Long-running container, not Vercel Functions | Serverless: no shared memory for breakers/buckets, stream duration limits |
| 2026-10-10 | `fetch` instead of provider SDKs | SDKs add their own retries, which hide failures from the breaker |
| 2026-10-10 | SQLite for v1 | Postgres/Redis: needed only for multi-instance, which is a v2 non-goal |
| 2026-10-10 | OpenAI-compatible API surface | Custom API: forces client changes, kills the drop-in story |
| 2026-10-10 | Providers for v1: Anthropic + Google Gemini (via its OpenAI-compatible endpoint) | OpenAI as second provider: kept as config-only option; Gemini needs no extra adapter |
| 2026-10-10 | Gemini backups: `gemini-3.5-flash` (smart), `gemini-3.1-flash-lite` (fast) | `gemini-3.8-flash`: returned 503 "high demand" during M1 smoke test; Gemini Pro: not available on the free tier |
| 2026-10-10 | Breaker may trip on partial (~30%) failure; accepted and documented | Larger sample size (slower detection of dead providers); last-resort retry of open circuits (a hung provider costs the full timeout) |
