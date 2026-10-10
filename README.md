# LLM Gateway

A self-hosted, OpenAI-compatible gateway that lets one company run AI features for many customers on several LLM providers, **without single-provider outages, runaway spend, or one customer starving the others**.

Built as a working answer to a question every AI platform owner faces: *what has to sit between our products and the model providers once real customers depend on them?*

[Product requirements](docs/PRD.md) · [Architecture & decision log](docs/ARCHITECTURE.md) · [Engineering rules](docs/RULES.md) · [Use cases](docs/USE_CASES.md)

---

## The problem

Picture a B2B company running a fleet of AI bots (support, sales, onboarding) for hundreds of business customers ([scenario A](docs/USE_CASES.md)). Once that is in production, four problems show up:

| Problem | Business impact |
|---|---|
| **Provider outages.** Every major LLM provider has incidents. | Every customer's bot goes down at once, and SLAs are breached. |
| **Runaway cost.** A retry loop or one heavy customer can burn a month's budget in hours. | Margin erosion that nobody sees until next month's invoice, with no per-customer breakdown. |
| **No fair sharing.** One shared provider key means one noisy customer exhausts rate limits for everyone. | Good customers get degraded service because of someone else. |
| **Key sprawl.** Provider keys copied into every service. | Rotating or revoking a key becomes a project in itself. |

## What it does

Applications call **one OpenAI-compatible endpoint** with a per-customer key. For each request the gateway:

1. Authenticates the customer (tenant) and enforces **their** rate limits.
2. **Reserves the worst-case cost** against their monthly budget before spending any money.
3. Routes the request through an ordered **fallback chain** of providers (Anthropic → Google Gemini), skipping any provider whose **circuit breaker** is open.
4. Streams the answer back. Fallback still works on streams, as long as the first token hasn't been sent.
5. Settles the actual cost and writes it to a **per-customer ledger** in real time.

Provider keys live only in the gateway. Switching an existing app over takes one line: change the OpenAI SDK's `base_url`.

## Results

