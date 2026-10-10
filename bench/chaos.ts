// Chaos benchmark: runs the real gateway in-process against fake providers with injected failures,
// and compares it with calling the primary provider directly (no gateway).
// Usage: node bench/chaos.ts [requests=2000] [concurrency=20]
// Output is a markdown table, pasted verbatim into the README (docs/RULES.md #20).
import { createBreakers } from '../src/breaker.ts';
import type { Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import type { Pricing } from '../src/pricing.ts';
import { fake, type FakeOptions } from '../src/providers/fake.ts';
import { createApp } from '../src/server.ts';

const REQUESTS = Number(process.argv[2] ?? 2000);
const CONCURRENCY = Number(process.argv[3] ?? 20);
const PER_HOP_MS = 200;
const BREAKER = { window: 20, minFailures: 5, failureRate: 0.5, openMs: 30000 };

interface Scenario {
  name: string;
  primary: FakeOptions;
  backup: FakeOptions;
  breaker?: boolean; // default true
}

const SCENARIOS: Scenario[] = [
  { name: 'Both providers healthy', primary: {}, backup: {} },
  { name: 'Primary 30% errors (503)', primary: { failRate: 0.3 }, backup: {} },
  { name: 'Primary 30% errors, backup 10% errors', primary: { failRate: 0.3 }, backup: { failRate: 0.1, seed: 2 } },
  { name: 'Primary fully down (503)', primary: { failRate: 1 }, backup: {} },
  { name: 'Primary hangs, breaker on', primary: { latencyMs: 5000 }, backup: {} },
  { name: 'Primary hangs, breaker off', primary: { latencyMs: 5000 }, backup: {}, breaker: false },
];

const config: Config = {
  providers: {
    primary: { type: 'openai-compat', baseUrl: 'http://fake', keyEnv: 'UNUSED' },
    backup: { type: 'openai-compat', baseUrl: 'http://fake', keyEnv: 'UNUSED' },
  },
  aliases: { smart: ['primary:model-a', 'backup:model-b'] },
  timeouts: { perHopMs: PER_HOP_MS, firstTokenMs: PER_HOP_MS },
  breaker: BREAKER,
  defaults: { maxTokens: 1024, maxTokensCeiling: 8192, rpm: 1e9, tpm: 1e12, monthlyBudgetUsd: 1e6 },
};

const pricing: Pricing = { 'primary:model-a': [{ input: 1, output: 1 }], 'backup:model-b': [{ input: 1, output: 1 }] };

const BODY = JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'hi' }] });

async function pool(n: number, concurrency: number, job: () => Promise<void>) {
  let started = 0;
  const worker = async () => {
    while (started < n) {
      started++;
      await job();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function viaGateway(s: Scenario) {
  const primary = fake(s.primary);
  const backup = fake({ seed: 3, ...s.backup });
  const db = openDb(':memory:');
  const { key } = db.createKey(db.createTenant('bench', config.defaults));
  const breakerCfg = s.breaker === false ? { ...BREAKER, minFailures: Infinity } : BREAKER;
  const app = createApp({ config, pricing, db, adapters: { primary, backup }, breakers: createBreakers(breakerCfg), log: false });

  let ok = 0;
  let attempts = 0;
  const latencies: number[] = [];
  await pool(REQUESTS, CONCURRENCY, async () => {
    const t = performance.now();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: BODY,
    });
    await res.arrayBuffer();
    latencies.push(performance.now() - t);
    if (res.status === 200) ok++;
    attempts += Number(res.headers.get('x-gateway-attempts') ?? 0);
  });
  latencies.sort((a, b) => a - b);
  return { ok, attempts, primaryCalls: primary.calls.length, latencies };
}

// Baseline: the app calls the primary provider itself, same failure pattern, same timeout.
async function direct(s: Scenario) {
  const primary = fake(s.primary);
  let ok = 0;
  await pool(REQUESTS, CONCURRENCY, async () => {
    try {
      await primary.chat({ model: 'model-a', messages: [] }, AbortSignal.timeout(PER_HOP_MS));
      ok++;
    } catch {}
  });
  return ok;
}

const pctStr = (n: number) => `${((n / REQUESTS) * 100).toFixed(1)}%`;
const ms = (n: number) => `${n.toFixed(1)} ms`;

console.log(`### Chaos benchmark\n`);
console.log(
  `\`node bench/chaos.ts ${REQUESTS} ${CONCURRENCY}\` — ${REQUESTS} requests, concurrency ${CONCURRENCY}, ` +
    `per-hop timeout ${PER_HOP_MS} ms, breaker opens at ${BREAKER.minFailures} failures / ${BREAKER.failureRate * 100}% of last ${BREAKER.window}. ` +
    `Gateway runs in-process (no network) against fake providers with zero latency, so latency = gateway overhead plus injected faults. ` +
    `Node ${process.version}, ${process.platform}.\n`,
);
console.log('| Scenario | Success, direct to primary | Success via gateway | Calls to primary | Avg attempts | p50 | p95 | p99 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const s of SCENARIOS) {
  const d = await direct(s);
  const g = await viaGateway(s);
  console.log(
    `| ${s.name} | ${pctStr(d)} | ${pctStr(g.ok)} | ${g.primaryCalls} | ${(g.attempts / REQUESTS).toFixed(2)} | ` +
      `${ms(pct(g.latencies, 50))} | ${ms(pct(g.latencies, 95))} | ${ms(pct(g.latencies, 99))} |`,
  );
}
