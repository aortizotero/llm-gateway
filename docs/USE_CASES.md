# B2B Use Cases — LLM Gateway

The gateway is use-case agnostic. These scenarios decide **which demo story the README tells** and which config/tenants ship in `examples/`. Pick one as primary; the others can be short sections.

| # | Scenario | Who buys it (global) | Gateway features it exercises | Demo story |
|---|---|---|---|---|
| **A** | **B2B company operating a fleet of AI bots** — one company runs many bots (support, sales, onboarding, ops) for its business customers | B2B SaaS and service companies whose product includes AI bots (LatAm, EU, US) | Per-tenant keys (tenant = customer account), budgets = plan tiers, per-customer usage for invoicing, failover protecting every customer's SLA | "40 customer bots behind one gateway: Anthropic goes down at 10:02, zero customers notice; customer X hits its plan cap and gets a clean 402" |
| **B** | **Enterprise internal AI platform (FinOps chargeback)** — central platform team gives LLM access to business units | Large enterprises, banks, telcos, retailers | Per-team budgets, monthly chargeback report, key revocation, rate isolation | "Marketing's runaway script is capped at $500; Legal's contract review never slows down" |
| **C** | **Customer-support copilot with SLA** — contact-center AI must answer 24/7 | CX platforms, contact centers, e-commerce | Fallback chain, breakers, streaming fallback before first token, latency tracking | "99.5% success with the primary provider fully down; p95 overhead 12 ms" |
| **D** | **Regulated / data-residency routing** — tenants pinned to region-specific endpoints | Fintech, health, public sector (EU GDPR, LGPD Brazil, LFPDPPP Mexico) | Per-tenant chain restricted to approved providers/regions, audit ledger | "EU tenants only ever hit EU endpoints — proven by the ledger" (needs v3 residency feature) |
| **E** | **Cost-tiered routing** — send cheap tasks to small models, hard ones to large | Any company with high-volume classification/extraction | Aliases (`fast` vs `smart`), cost per request in headers, spend per alias | "Same workload, 70% cheaper by routing triage to `fast`" (needs v2 cost-aware routing for the automatic version) |

## Decision (2026-10-10)

**A is the primary story, with C's numbers as the proof.**

- It is the scenario the v1 feature set covers completely (no v2/v3 features needed).
- It is a real operator problem: one company, many bots, many paying customers who each expect uptime and a predictable bill.
- It reads globally: "B2B company running AI bots for its customers" is a pattern recruiters and buyers recognize in any market.
- B is the same mechanics with different naming (tenant = team), so it can be a one-paragraph section in the README.

D and E go in the roadmap section, since they depend on later versions.
