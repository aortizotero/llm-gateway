# PRD — LLM Gateway

**Owner:** Alejandro Ortiz Otero · **Status:** Draft v0.1 · **Last updated:** 2026-10-10

## 1. Problem

Companies that put LLMs into production hit the same four walls once more than one team or customer depends on them:

1. **Outages.** Every major provider has incidents. An app hard-wired to one provider goes down with it.
2. **Runaway cost.** One bug in a loop, or one heavy tenant, can burn a month's budget in hours. Spend is usually visible only on the provider's invoice, weeks later and not broken down by team.
3. **No fair sharing.** A single shared API key means one noisy consumer can exhaust rate limits for everyone else.
4. **Key sprawl.** Provider keys get copied into every service, so revoking or rotating one is a project in itself.

## 2. Solution

A self-hosted HTTP gateway that sits between applications and LLM providers. Apps call **one OpenAI-compatible endpoint** with a **gateway key**. For each request the gateway:

- authenticates the caller and resolves its **team/tenant**
- enforces that tenant's **rate limit** and **budget** *before* spending money
- routes the request through an ordered **fallback chain** of providers, skipping any whose **circuit breaker** is open
- records tokens, cost, latency and the route taken in a **usage ledger**

Provider keys live only in the gateway.

## 3. Goals and non-goals

**Goals (v1)**
- Survive the failure of any single provider without client-side changes.
- Make it impossible for a tenant to exceed its budget by more than one in-flight request.
- Isolate tenants: one tenant hitting its rate limit never affects another.
- Give per-tenant cost visibility in real time, not on next month's invoice.
- Be measurable: ship a chaos benchmark whose numbers go in the README.

**Non-goals (v1)**
- Prompt/response caching, semantic caching.
- Guardrails/PII redaction (listed as v2 in the roadmap).
- A web dashboard (an admin JSON API is enough for v1).
- Multi-region active-active deployment.
- Embeddings, images, audio — chat completions only.

## 4. Users

| Persona | Needs |
|---|---|
| **Platform engineer** (operates the gateway) | Configure providers and fallback chains, create tenants and keys, see health. |
| **App developer** (calls the gateway) | Drop-in replacement for the OpenAI SDK: change `base_url` and key, nothing else. Clear errors when throttled or over budget. |
| **Finance / team lead** | Spend per tenant for the current period, and confidence that it is capped. |

## 5. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| F1 | `POST /v1/chat/completions`, OpenAI-compatible request/response, including `stream: true` (SSE). | P0 |
| F2 | Provider adapters: Anthropic (native Messages API) and Google Gemini (OpenAI-compatible endpoint). Any other OpenAI-compatible provider (OpenAI, OpenRouter) = config only. | P0 |
| F3 | Model **aliases** (e.g. `smart`, `fast`) mapped to an ordered fallback chain of `provider:model`. Clients may also request a concrete model. | P0 |
| F4 | Fallback on retryable errors: timeouts, network errors, HTTP 429, 5xx. Never on 4xx client errors (400/401/403/404/422). | P0 |
| F5 | Streaming fallback only **before the first token** is sent to the client. After that, an error is surfaced to the client. | P0 |
| F6 | Circuit breaker per `provider:model`: closed → open after N failures in a window → half-open after cooldown → closed on one success. | P0 |
| F7 | Gateway API keys per tenant, stored hashed (SHA-256), shown once at creation, revocable. | P0 |
| F8 | Per-tenant rate limit (requests/min and tokens/min) with `429` + `Retry-After`. | P0 |
| F9 | Per-tenant budget (USD per calendar month). Pre-check estimated cost; reject with `402` when exhausted. Post-charge actual cost. | P0 |
| F10 | Usage ledger: one row per request with tenant, alias, provider, model, input/output tokens, cost, latency, attempts, final status. | P0 |
| F11 | Admin API (separate admin key): create/revoke tenant keys, set budgets/limits, read usage per tenant, read breaker states. | P1 |
| F12 | `GET /healthz` (process up) and `GET /readyz` (config loaded, DB writable). | P1 |
| F13 | Response headers on every proxied call: `x-gateway-provider`, `x-gateway-attempts`, `x-gateway-cost-usd`. | P1 |
| F14 | Chaos benchmark script with a fake provider whose failure rate/latency can be set. | P0 |

## 6. Non-functional requirements

- **Overhead:** p95 added latency < 15 ms (gateway time excluding provider time), measured in the benchmark.
- **Availability:** with one provider at 100% failure, ≥ 99.5% of requests in the benchmark still succeed through fallback.
- **Budget accuracy:** overshoot bounded by the cost of the concurrent in-flight requests of that tenant.
- **Security:** no provider key or gateway key ever appears in logs or responses; security headers per `docs/RULES.md`.
- **Portability:** runs as one Docker container; zero external services required for v1 (SQLite file on a volume).

## 7. Success metrics (for the README)

| Metric | Target | How measured |
|---|---|---|
| Success rate with primary provider down | ≥ 99.5% | `bench/chaos` — primary at 100% errors |
| Success rate with primary at 30% errors, no gateway vs gateway | report both | same script, `--direct` vs gateway |
| Added p95 latency | < 15 ms | fake provider with fixed 0 ms latency |
| Budget overshoot under 50 concurrent requests | ≤ in-flight cost | bench with tiny budget |
| Time to detect a dead provider (breaker opens) | < 5 s | bench timeline |

## 8. Milestones

| Milestone | Scope | Done when |
|---|---|---|
| **M1 — Proxy** | F1 (non-stream), F2 Anthropic + Google, F7 static key, F10 | Real call through gateway to both providers |
| **M2 — Resilience** | F3, F4, F6, F14 fake provider | Chaos bench shows fallback working |
| **M3 — Governance** | F8, F9, F11 | Budget and rate limit tests pass under concurrency |
| **M4 — Streaming** | F1 stream, F5 | Streaming fallback test passes |
| **M5 — Ship** | F12, F13, Dockerfile, README for a decision-maker audience with bench numbers | Public repo; image builds and passes its health check. No hosted demo (see ARCHITECTURE decisions log) |

## 9. Roadmap after v1

- v2: PII redaction and prompt-injection guardrails as pre-request hooks.
- v2: Cost-aware routing (send simple prompts to cheaper models).
- v2: Postgres + Redis backend for multi-instance deployment.
- v3: Data residency routing (tenant pinned to EU/US endpoints).
- v3: Minimal dashboard.

## 10. Open questions

- ~~Primary demo scenario~~ — resolved: scenario A, a B2B company operating a fleet of AI bots for its customers (`docs/USE_CASES.md`).
- Model pricing table must be filled from each provider's current pricing page before M3 (`config/pricing.json`); never hardcoded from memory.
