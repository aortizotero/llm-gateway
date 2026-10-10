# Engineering Rules — LLM Gateway

Rules for anyone (human or agent) writing code in this repo. If a rule needs breaking, update this file in the same commit and say why.

## Scope
1. Build only what the current milestone in `docs/PRD.md` needs. Non-goals stay non-goals.
2. No new runtime dependency without a line in the decisions log of `docs/ARCHITECTURE.md`. Current allowed set: `hono`, `@hono/node-server`.
3. Prefer Node built-ins (`node:sqlite`, `node:test`, `node:crypto`, `fetch`) over packages.

## Correctness
4. Money is integer micro-dollars (`usd_micros`). Never store or sum cost as floats.
5. Every provider call has a timeout (`AbortSignal.timeout`). No unbounded awaits on the network.
6. Never retry a non-retryable error (see table in ARCHITECTURE §5). Never fall back after the first streamed token.
7. Provider SDK-style hidden retries are forbidden; the router is the only place that decides retries.
8. Budget and spend writes happen in one SQL transaction.

## Security
9. Provider keys come only from env vars named in config. Never in `config/*.json`, never committed.
10. Gateway keys: generate with `crypto.randomBytes(32)`, prefix `gw_`, store SHA-256 only, return the plaintext exactly once.
11. Compare admin key with `crypto.timingSafeEqual`.
12. Logs never contain: `Authorization` headers, keys, or prompt/response bodies (log metadata only: tenant, model, tokens, cost, latency, status).
13. Security headers on every response (API profile, from `~/CLAUDE.md` convention):
    `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Frame-Options: DENY`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
    `Permissions-Policy` closed, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
    `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`. No CORS unless a real browser consumer exists.
    Verify with `curl -sI` after every deploy.
14. Request body size limit (1 MB) and `max_tokens` ceiling per tenant.

## Code style
15. TypeScript, ES modules, run by Node's native type stripping — so only erasable syntax: no `enum`, no `namespace`, no parameter properties. Use `import type` for types.
16. One file per component as laid out in ARCHITECTURE §4. Small pure functions; side effects at the edges (`db.ts`, adapters, `server.ts`).
17. Comments explain *why*, not *what*.

## Testing
18. Each P0 requirement has at least one `node:test` test. Fallback, breaker, budget and streaming-fallback tests use `providers/fake.ts` — tests never call real providers.
19. A bug fix comes with a test that fails without the fix.
20. Benchmark numbers in the README come from `bench/chaos.ts` output, pasted verbatim with the command used. Never invented or rounded up.

## Git
21. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`). One milestone = one or more PRs into `main`.
22. `.env*`, `data/`, `*.db` are gitignored.
