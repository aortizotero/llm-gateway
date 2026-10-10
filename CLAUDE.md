# CLAUDE.md — LLM Gateway

## Goal

A self-hosted HTTP gateway between applications and LLM providers: one OpenAI-compatible endpoint, per-tenant keys, per-tenant monthly budgets and rate limits, provider fallback chains with circuit breakers, and a usage/cost ledger.

## Source documents (read before coding)

- `docs/PRD.md`: problem, requirements (F1–F14), metrics, milestones M1–M5.
- `docs/ARCHITECTURE.md`: stack, request lifecycle, components, data model, decisions.
- `docs/RULES.md`: engineering rules. Mandatory.
- `docs/USE_CASES.md`: B2B scenarios. Primary demo scenario: **A — a B2B company operating a fleet of AI bots for its business customers**.

## Stack (summary)

Node ≥ 24 + TypeScript with no build step (native type stripping), `hono`, `node:sqlite`, `node:test`, `fetch` without provider SDKs. Providers: Anthropic (native adapter) and Google Gemini (OpenAI-compatible endpoint). Deployed as a Docker container, not serverless (needs a long-running process).

## Conventions

- Everything in the repo is in English: docs, README, code, comments, commits.
- Secrets live in `.env` (gitignored), loaded with `node --env-file=.env`. Variables: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GATEWAY_ADMIN_KEY`.
- Model prices (`config/pricing.json`) are filled from each provider's pricing page, never from memory.
- README numbers come only from `bench/chaos.ts` output.
- Personal/local notes go in `CLAUDE.local.md` (gitignored), never here.

## Status

- Docs done (PRD, ARCHITECTURE, RULES, USE_CASES).
- **M1 done**: non-streaming proxy, Anthropic + Gemini adapters, hashed tenant keys (`npm run create-key`), ledger (cost = 0 until M3 pricing). 15 tests pass; smoke-tested against both real providers.
- Known: Gemini Pro needs a paid tier (smart backup uses `gemini-3.5-flash` meanwhile). `gemini-3.8-flash` was overloaded (503) during M1.
- **M2 done**: fallback across the alias chain, circuit breaker per `provider:model` (`src/breaker.ts`), `x-gateway-provider` / `x-gateway-attempts` headers, 503 with attempt trail when every hop fails, chaos bench (`bench/chaos.ts`, results in README). 25 tests pass.
- Decision: the breaker can trip on a provider with ~30% errors. Kept as is and documented as a trade-off in the README (rejected: larger sample size = slower detection; last-resort retry of open circuits = a hung provider costs the full timeout).
- **M3 done**: pricing (`config/pricing.json` + `src/pricing.ts`, dated periods and long-context tiers), rate limits (`src/ratelimit.ts`), strict budgets via reserve → settle (`db.reserve` / `db.settle`), per-provider `maxTokensOverrun` (google = 2), admin API (`src/admin.ts`), `x-gateway-cost-usd`. 49 tests pass; smoke-tested against real providers.
- Prices last checked 2026-10-10. Gemini 3.6 Flash doubles on 2027-01-01 (already encoded). `gemini-3.5-flash` disappeared from Google's pricing page → smart backup is `gemini-3.6-flash`.
- Next: M4 (streaming with fallback before the first token).
