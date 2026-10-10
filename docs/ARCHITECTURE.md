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

1. **Auth** — `Authorization: Bearer gw_...`. SHA-256 the key, look up `api_keys` → `tenant` (with its limits). Missing/revoked → `401`.
2. **Validate** — every request gets an explicit `max_tokens` (client value or config default, capped by `maxTokensCeiling`), because the budget reserves against it.
3. **Resolve chain** — `model` field: alias (`smart`) → ordered list from config; concrete `provider:model` → chain of one. Every hop must have a price → otherwise `400 model_not_priced`.
4. **Rate limit** — token bucket per tenant for requests/min; a second bucket for tokens/min, charged with the estimated input tokens now and the actual output after the response. Empty → `429` + `Retry-After`.
5. **Reserve budget** — worst-case cost (see Budget accounting) is booked against the month's spend in one SQL transaction. Doesn't fit → `402`, no provider is called.
6. **Attempt loop** — for each hop:
   - breaker open → skip (counts as a skipped hop, not an attempt)
   - call adapter with per-hop timeout
   - success → record breaker success, break
   - retryable error → record breaker failure, next hop
   - non-retryable error → return it to client immediately (it would fail on every provider)
7. **All hops failed** → `503` with the list of attempts in the body.
8. **Settle** — insert the ledger row and replace the reservation with the actual cost of the hop that answered (0 on failure), in one SQL transaction.

## 4. Components (`src/`)

