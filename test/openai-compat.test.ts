import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billableUsage } from '../src/providers/openai-compat.ts';

test('hidden thinking tokens are counted as output (Gemini)', () => {
  assert.deepEqual(billableUsage({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 798 }), {
    prompt_tokens: 12,
    completion_tokens: 786,
    total_tokens: 798,
  });
});

test('consistent usage is left unchanged', () => {
  const usage = { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 };
  assert.deepEqual(billableUsage(usage), usage);
});

test('missing usage becomes zeros', () => {
  assert.deepEqual(billableUsage(undefined), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});
