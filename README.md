# LLM Gateway

Self-hosted, OpenAI-compatible gateway for running LLMs in production across teams or customers: per-tenant keys, budgets and rate limits, provider fallback with circuit breakers, and a real-time cost ledger.

> Status: **M4 (streaming) done** — OpenAI-compatible endpoint with streaming, Anthropic + Google Gemini adapters, provider fallback with circuit breakers (also for streams, before the first token), per-tenant keys, rate limits and strict monthly budgets, real-time cost ledger, admin API. Packaging and deployment come in M5. Design docs: [`PRD`](docs/PRD.md) · [`Architecture`](docs/ARCHITECTURE.md) · [`Rules`](docs/RULES.md) · [`Use cases`](docs/USE_CASES.md).

## Quick start

Requires Node.js ≥ 24 (TypeScript runs natively, no build step).

```bash
npm install
```

Create a `.env` file in the project root:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Anthropic provider |
| `GEMINI_API_KEY` | yes | Google Gemini provider |
| `GATEWAY_ADMIN_KEY` | for the admin API | Protects `/admin/*`; the admin API is disabled when unset |
| `DB_PATH` | no | SQLite file, default `data/gateway.db` |
| `PORT` | no | Default `8787` |

Create a tenant and its gateway key (shown once):

```bash
npm run create-key -- "Acme Corp"
```

Start the gateway and call it like the OpenAI API:

```bash
npm start

curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "smart", "messages": [{"role": "user", "content": "Hello"}]}'
```

`model` is an alias from `config/gateway.json` (`smart`, `fast`) or a concrete `provider:model` such as `google:gemini-3.5-flash`.

Any OpenAI SDK works by pointing `base_url` at the gateway:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="gw_...")
```

Every proxied response carries `x-gateway-provider` (who answered), `x-gateway-attempts` and, for non-streaming calls, `x-gateway-cost-usd`.

### Streaming

`"stream": true` works as with OpenAI (server-sent events ending in `data: [DONE]`). Fallback still applies, but only **before the first token**: the gateway reads each provider until it produces real output, so a provider that errors or stays silent past `firstTokenMs` is skipped without the client noticing. After the first token is sent, a provider failure ends the stream with an error event; it cannot be retried without sending duplicate text.

> **Gemini thinking models and `max_tokens`:** thinking tokens count against `max_tokens`. With `max_tokens: 300`, `gemini-3.6-flash` spent 303 tokens thinking and returned an empty answer, which was still billed. Give Gemini a generous `max_tokens`.

## Tenants, budgets and rate limits

Each tenant (one per customer account in the B2B bot-fleet scenario) has its own keys, a monthly USD budget, and requests/min + tokens/min limits.

```bash
ADMIN="Authorization: Bearer $GATEWAY_ADMIN_KEY"

# Create a tenant (defaults from config/gateway.json for anything omitted)
curl -X POST localhost:8787/admin/tenants -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"name": "Acme Corp", "monthlyBudgetUsd": 200, "rpm": 120}'

# Issue a key (returned once), revoke a key, change limits
curl -X POST   localhost:8787/admin/tenants/<tenant-id>/keys -H "$ADMIN"
curl -X DELETE localhost:8787/admin/keys/<key-id> -H "$ADMIN"
curl -X PATCH  localhost:8787/admin/tenants/<tenant-id> -H "$ADMIN" -H "Content-Type: application/json" -d '{"monthlyBudgetUsd": 500}'

# Spend this month, broken down by provider and model; circuit breaker states
curl "localhost:8787/admin/usage?tenant=<tenant-id>&period=2026-10" -H "$ADMIN"
curl localhost:8787/admin/breakers -H "$ADMIN"
```

| Situation | Response |
|---|---|
| Over requests/min or tokens/min | `429` + `Retry-After` |
| Worst-case cost of the request doesn't fit in the remaining budget | `402`, no provider called |
| Every provider in the chain failed | `503` with the attempt trail |

**How budgets stay strict.** Before calling a provider, the gateway reserves the request's worst-case cost (input estimate + `max_tokens`, at the most expensive model in the fallback chain) and swaps it for the actual cost afterwards. Fifty concurrent requests against a small budget admit exactly as many as fit, never more (see `test/governance.test.ts`). Gemini sometimes bills more than `max_tokens` because of thinking tokens (76 for a limit of 50 in testing), so its reservations use a 2× overrun factor.

Prices come from `config/pricing.json`, copied from each provider's pricing page with the date checked, including announced price changes and long-context tiers.

## Tests

```bash
npm test
```

Tests use a fake provider and never call real APIs.

## Resilience benchmark

`bench/chaos.ts` runs the gateway against fake providers with injected failures and compares it with an app calling the primary provider directly. Output pasted verbatim:

### Chaos benchmark

`node bench/chaos.ts 2000 20` — 2000 requests, concurrency 20, per-hop timeout 200 ms, breaker opens at 5 failures / 50% of last 20. Gateway runs in-process (no network) against fake providers with zero latency, so latency = gateway overhead plus injected faults. Node v25.9.0, win32.

| Scenario | Success, direct to primary | Success via gateway | Calls to primary | Avg attempts | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| Both providers healthy | 100.0% | 100.0% | 2000 | 1.00 | 2.1 ms | 4.1 ms | 8.9 ms |
| Primary 30% errors (503) | 70.2% | 100.0% | 39 | 1.01 | 2.1 ms | 3.1 ms | 4.0 ms |
| Primary 30% errors, backup 10% errors | 70.2% | 89.8% | 39 | 1.01 | 2.4 ms | 3.1 ms | 4.3 ms |
| Primary fully down (503) | 0.0% | 100.0% | 20 | 1.01 | 1.8 ms | 2.2 ms | 3.7 ms |
| Primary hangs, breaker on | 0.0% | 100.0% | 24 | 1.01 | 0.2 ms | 0.3 ms | 220.1 ms |
| Primary hangs, breaker off | 0.0% | 100.0% | 2000 | 2.00 | 206.4 ms | 208.7 ms | 214.5 ms |

**Reading it**

- **Overhead:** with healthy providers the gateway adds 4.1 ms at p95 (auth, rate limiting, budget reservation and settlement, ledger write — two SQLite transactions per request).
- **Primary fully down:** 0% → 100%. Only 20 requests ever reach the dead provider: the ones already in flight (concurrency 20) when the breaker opened.
- **Primary hangs:** without a breaker every request pays the full timeout before falling back (p50 207 ms; with a production 30 s timeout that is 30 s per request). With the breaker, only the first 24 do, and p95 drops to 0.3 ms.
- **The trade-off (row 3):** a 50% threshold on a 20-request window sometimes trips on a provider with only 30% errors, because short bursts of failures happen by chance. Once it trips, traffic moves to the backup, and the backup's own 10% errors have no hop left. Success is 89.8%, where trying both providers on every request would give ~97%. The breaker trades a little success under partial failure for big latency wins under hard failure.