```
src/
  server.ts            app wiring, routes
  config.ts            load + validate gateway.json and env
  auth.ts              key hashing, lookup middleware
  ratelimit.ts         token bucket (in memory, per tenant)
  budget.ts            input-token estimate, worst-case cost across a chain
  pricing.ts           price lookup (dated periods, long-context tiers) → micro-dollars
  router.ts            chain resolution + attempt loop
  breaker.ts           circuit breaker per provider:model
  errors.ts            error classification (retryable or not)
  db.ts                node:sqlite schema + queries
  admin.ts             admin routes
  providers/
    types.ts           ChatRequest / ChatResponse / StreamChunk (OpenAI shape)
    openai-compat.ts   passthrough for any OpenAI-compatible API (Google Gemini; OpenAI/OpenRouter optional)
    anthropic.ts       OpenAI ⇄ Anthropic Messages translation, incl. SSE events
    sse.ts             server-sent events parser shared by the streaming adapters
    fake.ts            configurable failures, latency, mid-stream cuts; for tests and the chaos bench
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
`routeStream()` pulls each hop's stream until its **first real output** (content, a finish reason, or usage); role-only chunks are buffered. Nothing has been sent to the client yet, so an error — or no output within `timeouts.firstTokenMs` — moves on to the next hop invisibly. Once a hop produces output the gateway commits: response headers and the buffered chunks go out, and from then on `timeouts.perHopMs` is the maximum silence between chunks. A failure after that point is sent as a final SSE `data: {"error": ...}` event (no `[DONE]`) and is never retried: you cannot un-send tokens. If every hop fails before committing, the client gets the same JSON `503` as a non-streaming request.

- **Usage.** Adapters always ask the provider for usage and emit exactly one final chunk with `choices: []` and the billable usage. Gemini repeats a cumulative usage on every chunk, so `normalizeStream()` keeps the latest. The usage chunk reaches the client only if it sent `stream_options.include_usage`; `stream_options` itself is never forwarded upstream.
- **Billing a cut stream.** When usage is unknown because the stream ended early (mid-stream provider failure → ledger status `502`; client disconnect → `499`, upstream call aborted), the tenant is charged the full reservation. The provider may have billed partial output, so charging less could under-charge.
- `x-gateway-cost-usd` is not sent on streams: headers leave before the cost is known. The cost is in the ledger.
- `providers/sse.ts` is a ~30-line SSE parser shared by both adapters (buffers across network chunks, handles CRLF).

### Budget accounting
- Month spend in `tenant_spend(tenant_id, period, usd_micros)`; money stored as integer **micro-dollars**, never floats.
- **Reserve → settle.** Before calling any provider, the worst-case cost is added to the month's spend; after the response it is swapped for the actual cost. Concurrent requests therefore can't overshoot the budget (tested with 50 concurrent requests).
- Worst case = input estimate (~3 chars/token, deliberately high) × input price + `max_tokens × maxTokensOverrun` × output price, maximised over every hop in the chain.
- `maxTokensOverrun` (per provider, default 1): Gemini sometimes bills more output than `max_tokens` because of thinking tokens (observed 76 billed for `max_tokens: 50`), so `google` is configured at 2. Anthropic honours `max_tokens` exactly.
- Consequence: a request is admitted only if its *worst case* fits in the remaining budget. A tenant with little budget left gets `402` for large `max_tokens` but can still send smaller requests.
- Residual risk: the budget can still be exceeded if the input estimate is too low (e.g. text that tokenizes very densely) or a provider overruns past its factor. The overshoot is limited to that one request.
- Prices live in `config/pricing.json`, copied from provider pricing pages with the date checked. Periods with a `from` date handle announced price changes (Gemini 3.6 Flash doubles on 2027-01-01); `longContext` handles prompt-length tiers (Claude Haiku 5.5 above 100k tokens). Startup fails if any alias hop has no price.

### Rate limiting
In-memory token bucket per tenant (requests/min and tokens/min). Buckets can go negative: tokens/min takes the input estimate up front and charges actual usage afterwards, so a tenant that used more than estimated waits for the refill. A request whose input alone exceeds the tokens/min limit is rejected with `400` (it could never fit). Correct for one instance; multi-instance needs Redis (v2), and only `ratelimit.ts` changes.

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
    "google":     { "type": "openai-compat", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "keyEnv": "GEMINI_API_KEY", "maxTokensOverrun": 2 }
  },
  "aliases": {
    "smart": ["anthropic:claude-sonnet-5-5", "google:gemini-3.6-flash"],
    "fast":  ["anthropic:claude-haiku-5-5", "google:gemini-3.1-flash-lite"]
  },
  "timeouts": { "perHopMs": 30000, "firstTokenMs": 10000 },
  "breaker":  { "window": 20, "minFailures": 5, "failureRate": 0.5, "openMs": 30000 },
  "defaults": { "maxTokens": 1024, "maxTokensCeiling": 8192, "rpm": 60, "tpm": 100000, "monthlyBudgetUsd": 50 }
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
- Runs on any container host that keeps one long-lived process and a persistent volume (a VPS with Coolify, Fly.io, Railway). Serverless platforms do not fit: no shared memory for breakers and rate limits, no persistent disk. Secrets as host env vars.
- No public demo instance is hosted: a public endpoint holding real provider keys is spend exposure with no portfolio upside. The benchmark and tests are the evidence.
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
| 2026-10-10 | Budgets use reserve → settle in v1 (was planned for v2) | Check-then-charge: concurrent requests could overshoot; reserve → settle is a few lines with single-process SQLite |
| 2026-10-10 | Per-provider `maxTokensOverrun` factor in the reservation (google = 2) | Trust `max_tokens`: Gemini billed 76 output tokens for `max_tokens: 50` |
| 2026-10-10 | Gemini smart backup moved to `gemini-3.6-flash` | `gemini-3.5-flash`: no longer on Google's pricing page, so its cost can't be computed |
| 2026-10-10 | Streaming commits on first real output; separate `firstTokenMs` and idle (`perHopMs`) timeouts | One total timeout: would either kill long answers or wait too long for a dead provider |
| 2026-10-10 | Cut streams (502/499) are charged the full reservation | Charge 0 or estimate from streamed text: providers bill partial output, and thinking tokens are invisible |
| 2026-10-10 | No hosted demo; ship a Docker image and a README written for decision-makers | Public demo with real provider keys (spend exposure); demo tenant with a tiny budget (still a public key surface) |
