# LLM Gateway

Self-hosted, OpenAI-compatible gateway for running LLMs in production across teams or customers: per-tenant keys, budgets and rate limits, provider fallback with circuit breakers, and a real-time cost ledger.

> Status: **M2 (resilience) done** — OpenAI-compatible endpoint, Anthropic + Google Gemini adapters, per-tenant hashed keys, usage ledger, provider fallback chains with circuit breakers. Budgets and rate limits come in M3. Design docs: [`PRD`](docs/PRD.md) · [`Architecture`](docs/ARCHITECTURE.md) · [`Rules`](docs/RULES.md) · [`Use cases`](docs/USE_CASES.md).

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
| `GATEWAY_ADMIN_KEY` | from M3 | Protects `/admin/*` routes |
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
| Both providers healthy | 100.0% | 100.0% | 2000 | 1.00 | 1.5 ms | 3.3 ms | 6.8 ms |
| Primary 30% errors (503) | 70.2% | 100.0% | 39 | 1.01 | 1.4 ms | 2.3 ms | 2.9 ms |
| Primary 30% errors, backup 10% errors | 70.2% | 89.8% | 39 | 1.01 | 1.6 ms | 2.1 ms | 3.1 ms |
| Primary fully down (503) | 0.0% | 100.0% | 20 | 1.01 | 1.1 ms | 1.4 ms | 3.4 ms |
| Primary hangs, breaker on | 0.0% | 100.0% | 24 | 1.01 | 0.1 ms | 0.2 ms | 205.0 ms |
| Primary hangs, breaker off | 0.0% | 100.0% | 2000 | 2.00 | 206.6 ms | 208.4 ms | 212.3 ms |

**Reading it**

- **Overhead:** with healthy providers the gateway adds 3.3 ms at p95 (auth, routing, SQLite ledger write).
- **Primary fully down:** 0% → 100%. Only 20 requests ever reach the dead provider: the ones already in flight (concurrency 20) when the breaker opened.
- **Primary hangs:** without a breaker every request pays the full timeout before falling back (p50 207 ms; with a production 30 s timeout that is 30 s per request). With the breaker, only the first 24 do, and p95 drops to 0.2 ms.
- **The trade-off (row 3):** a 50% threshold on a 20-request window sometimes trips on a provider with only 30% errors, because short bursts of failures happen by chance. Once it trips, traffic moves to the backup, and the backup's own 10% errors have no hop left. Success is 89.8%, where trying both providers on every request would give ~97%. The breaker trades a little success under partial failure for big latency wins under hard failure.
