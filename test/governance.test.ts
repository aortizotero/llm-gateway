import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fake } from '../src/providers/fake.ts';
import { createRateLimiter } from '../src/ratelimit.ts';
import { chat, setup } from './helpers.ts';

// ---- Rate limiting -------------------------------------------------------

test('token bucket refills continuously and reports when to retry', () => {
  let t = 0;
  const rl = createRateLimiter(() => t);
  assert.equal(rl.take('k', 60, 60).ok, true);
  const denied = rl.take('k', 60, 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.retryAfterSec, 1);
  t += 1000; // 60/min = 1 per second
  assert.equal(rl.take('k', 60, 1).ok, true);
});

test('a bucket in debt blocks until the refill pays it off', () => {
  let t = 0;
  const rl = createRateLimiter(() => t);
  rl.charge('k', 60, 120); // 60 available, charged 120 → -60
  assert.equal(rl.take('k', 60, 1).ok, false);
  t += 60_000;
  assert.equal(rl.take('k', 60, 1).ok, false); // back to 0
  t += 1000;
  assert.equal(rl.take('k', 60, 1).ok, true);
});

test('requests per minute: excess requests get 429 with Retry-After', async () => {
  const { call, ledger } = setup(undefined, { rpm: 3 }, () => 0);
  for (let i = 0; i < 3; i++) assert.equal((await call(chat())).status, 200);
  const res = await call(chat());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '20');
  assert.equal(ledger().length, 3); // throttled requests never reach a provider
});

test('tenants are isolated: one tenant at its limit does not affect another', async () => {
  const a = setup(undefined, { rpm: 1 }, () => 0);
  assert.equal((await a.call(chat())).status, 200);
  assert.equal((await a.call(chat())).status, 429);

  const otherId = a.db.createTenant('Other', { rpm: 1, tpm: 1e9, monthlyBudgetUsd: 50 });
  const otherKey = a.db.createKey(otherId).key;
  assert.equal((await a.call(chat(), `Bearer ${otherKey}`)).status, 200);
});

test('a request bigger than the tokens/min limit is rejected outright', async () => {
  const { call } = setup(undefined, { tpm: 10 });
  const res = await call({ model: 'smart', messages: [{ role: 'user', content: 'x'.repeat(300) }] });
  assert.equal(res.status, 400);
});

// ---- Budgets -------------------------------------------------------------

test('cost is charged from the pricing of the hop that answered', async () => {
  const { call, ledger, db, tenantId } = setup();
  const res = await call(chat());
  assert.equal(res.headers.get('x-gateway-cost-usd'), '0.000020'); // model-a: 10×1 + 5×2 = 20 µ$
  assert.equal(ledger()[0].cost_usd_micros, 20);
  assert.equal(db.spend(tenantId), 20); // reservation replaced by the actual cost
});

test('fallback is charged at the backup price', async () => {
  const { call, db, tenantId } = setup({ primary: fake({ failRate: 1 }), backup: fake() });
  await call(chat());
  assert.equal(db.spend(tenantId), 200); // model-b: 10×10 + 5×20
});

test('failed requests release their reservation and cost nothing', async () => {
  const { call, db, tenantId } = setup({ primary: fake({ failRate: 1 }), backup: fake({ failRate: 1 }) });
  assert.equal((await call(chat())).status, 503);
  assert.equal(db.spend(tenantId), 0);
});

test('exhausted budget returns 402 before calling any provider', async () => {
  const primary = fake();
  // Worst case for one request: input estimate 5 tokens, max_tokens 100 → model-b 5×10 + 100×20 = 2050 µ$.
  const { call } = setup({ primary, backup: fake() }, { monthlyBudgetUsd: 0.002 });
  const res = await call(chat());
  assert.equal(res.status, 402);
  assert.equal(primary.calls.length, 0);
});

test('budget is strict under concurrency: reserve-then-settle never overshoots', async () => {
  // Each request reserves 2050 µ$ and settles at 20 µ$. With a 0.01 USD budget only 4 fit in flight at once.
  const primary = fake({ latencyMs: 20 });
  const { call, db, tenantId } = setup({ primary, backup: fake() }, { monthlyBudgetUsd: 0.01 });
  const statuses = await Promise.all(Array.from({ length: 50 }, () => call(chat()).then((r) => r.status)));

  assert.equal(statuses.filter((s) => s === 200).length, 4);
  assert.equal(statuses.filter((s) => s === 402).length, 46);
  assert.equal(primary.calls.length, 4);
  assert.ok(db.spend(tenantId) <= 10_000);
  assert.equal(db.spend(tenantId), 80);
});