Measured with a chaos benchmark (fake providers with injected failures, 2,000 requests). Full table [below](#resilience-benchmark).

| Scenario | Without gateway | With gateway |
|---|---|---|
| Primary provider fully down | 0% of requests succeed | **100%** |
| Primary provider failing 30% of the time | 70.2% | **100%** |
| Primary provider hanging | every request waits for the timeout | **p95 0.3 ms**: the breaker stops sending traffic after 24 requests |
| Overhead added by the gateway | — | **4.1 ms at p95** |
| 50 concurrent requests against a small budget | — | **0 overspend**: exactly as many admitted as fit |

63 automated tests, plus smoke tests against the real Anthropic and Gemini APIs at every milestone.

## Key decisions and trade-offs

Each of these is logged with the rejected alternatives in the [decision log](docs/ARCHITECTURE.md#10-decisions-log).

- **Strict budgets over approximate ones.** The gateway reserves each request's worst-case cost *before* calling the provider and settles to the actual cost afterwards. The simpler check-then-charge approach lets concurrent requests overspend. The cost is that a customer near their limit gets refused for large requests that would probably have fit.
- **A circuit breaker that accepts a known weakness.** It sometimes trips on a provider that is only partly failing, which costs some success under partial failure (89.8% vs. ~97% in one benchmark row). In exchange it saves seconds of latency on every request when a provider hangs. I documented the trade-off rather than tuning it away, because the alternatives either detect dead providers more slowly or reintroduce the long hangs.
- **No fallback after the first token.** You cannot un-send text. Streams fail over invisibly before the first token and fail loudly after it.
- **When in doubt, charge the reservation.** If a stream is cut and the provider never reports usage, the customer is charged the reserved worst case. Under-charging silently loses money; over-charging is visible in the ledger and can be refunded.
- **Boring infrastructure for v1.** One process, SQLite, two runtime dependencies, no SDKs from the providers (their built-in retries would hide failures from the breaker). Multi-instance (Redis/Postgres) is a deliberate v2 step, not a v1 requirement.

## What real providers taught me

These came from smoke tests against live APIs, not from documentation. Each one changed the design.

1. **Hidden reasoning tokens are billed but not reported.** Gemini reported 7 output tokens for a call that billed 786; the rest were "thinking" tokens left out of `completion_tokens`. A gateway that trusts the reported field under-counts cost by about 100× on these calls.
2. **`max_tokens` is not a hard cap on every provider.** Gemini billed 76 tokens against a limit of 50. Budgets now apply a per-provider overrun factor.
3. **A response can be empty and still billed.** With `max_tokens: 300`, Gemini spent 303 tokens thinking and returned no text.
4. **Models disappear from price lists.** `gemini-3.5-flash` still answered requests but was no longer on Google's pricing page, so its cost could no longer be computed. The gateway now refuses to start if any model in a fallback chain has no price.
5. **Prices change on a schedule.** Gemini 3.6 Flash doubles its price on 2027-01-01. The pricing file supports dated price periods so the change is already encoded.
6. **Overload is routine.** One Gemini model returned `503 high demand` or took 38 s to answer during testing. That is the case the fallback chain exists for.

## Build vs. buy

In a real company I would most likely **adopt an existing gateway**, not build one. Mature options exist:

- [LiteLLM](https://docs.litellm.ai/docs/proxy/architecture.md) is an open-source proxy with virtual keys, per-key and per-team budgets, rate limits and fallbacks (keys need Postgres).
- [Portkey](https://portkey.ai/docs/product/ai-gateway) is a managed gateway with fallback configs and circuit breakers. Its [budget limits](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits) are tied to higher plans, and models it doesn't price don't count toward them.
- [OpenRouter](https://openrouter.ai/docs/guides/routing) is a hosted router with model fallback lists, billed per model that served the request.

Building one taught me **which questions to ask in that evaluation**. This project's answers are in parentheses:

| Question to ask a vendor | Why it matters |
|---|---|
| Is the budget enforced **before** the call or reconciled **after**? (before) | After-the-fact enforcement overshoots under concurrency. |
| How are **thinking tokens** counted, and does `max_tokens` bound them? (counted from `total − prompt`; overrun factor) | A gateway that misses them under-reports cost by orders of magnitude. |
| What happens to a **stream that fails mid-response**? (error event, never retried, charged conservatively) | Silent retries duplicate text; silent drops lose money. |
| Which errors trigger **fallback**, and which pass through? (provider failures and a bad provider key fall back; client errors don't) | Retrying a bad request on every provider multiplies cost and latency. |
| What happens to a model that **isn't in the price table**? (refused) | Unpriced models can be free-riding outside the budget. |
| Can the ledger answer **"what did customer X cost us this month, per model?"** (yes, `/admin/usage`) | That question decides pricing and margins. |

## If this ran at scale

- **Multiple instances:** move rate limits and breaker state to Redis and the ledger to Postgres. The interfaces are already isolated to one file each.
- **Cost-aware routing:** send simple requests to cheaper models automatically (planned for v2).
- **Guardrails:** PII redaction and prompt-injection checks as pre-request hooks (v2).
- **Data residency:** pin EU or regulated customers to region-specific endpoints, with the ledger as the audit trail (v3).
- **Price feed:** replace the hand-maintained `pricing.json` with a reviewed sync job. Prices change too often to keep by hand.

---

## Running it

Requires Node.js ≥ 24 (TypeScript runs natively, no build step) or Docker.

Create a `.env` file:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Anthropic provider |
| `GEMINI_API_KEY` | yes | Google Gemini provider |
| `GATEWAY_ADMIN_KEY` | for the admin API | Protects `/admin/*`; the admin API is disabled when unset |
| `DB_PATH` | no | SQLite file, default `data/gateway.db` |
| `PORT` | no | Default `8787` |

```bash
# Node
npm install
npm run create-key -- "Acme Corp"   # prints a gateway key, shown once
npm start

# or Docker (SQLite persisted in a named volume)
docker build -t llm-gateway .
docker run --env-file .env -p 8787:8787 -v llm-gateway-data:/data llm-gateway
```

Call it like the OpenAI API. `model` is an alias from `config/gateway.json` (`smart`, `fast`) or a concrete `provider:model` such as `google:gemini-3.6-flash`:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer gw_..." -H "Content-Type: application/json" \
  -d '{"model": "smart", "messages": [{"role": "user", "content": "Hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="gw_...")
```

Every proxied response carries `x-gateway-provider` (who answered), `x-gateway-attempts` and, for non-streaming calls, `x-gateway-cost-usd`. `GET /healthz` and `GET /readyz` are the liveness and readiness probes.

### Streaming

`"stream": true` works as with OpenAI (server-sent events ending in `data: [DONE]`). The gateway reads each provider until it produces real output, so a provider that errors or stays silent past `firstTokenMs` is skipped without the client noticing. After the first token, a provider failure ends the stream with an error event.

> **Gemini thinking models:** thinking tokens count against `max_tokens`. Give Gemini a generous `max_tokens`, or answers can come back empty and still be billed.

### Tenants, budgets and rate limits

Each tenant (one per customer account) has its own keys, a monthly USD budget, and requests/min + tokens/min limits.

```bash
ADMIN="Authorization: Bearer $GATEWAY_ADMIN_KEY"
curl -X POST   localhost:8787/admin/tenants -H "$ADMIN" -H "Content-Type: application/json" -d '{"name": "Acme Corp", "monthlyBudgetUsd": 200, "rpm": 120}'
curl -X POST   localhost:8787/admin/tenants/<tenant-id>/keys -H "$ADMIN"    # key returned once
curl -X DELETE localhost:8787/admin/keys/<key-id> -H "$ADMIN"
curl -X PATCH  localhost:8787/admin/tenants/<tenant-id> -H "$ADMIN" -H "Content-Type: application/json" -d '{"monthlyBudgetUsd": 500}'
curl "localhost:8787/admin/usage?tenant=<tenant-id>&period=2026-10" -H "$ADMIN"   # spend by provider and model
curl localhost:8787/admin/breakers -H "$ADMIN"
```

| Situation | Response |
|---|---|
| Over requests/min or tokens/min | `429` + `Retry-After` |
| Worst-case cost doesn't fit in the remaining budget | `402`, no provider called |
| Every provider in the chain failed | `503` with the attempt trail |

Prices come from [`config/pricing.json`](config/pricing.json), copied from each provider's pricing page with the date checked.

### Tests

```bash
npm test   # 63 tests; fake providers only, never real APIs
```

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
