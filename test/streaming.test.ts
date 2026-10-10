import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromAnthropicStream } from '../src/providers/anthropic.ts';
import { fake } from '../src/providers/fake.ts';
import { normalizeStream } from '../src/providers/openai-compat.ts';
import { parseSse, type SseEvent } from '../src/providers/sse.ts';
import type { StreamChunk } from '../src/providers/types.ts';
import { chat, down, setup } from './helpers.ts';

// Reads an SSE response into its data payloads.
async function readSse(res: Response): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of parseSse(res.body!)) out.push(ev.data);
  return out;
}

const textOf = (events: string[]) =>
  events
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d) as StreamChunk)
    .flatMap((c) => c.choices.map((ch) => ch.delta.content ?? ''))
    .join('');

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(ctrl) {
      // Split mid-event on purpose: the parser must buffer across network chunks.
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += 7) ctrl.enqueue(bytes.slice(i, i + 7));
      ctrl.close();
    },
  });

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---- SSE parsing and provider translation --------------------------------

test('SSE parser handles events split across network chunks and CRLF', async () => {
  const events = await collect(parseSse(streamOf('event: a\r\ndata: {"x":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n')));
  assert.deepEqual(events, [
    { event: 'a', data: '{"x":1}' },
    { event: undefined, data: 'line1\nline2' },
    { event: undefined, data: '[DONE]' },
  ]);
});

async function* events(list: object[]): AsyncGenerator<SseEvent> {
  for (const e of list) yield { data: JSON.stringify(e) };
}

test('Anthropic stream events become OpenAI chunks with usage at the end', async () => {
  const chunks = await collect(
    fromAnthropicStream(
      events([
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-5-5', usage: { input_tokens: 12, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'ping' },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]),
    ),
  );
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'Hello world');
  assert.equal(chunks.at(-2)!.choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1)!.choices, []);
  assert.deepEqual(chunks.at(-1)!.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
});

test('Anthropic mid-stream error event maps to a retryable status', async () => {
  await assert.rejects(
    collect(fromAnthropicStream(events([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]))),
    (err: { status: number }) => err.status === 529,
  );
});

test('Gemini-style cumulative usage on every chunk is emitted once, with thinking tokens', async () => {
  const base = { id: 'g', object: 'chat.completion.chunk' as const, created: 0, model: 'gemini' };
  async function* gemini(): AsyncGenerator<StreamChunk> {
    yield { ...base, choices: [{ index: 0, delta: { content: 'One' }, finish_reason: null }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 90 } };
    yield { ...base, choices: [{ index: 0, delta: { content: ' two' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 100 } };
  }
  const chunks = await collect(normalizeStream(gemini()));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].usage, undefined);
  assert.deepEqual(chunks[2].usage, { prompt_tokens: 12, completion_tokens: 88, total_tokens: 100 });
});

// ---- Gateway streaming ---------------------------------------------------

test('streams SSE chunks, ends with [DONE] and records the cost', async () => {
  const { call, ledger } = setup({ primary: fake({ reply: 'one two three' }), backup: fake() });
  const res = await call(chat('smart', { stream: true }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(res.headers.get('x-gateway-provider'), 'primary:model-a');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const data = await readSse(res);
  assert.equal(textOf(data), 'one two three');
  assert.equal(data.at(-1), '[DONE]');
  assert.ok(!data.some((d) => d !== '[DONE]' && JSON.parse(d).usage), 'usage chunk only when include_usage is set');

  const [row] = ledger();
  assert.equal(row.status, 200);
  assert.equal(row.output_tokens, 3);
  assert.equal(row.cost_usd_micros, 10 * 1 + 3 * 2);
});

test('stream_options.include_usage forwards the usage chunk', async () => {
  const { call } = setup();
  const data = await readSse(await call(chat('smart', { stream: true, stream_options: { include_usage: true } })));
  const usage = data.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d)).find((c) => c.usage);
  assert.deepEqual(usage.usage, { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
});

test('failure before the first token falls back invisibly to the next hop', async () => {
  const { call, ledger } = setup({ primary: down(529), backup: fake({ reply: 'from backup' }) });
  const res = await call(chat('smart', { stream: true }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-provider'), 'backup:model-b');
  assert.equal(res.headers.get('x-gateway-attempts'), '2');
  assert.equal(textOf(await readSse(res)), 'from backup');
  assert.equal(ledger()[0].provider, 'backup');
});

test('a slow first token counts as a failure and falls back', async () => {
  const { call } = setup({ primary: fake({ latencyMs: 1000 }), backup: fake({ reply: 'fast' }) });
  const res = await call(chat('smart', { stream: true }));
  assert.equal(res.headers.get('x-gateway-provider'), 'backup:model-b');
  assert.equal(textOf(await readSse(res)), 'fast');
});

test('failure after the first token is reported in-stream and never retried', async () => {
  const backup = fake();
  const { call, ledger, db, tenantId } = setup({ primary: fake({ reply: 'one two three', failAfterChunks: 1 }), backup });
  const res = await call(chat('smart', { stream: true }));
  assert.equal(res.status, 200); // headers were already sent
  const data = await readSse(res);
  assert.equal(textOf(data.slice(0, -1)), 'one');
  assert.equal(JSON.parse(data.at(-1)!).error.type, 'upstream_error');
  assert.ok(!data.includes('[DONE]'));
  assert.equal(backup.calls.length, 0);

  const [row] = ledger();
  assert.equal(row.status, 502);
  // Usage unknown after a cut: charged at the full reservation (5 est. input, 100 max out, model-b) — never under-charge.
  assert.equal(db.spend(tenantId), 5 * 10 + 100 * 20);
});

test('a stall after the first token is cut by the idle timeout', async () => {
  const { call, ledger } = setup({ primary: fake({ reply: 'one two', chunkDelayMs: 1000 }), backup: fake() });
  const res = await call(chat('smart', { stream: true }));
  const data = await readSse(res);
  assert.equal(JSON.parse(data.at(-1)!).error.type, 'upstream_error');
  assert.equal(ledger()[0].status, 502);
});

test('all hops failing before the first token returns a plain JSON 503', async () => {
  const { call } = setup({ primary: down(500), backup: down(503) });
  const res = await call(chat('smart', { stream: true }));
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = (await res.json()) as { attempts: unknown[] };
  assert.equal(body.attempts.length, 2);
});

test('streams go through the same budget reservation', async () => {
  const primary = fake();
  const { call } = setup({ primary, backup: fake() }, { monthlyBudgetUsd: 0.001 });
  assert.equal((await call(chat('smart', { stream: true }))).status, 402);
  assert.equal(primary.calls.length, 0);
});

test('stream_options is never forwarded upstream', async () => {
  const primary = fake();
  const { call } = setup({ primary, backup: fake() });
  await readSse(await call(chat('smart', { stream: true, stream_options: { include_usage: true } })));
  await call(chat('smart', { stream_options: { include_usage: true } }));
  assert.equal(primary.calls[0].stream_options, undefined);
  assert.equal(primary.calls[1].stream_options, undefined);
});
