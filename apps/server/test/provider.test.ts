import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientOptions } from 'openai';
import { AppError } from '../src/common/errors.js';
import { DeepSeekProvider } from '../src/providers/deepseek.provider.js';
import type { ChatInput, ModelEvent } from '../src/providers/model-provider.js';

type Fetch = NonNullable<ClientOptions['fetch']>;
const CONFIG = { apiKey: 'test-key-not-real', baseURL: 'https://unit-test.invalid/v1' };
const INPUT: ChatInput = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'test input' }] };
const encoder = new TextEncoder();

function chunk(content?: string, finish: string | null = null, reasoning?: string) {
  return {
    id: 'unit-completion', object: 'chat.completion.chunk', created: 0, model: 'unit-model',
    choices: [{ index: 0, delta: {
      ...(content === undefined ? {} : { content }),
      ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
    }, finish_reason: finish }],
  };
}

function sse(items: unknown[], sentinel = true): Response {
  const text = items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('')
    + (sentinel ? 'data: [DONE]\n\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(provider: DeepSeekProvider, input = INPUT): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.chatStream(input)) events.push(event);
  return events;
}

test('SDK serializes DeepSeek extension at top level and respects input model', async () => {
  let calls = 0;
  const fetch: Fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://unit-test.invalid/v1/chat/completions');
    assert.ok(init && typeof init.body === 'string');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: 'configured-model', messages: INPUT.messages, stream: true,
      thinking: { type: 'disabled' }, max_tokens: 4096,
    });
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-key-not-real');
    return sse([chunk('连接'), chunk('成功。'), chunk(undefined, 'stop')]);
  };
  const events = await collect(new DeepSeekProvider(CONFIG, { fetch }), { ...INPUT, model: 'configured-model' });
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    { type: 'content', delta: '连接' }, { type: 'content', delta: '成功。' },
    { type: 'done', fullContent: '连接成功。' },
  ]);
});

test('reasoning is an internal event; usage and empty deltas do not corrupt content', async () => {
  const provider = new DeepSeekProvider(CONFIG, { fetch: async () => sse([
    chunk(undefined, null, 'internal-only'), chunk(''), chunk('answer'),
    chunk(undefined, 'stop'), { choices: [], usage: { total_tokens: 4 } },
  ]) });
  assert.deepEqual(await collect(provider), [
    { type: 'reasoning', delta: 'internal-only' },
    { type: 'content', delta: 'answer' }, { type: 'done', fullContent: 'answer' },
  ]);
});

test('HTTP errors map once to public codes without exposing upstream content', async (t) => {
  const cases = [
    [401, 'CONFIG_ERROR'], [403, 'CONFIG_ERROR'], [429, 'RATE_LIMITED'],
    [408, 'UPSTREAM_TIMEOUT'], [504, 'UPSTREAM_TIMEOUT'], [500, 'UPSTREAM_ERROR'],
  ] as const;
  for (const [status, code] of cases) {
    await t.test(String(status), async () => {
      let calls = 0;
      const provider = new DeepSeekProvider(CONFIG, { fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: 'test-secret-upstream-payload' } }), {
          status, headers: { 'content-type': 'application/json', 'x-secret-header': 'test-secret-header' },
        });
      } });
      await assert.rejects(collect(provider), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes('test-secret'), false);
        assert.equal('headers' in error, false);
        assert.equal('cause' in error, false);
        return true;
      });
      assert.equal(calls, 1, 'SDK retries must be disabled');
    });
  }
});

test('network failures are sanitized and not retried', async () => {
  let calls = 0;
  const provider = new DeepSeekProvider(CONFIG, { fetch: async () => {
    calls++;
    throw new Error('test-secret-network-details');
  } });
  await assert.rejects(collect(provider), (error: unknown) => error instanceof AppError
    && error.code === 'UPSTREAM_ERROR' && !error.message.includes('test-secret'));
  assert.equal(calls, 1);
});

test('a truncated stream retains emitted content and does not produce done', async () => {
  const provider = new DeepSeekProvider(CONFIG, { fetch: async () => sse([chunk('saved-prefix')], false) });
  const events: ModelEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of provider.chatStream(INPUT)) events.push(event);
  }, (error: unknown) => error instanceof AppError && error.code === 'UPSTREAM_ERROR');
  assert.deepEqual(events, [{ type: 'content', delta: 'saved-prefix' }]);
});