test('reservation covers providers that bill past max_tokens', async () => {
  const { maxCostMicros } = await import('../src/budget.ts');
  const { config, pricing } = await import('./helpers.ts');
  const hops = [{ provider: 'backup', model: 'model-b' }];
  const overrun = { ...config, providers: { ...config.providers, backup: { ...config.providers.backup, maxTokensOverrun: 2 } } };
  // model-b: 10 in × 10 + 100 out × 20 = 2100 µ$; with 2× overrun: 10 × 10 + 200 × 20 = 4100 µ$
  assert.equal(maxCostMicros(config, pricing, hops, 10, 100), 2100);
  assert.equal(maxCostMicros(overrun, pricing, hops, 10, 100), 4100);
});

test('max_tokens above the ceiling is rejected', async () => {
  const { call } = setup();
  assert.equal((await call(chat('smart', { max_tokens: 1001 }))).status, 400);
  assert.equal((await call(chat('smart', { max_tokens: 1000 }))).status, 200);
});

test('every request gets an explicit max_tokens sent upstream', async () => {
  const primary = fake();
  const { call } = setup({ primary, backup: fake() });
  await call(chat());
  await call(chat('smart', { max_completion_tokens: 42 }));
  assert.equal(primary.calls[0].max_tokens, 100); // config default
  assert.equal(primary.calls[1].max_tokens, 42);
  assert.equal(primary.calls[1].max_completion_tokens, undefined);
});

test('a hop without a price is refused', async () => {
  const { call } = setup();
  assert.equal((await call(chat('primary:unpriced'))).status, 400);
});

// ---- Admin API -----------------------------------------------------------

test('admin routes require the admin key', async () => {
  const { admin, key } = setup();
  assert.equal((await admin('GET', '/breakers', undefined, '')).status, 401);
  assert.equal((await admin('GET', '/breakers', undefined, `Bearer ${key}`)).status, 401);
  assert.equal((await admin('GET', '/breakers')).status, 200);
});

test('admin: create tenant, issue key, use it, revoke it', async () => {
  const { admin, call } = setup();
  const tenant = (await (await admin('POST', '/tenants', { name: 'Globex', monthlyBudgetUsd: 5, rpm: 10 })).json()) as {
    id: string;
    monthlyBudgetUsd: number;
    rpm: number;
  };
  assert.equal(tenant.monthlyBudgetUsd, 5);
  assert.equal(tenant.rpm, 10);

  const issued = await admin('POST', `/tenants/${tenant.id}/keys`);
  assert.equal(issued.status, 201);
  const { id, key } = (await issued.json()) as { id: string; key: string };
  assert.match(key, /^gw_/);
  assert.equal((await call(chat(), `Bearer ${key}`)).status, 200);

  assert.equal((await admin('DELETE', `/keys/${id}`)).status, 204);
  assert.equal((await call(chat(), `Bearer ${key}`)).status, 401);
  assert.equal((await admin('DELETE', `/keys/${id}`)).status, 404);
});

test('admin: raising the budget unblocks a tenant', async () => {
  const { admin, call, tenantId } = setup(undefined, { monthlyBudgetUsd: 0 });
  assert.equal((await call(chat())).status, 402);
  assert.equal((await admin('PATCH', `/tenants/${tenantId}`, { monthlyBudgetUsd: 1 })).status, 200);
  assert.equal((await call(chat())).status, 200);
  assert.equal((await admin('PATCH', `/tenants/${tenantId}`, { rpm: -1 })).status, 400);
});

test('admin: usage reports spend and per-model breakdown for the period', async () => {
  const { admin, call, tenantId } = setup({ primary: fake(), backup: fake() });
  await call(chat());
  await call(chat());
  await call(chat('backup:model-b'));
  const usage = (await (await admin('GET', `/usage?tenant=${tenantId}`)).json()) as {
    spentUsd: number;
    remainingUsd: number;
    byModel: Array<{ provider: string; requests: number; costUsd: number }>;
  };
  assert.equal(usage.spentUsd, 0.00024); // 2 × 20 + 200 µ$
  assert.equal(usage.remainingUsd, 49.99976);
  assert.deepEqual(
    usage.byModel.map((m) => [m.provider, m.requests, m.costUsd]),
    [['backup', 1, 0.0002], ['primary', 2, 0.00004]],
  );
});

test('admin API is disabled without GATEWAY_ADMIN_KEY', async () => {
  const { createApp } = await import('../src/server.ts');
  const { openDb } = await import('../src/db.ts');
  const { config, pricing } = await import('./helpers.ts');
  const app = createApp({ config, pricing, db: openDb(':memory:'), adapters: {}, log: false });
  assert.equal((await app.request('/admin/breakers', { headers: { authorization: 'Bearer ' } })).status, 404);
});
