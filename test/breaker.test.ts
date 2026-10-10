import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBreakers } from '../src/breaker.ts';

const cfg = { window: 10, minFailures: 3, failureRate: 0.5, openMs: 1000 };

function setup() {
  let t = 0;
  const b = createBreakers(cfg, () => t);
  return { b, advance: (ms: number) => (t += ms) };
}

test('opens after minFailures when the failure rate is high enough', () => {
  const { b } = setup();
  b.failure('p');
  b.failure('p');
  assert.equal(b.canPass('p'), true);
  b.failure('p');
  assert.equal(b.canPass('p'), false);
  assert.equal(b.states().p, 'open');
});

test('stays closed when failures are a minority of the window', () => {
  const { b } = setup();
  for (let i = 0; i < 7; i++) b.success('p');
  for (let i = 0; i < 3; i++) b.failure('p'); // 3/10 = 30% < 50%
  assert.equal(b.canPass('p'), true);
});

test('half-open lets exactly one probe through after the cooldown', () => {
  const { b, advance } = setup();
  for (let i = 0; i < 3; i++) b.failure('p');
  advance(999);
  assert.equal(b.canPass('p'), false);
  advance(1);
  assert.equal(b.canPass('p'), true); // the probe
  assert.equal(b.canPass('p'), false); // everyone else waits for it
});

test('a successful probe closes the circuit with a clean window', () => {
  const { b, advance } = setup();
  for (let i = 0; i < 3; i++) b.failure('p');
  advance(1000);
  b.canPass('p');
  b.success('p');
  assert.equal(b.states().p, 'closed');
  b.failure('p');
  b.failure('p');
  assert.equal(b.canPass('p'), true); // old failures were forgotten
});

test('a failed probe reopens the circuit for another cooldown', () => {
  const { b, advance } = setup();
  for (let i = 0; i < 3; i++) b.failure('p');
  advance(1000);
  b.canPass('p');
  b.failure('p');
  assert.equal(b.states().p, 'open');
  advance(999);
  assert.equal(b.canPass('p'), false);
});

test('a neutral outcome releases the probe without closing the circuit', () => {
  const { b, advance } = setup();
  for (let i = 0; i < 3; i++) b.failure('p');
  advance(1000);
  b.canPass('p');
  b.neutral('p');
  assert.equal(b.states().p, 'half-open');
  assert.equal(b.canPass('p'), true); // next request may probe
});

test('circuits are independent per key', () => {
  const { b } = setup();
  for (let i = 0; i < 3; i++) b.failure('a');
  assert.equal(b.canPass('a'), false);
  assert.equal(b.canPass('b'), true);
});
