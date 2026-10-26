import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../src/errors.ts';
import { fromAnthropic, toAnthropic } from '../src/providers/anthropic.ts';

test('system messages move to the top-level system field', () => {
  const body = toAnthropic(
    {
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      ],
      stop: 'END',
    },
    1024,
  );
  assert.equal(body.system, 'Be brief.');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.stop_sequences, ['END']);
});

test('max_completion_tokens wins over max_tokens', () => {
  const body = toAnthropic(
    { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10, max_completion_tokens: 20 },
    1024,
  );
  assert.equal(body.max_tokens, 20);
});

test('sampling params are dropped for models that only accept defaults', () => {
  const req = { messages: [{ role: 'user' as const, content: 'x' }], temperature: 0.2, top_p: 0.9 };
  const current = toAnthropic({ ...req, model: 'claude-haiku-5-5' }, 1024);
  assert.equal(current.temperature, undefined);
  assert.equal(current.top_p, undefined);
  const legacy = toAnthropic({ ...req, model: 'claude-haiku-4-5' }, 1024);
  assert.equal(legacy.temperature, 0.2);
  assert.equal(legacy.top_p, 0.9);
});

test('non-text content parts are rejected as a client error', () => {
  assert.throws(
    () => toAnthropic({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }, 1024),
    (err: unknown) => err instanceof GatewayError && err.status === 400,
  );
});

test('response maps text, finish reason and usage including cache tokens', () => {
  const res = fromAnthropic({
    id: 'msg_1',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 },
  });
  assert.equal(res.choices[0].message.content, 'Hello there');
  assert.equal(res.choices[0].finish_reason, 'length');
  assert.deepEqual(res.usage, { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 });
});