test('length, content_filter and tool finish reasons never indicate completed', async (t) => {
  for (const reason of ['length', 'content_filter', 'tool_calls']) {
    await t.test(reason, async () => {
      const provider = new DeepSeekProvider(CONFIG, { fetch: async () => sse([chunk('prefix'), chunk(undefined, reason)]) });
      const events: ModelEvent[] = [];
      await assert.rejects(async () => {
        for await (const event of provider.chatStream(INPUT)) events.push(event);
      }, (error: unknown) => error instanceof AppError && error.code === 'UPSTREAM_ERROR');
      assert.deepEqual(events, [{ type: 'content', delta: 'prefix' }]);
    });
  }
});

test('empty answer and post-stop content are upstream protocol failures', async (t) => {
  const cases = [
    { name: 'empty answer', frames: [chunk(undefined, 'stop')] },
    { name: 'post-stop content', frames: [chunk('answer', 'stop'), chunk('unexpected')] },
  ];
  for (const { name, frames } of cases) {
    await t.test(name, async () => {
      const provider = new DeepSeekProvider(CONFIG, { fetch: async () => sse(frames) });
      await assert.rejects(collect(provider), (error: unknown) => error instanceof AppError && error.code === 'UPSTREAM_ERROR');
    });
  }
});

test('invalid SSE JSON and in-stream error frames are sanitized', async (t) => {
  const cases = [
    { name: 'invalid JSON', text: 'data: {invalid-json}\n\n' },
    { name: 'upstream error event', text: 'data: {"error":{"message":"test-secret"}}\n\n' },
  ];
  for (const { name, text } of cases) {
    await t.test(name, async () => {
      const logs: unknown[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
      const provider = new DeepSeekProvider(CONFIG, { fetch: async () => new Response(text, {
        headers: { 'content-type': 'text/event-stream' },
      }) });
      await assert.rejects(collect(provider), (error: unknown) => error instanceof AppError
        && error.code === 'UPSTREAM_ERROR' && !error.message.includes('test-secret'));
      assert.equal(logs.length, 0, 'SDK logging is disabled for credential and payload isolation');
    });
  }
});

test('an already-aborted request makes no upstream call', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const provider = new DeepSeekProvider(CONFIG, { fetch: async () => { calls++; return sse([]); } });
  await assert.rejects(collect(provider, { ...INPUT, signal: controller.signal }), {
    name: 'AbortError', message: 'Request cancelled',
  });
  assert.equal(calls, 0);
});

test('abort propagates to SDK transport after partial output', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let transportSignal: AbortSignal | null | undefined;
  const fetch: Fetch = async (_url, init) => {
    transportSignal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(body) {
        body.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('prefix'))}\n\n`));
        transportSignal?.addEventListener('abort', () => body.error(new DOMException('Transport cancelled', 'AbortError')), { once: true });
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = new DeepSeekProvider(CONFIG, { fetch });
  const iterator = provider.chatStream({ ...INPUT, signal: controller.signal })[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: 'content', delta: 'prefix' });
  controller.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(transportSignal?.aborted, true);
});

test('consumer early return cancels the SDK transport', { timeout: 2000 }, async () => {
  let transportSignal: AbortSignal | null | undefined;
  let bodyCancelled = false;
  const provider = new DeepSeekProvider(CONFIG, { fetch: async (_url, init) => {
    transportSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('prefix'))}\n\n`)); },
      cancel() { bodyCancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  for await (const event of provider.chatStream(INPUT)) {
    assert.equal(event.type, 'content');
    break;
  }
  assert.equal(transportSignal?.aborted, true);
  assert.equal(bodyCancelled, true);
});

test('SDK connection timeout maps to UPSTREAM_TIMEOUT with no retry', { timeout: 2000 }, async () => {
  let calls = 0;
  const provider = new DeepSeekProvider(CONFIG, { timeoutMs: 20, fetch: async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Test timeout', 'AbortError')), { once: true });
    });
  } });
  await assert.rejects(collect(provider), (error: unknown) => error instanceof AppError && error.code === 'UPSTREAM_TIMEOUT');
  assert.equal(calls, 1);
});
