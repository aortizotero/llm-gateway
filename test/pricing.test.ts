import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costMicros, loadPricing, type Pricing } from '../src/pricing.ts';

const pricing: Pricing = {
  'p:dated': [{ input: 0.75, output: 3.75 }, { from: '2027-01-01', input: 1.5, output: 7.5 }],
  'p:long': [{ input: 0.1, output: 0.5, longContext: { aboveInputTokens: 100000, input: 0.5, output: 2.5 } }],
};

test('USD per 1M tokens × tokens = micro-dollars, rounded up', () => {
  // 1000 × 0.75 + 100 × 3.75 = 1125 µ$
  assert.equal(costMicros(pricing, 'p:dated', 1000, 100, new Date('2026-10-10')), 1125);
  // 1 × 0.1 = 0.1 µ$ → 1 (never under-charge)
  assert.equal(costMicros(pricing, 'p:long', 1, 0), 1);
});

test('dated price periods switch on their start date', () => {
  assert.equal(costMicros(pricing, 'p:dated', 1_000_000, 0, new Date('2026-12-31T23:59:59Z')), 750_000);
  assert.equal(costMicros(pricing, 'p:dated', 1_000_000, 0, new Date('2027-01-01T00:00:00Z')), 1_500_000);
});

test('long-context rates apply only above the threshold', () => {
  assert.equal(costMicros(pricing, 'p:long', 100_000, 0), 10_000);
  assert.equal(costMicros(pricing, 'p:long', 100_001, 0), 50_001);
});

test('unpriced model throws', () => {
  assert.throws(() => costMicros(pricing, 'p:missing', 1, 1));
});

test('shipped pricing.json covers every configured alias hop', async () => {
  const { loadConfig, validatePricing } = await import('../src/config.ts');
  assert.doesNotThrow(() => validatePricing(loadConfig(), loadPricing()));
});
