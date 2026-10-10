import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fake } from '../src/providers/fake.ts';
import { chat, down, setup } from './helpers.ts';

test('rejects missing and unknown keys with 401', async () => {
  const { call } = setup();
  assert.equal((await call(chat(), '')).status, 401);
  assert.equal((await call(chat(), 'Bearer gw_nope')).status, 401);
});

test('healthy primary serves the request and the ledger records it', async () => {
  const primary = fake({ reply: 'hello' });
  const backup = fake();
  const { call, ledger } = setup({ primary, backup });
  const res = await call(chat());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(primary.calls[0].model, 'model-a');
  assert.equal(backup.calls.length, 0);
  assert.equal(res.headers.get('x-gateway-provider'), 'primary:model-a');

  const [row] = ledger();
  assert.equal(row.alias, 'smart');
  assert.equal(row.provider, 'primary');
  assert.equal(row.input_tokens, 10);
  assert.equal(row.output_tokens, 5);
  assert.equal(row.attempts, 1);
  assert.equal(row.status, 200);
});

test('retryable upstream errors fall back to the next hop', async () => {
  for (const upstream of [401, 403, 429, 500, 503, 529]) {
    const backup = fake();
    const { call, ledger } = setup({ primary: down(upstream), backup });
    const res = await call(chat());
    assert.equal(res.status, 200, `upstream ${upstream}`);
    assert.equal(res.headers.get('x-gateway-provider'), 'backup:model-b');
    assert.equal(res.headers.get('x-gateway-attempts'), '2');
    assert.equal(backup.calls[0].model, 'model-b');
    assert.equal(ledger()[0].provider, 'backup');
    assert.equal(ledger()[0].attempts, 2);
  }
});

test('timeouts fall back to the next hop', async () => {
  const { call } = setup({ primary: fake({ latencyMs: 1000 }), backup: fake() });
  const res = await call(chat());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'backup:model-b');
});

test('client errors are not retried and pass through', async () => {
  for (const upstream of [400, 404, 422]) {
    const backup = fake();
    const { call } = setup({ primary: down(upstream), backup });
    assert.equal((await call(chat())).status, upstream);
    assert.equal(backup.calls.length, 0, `upstream ${upstream} must not reach the backup`);
  }
});

test('all hops failing returns 503 with the attempt trail', async () => {
  const { call, ledger } = setup({ primary: down(500), backup: down(429) });
  const res = await call(chat());
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { type: string }; attempts: { hop: string; status: number }[] };
  assert.equal(body.error.type, 'no_provider_available');
  assert.deepEqual(
    body.attempts.map((a) => [a.hop, a.status]),
    [['primary:model-a', 500], ['backup:model-b', 429]],
  );
  assert.equal(ledger()[0].status, 503);
});

test('once the breaker opens, the dead primary is skipped entirely', async () => {
  const primary = down();
  const { call } = setup({ primary, backup: fake() });
  for (let i = 0; i < 10; i++) assert.equal((await call(chat())).status, 200);
  // minFailures = 5: after 5 failures the circuit opens and the next 5 requests go straight to the backup.
  assert.equal(primary.calls.length, 5);
});

test('concrete provider:model bypasses aliases', async () => {
  const backup = fake();
  const { call } = setup({ primary: fake(), backup });
  assert.equal((await call(chat('backup:model-z'))).status, 200);
  assert.equal(backup.calls[0].model, 'model-z');
});

test('unknown model is a 404', async () => {
  const { call } = setup();
  assert.equal((await call(chat('nope'))).status, 404);
  assert.equal((await call(chat('ghost:model'))).status, 404);
});

test('unsupported features and bad bodies are 400', async () => {
  const { call } = setup();
  assert.equal((await call({ ...chat(), stream: true })).status, 400);
  assert.equal((await call({ ...chat(), tools: [] })).status, 400);
  assert.equal((await call({ model: 'smart', messages: [] })).status, 400);
});

test('every response carries the security headers', async () => {
  const { call } = setup();
  const res = await call(chat());
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
