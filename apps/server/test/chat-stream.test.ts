import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ChatStreamEvent, ModelEvent } from '@health-ai/shared';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/common/errors.js';
import { encodeEvent, SseWriter } from '../src/common/sse.js';
import { openDatabase } from '../src/database/db.js';
import { ChatRepository } from '../src/modules/chat/chat.repository.js';
import { ChatService, type StreamOptions } from '../src/modules/chat/chat.service.js';
import type { ChatInput, ModelProvider } from '../src/providers/model-provider.js';

function provider(generate: (input: ChatInput) => AsyncIterable<ModelEvent>): ModelProvider {
  return { name: 'test', chatStream: generate };
}
const normal = provider(async function* () {
  yield { type: 'reasoning', delta: 'internal' };
  yield { type: 'content', delta: '你好' };
  yield { type: 'content', delta: '🙂\n世界' };
  yield { type: 'done', fullContent: '你好🙂\n世界' };
});
function setup(t: TestContext, options: StreamOptions = { provider: normal }) {
  const db = openDatabase(':memory:');
  const repo = new ChatRepository(db);
  const service = new ChatService(repo, options);
  const conversation = repo.createConversation();
  t.after(async () => { await service.shutdown(); db.close(); });
  return { db, repo, service, id: conversation.id };
}

test('service commits every delta before sending; final commit precedes complete, with exact identity', async (t) => {
  const { repo, service, id } = setup(t);
  const turn = service.prepareTurn(id, '你好');
  const frames: ChatStreamEvent[] = [];
  let published = '';
  await service.runTurn(turn, { async send(frame) {
    frames.push(frame);
    const saved = repo.getMessages(id)[1]!;
    if (frame.event === 'content_delta') {
      published += frame.data.delta;
      assert.equal(saved.content, published);
    }
    if (frame.event === 'message_complete') {
      assert.equal(saved.status, 'completed');
      assert.ok(saved.completedAt);
      // Late connection close cannot demote a committed success.
      turn.controller.abort();
    }
  } });
  assert.deepEqual(frames.map((frame) => frame.event), ['message_start', 'content_delta', 'message_complete']);
  assert.equal(published, '你好🙂\n世界');
  assert.equal(repo.getMessages(id)[1]?.status, 'completed');
  assert.equal(JSON.stringify(frames).includes('internal'), false);
  assert.equal(frames[0]?.event === 'message_start' && frames[0].data.messageId, turn.assistant.id);
});

test('75ms batch tick publishes while upstream is waiting; byte threshold publishes immediately', async (t) => {
  for (const flushBytes of [1, 1024]) {
    let released!: () => void;
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const { service, repo, id } = setup(t, {
      flushIntervalMs: 5, flushBytes,
      provider: provider(async function* () {
        yield { type: 'content', delta: '中文🙂' };
        await gate;
        yield { type: 'done', fullContent: '中文🙂' };
      }),
    });
    await service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) {
      if (frame.event === 'content_delta') { assert.equal(repo.getMessages(id)[1]?.content, '中文🙂'); released(); }
    } });
    assert.equal(repo.getMessages(id)[1]?.status, 'completed');
  }
});

test('partial output retained on provider failure and no done EOF is never completed', async (t) => {
  for (const fail of [false, true]) {
    const { service, repo, id } = setup(t, { provider: provider(async function* () {
      yield { type: 'content', delta: '保留片段' };
      if (fail) throw new AppError('RATE_LIMITED');
    }) });
    const frames: ChatStreamEvent[] = [];
    await service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) { frames.push(frame); } });
    assert.equal(repo.getMessages(id)[1]?.content, '保留片段');
    assert.equal(repo.getMessages(id)[1]?.status, 'failed');
    assert.deepEqual(frames.at(-1), { event: 'message_error', data: {
      code: fail ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', message: fail ? '请求过于频繁，请稍后重试' : '模型服务异常，请稍后重试',
    } });
  }
});

test('same-conversation lock and busy delete; other conversations proceed; cancel retains tail and releases lock', async (t) => {
  let observedAbort = false;
  const { service, repo, id } = setup(t, { flushBytes: 1, provider: provider(async function* (input) {
    input.signal?.addEventListener('abort', () => { observedAbort = true; }, { once: true });
    yield { type: 'content', delta: '已生成' };
    await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
  }) });
  const turn = service.prepareTurn(id, 'first');
  assert.throws(() => service.prepareTurn(id, 'second'), { code: 'CONVERSATION_BUSY' });
  assert.throws(() => service.deleteConversation(id), { code: 'CONVERSATION_BUSY' });
  const other = repo.createConversation();
  const otherTurn = service.prepareTurn(other.id, 'other');
  otherTurn.controller.abort();
  await service.runTurn(otherTurn, { async send() {} });
  await service.runTurn(turn, { async send(frame) { if (frame.event === 'content_delta') turn.controller.abort(); } });
  assert.equal(observedAbort, true);
  assert.equal(repo.getMessages(id)[1]?.content, '已生成');
  assert.equal(repo.getMessages(id)[1]?.status, 'cancelled');
  const retry = service.prepareTurn(id, 'retry');
  retry.controller.abort();
  await service.runTurn(retry, { async send() {} });
});

test('reasoning does not reset content idle timeout; silent non-cooperative iterator cannot retain lock', async (t) => {
  let upstreamSignal: AbortSignal | undefined;
  const { service, repo, id } = setup(t, { idleTimeoutMs: 25, flushIntervalMs: 5,
    provider: provider(async function* (input) {
      upstreamSignal = input.signal;
      for (let i = 0; i < 30; i++) { await delay(3); yield { type: 'reasoning', delta: 'ignored' }; }
    }),
  });
  const frames: ChatStreamEvent[] = [];
  await service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) { frames.push(frame); } });
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(repo.getMessages(id)[1]?.status, 'failed');
  assert.equal(frames.at(-1)?.event === 'message_error' && (frames.at(-1) as { data: { code: string } }).data.code, 'UPSTREAM_TIMEOUT');
});

test('shutdown cancels silent upstream before closing DB', async (t) => {
  const { service, repo, id } = setup(t, { idleTimeoutMs: 100, flushBytes: 1,
    provider: provider(async function* () {
      yield { type: 'content', delta: '片段' };
      await new Promise<void>(() => {});
    }),
  });
  let seen!: () => void;
  const ready = new Promise<void>((resolve) => { seen = resolve; });
  const running = service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) { if (frame.event === 'content_delta') seen(); } });
  await ready;
  await service.shutdown();
  await running;
  assert.equal(repo.getMessages(id)[1]?.status, 'cancelled');
  assert.equal(repo.getMessages(id)[1]?.content, '片段');
});

test('each content delta resets the idle deadline during a response longer than the deadline', async (t) => {
  const { service, repo, id } = setup(t, { idleTimeoutMs: 90, flushIntervalMs: 5,
    provider: provider(async function* () {
      for (let i = 0; i < 5; i++) { await delay(30); yield { type: 'content', delta: '字' }; }
      yield { type: 'done', fullContent: '字'.repeat(5) };
    }),
  });
  await service.runTurn(service.prepareTurn(id, 'test'), { async send() {} });
  assert.equal(repo.getMessages(id)[1]?.status, 'completed');
});

test('batch write error never publishes an uncommitted delta; failed tail can still be committed', async (t) => {
  const { service, repo, db, id } = setup(t, { provider: normal, flushBytes: 1 });
  const turn = service.prepareTurn(id, 'test');
  db.exec(`CREATE TRIGGER reject_batch BEFORE UPDATE ON messages WHEN NEW.status='streaming'
    BEGIN SELECT RAISE(ABORT,'private database details'); END`);
  const frames: ChatStreamEvent[] = [];
  await service.runTurn(turn, { async send(frame) { frames.push(frame); } });
  assert.deepEqual(frames.map((frame) => frame.event), ['message_start', 'message_error']);
  assert.equal(repo.getMessages(id)[1]?.content, '你好');
  assert.equal(repo.getMessages(id)[1]?.status, 'failed');
  assert.equal(JSON.stringify(frames).includes('private'), false);
  assert.equal(frames.at(-1)?.event === 'message_error' && (frames.at(-1) as { data: { code: string } }).data.code, 'INTERNAL_ERROR');
});

test('SSE HTTP inject validates before headers/insert; strict request body and safe configuration error', async (t) => {
  t.mock.method(console, 'error', () => {}); // Expected CONFIG_ERROR is not a real .env failure.
  const db = openDatabase(':memory:');
  const app = buildApp({ database: db, provider: normal });
  const unconfigured = buildApp();
  t.after(async () => { await app.close(); await unconfigured.close(); db.close(); });
  const repo = new ChatRepository(db);
  const id = repo.createConversation().id;
  for (const payload of [undefined, {}, { conversationId: id, message: ' ' }, { conversationId: id, message: 'x'.repeat(8001) },
    { conversationId: id, message: 'hi', messages: [] }, { conversationId: 4, message: 'hi' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/chat/stream', payload });
    assert.equal(response.statusCode, 400);
    assert.match(response.headers['content-type'] ?? '', /application\/json/);
  }
  assert.deepEqual(repo.getMessages(id), []);
  const missing = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { conversationId: 'missing', message: 'hi' } });
  assert.equal(missing.statusCode, 404);
  const created = (await unconfigured.inject({ method: 'POST', url: '/api/conversations' })).json();
  const configError = await unconfigured.inject({ method: 'POST', url: '/api/chat/stream', payload: { conversationId: created.conversation.id, message: 'hi' } });
  assert.equal(configError.statusCode, 500);
  assert.equal(configError.json().code, 'CONFIG_ERROR');
  const result = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { conversationId: id, message: ' hi ' } });
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-type'] ?? '', /text\/event-stream/);
  assert.equal(result.headers['x-accel-buffering'], 'no');
  assert.equal(result.headers['cache-control'], 'no-cache');
  assert.match(result.body, /event: message_complete\n/);
  assert.equal(repo.getMessages(id)[0]?.content, 'hi');
  assert.equal(repo.getMessages(id)[1]?.status, 'completed');
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  frames: string[] = [];
  blocked = false;
  write(data: string) { this.frames.push(data); return !this.blocked; }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('writer waits for drain, skips heartbeats under pressure and cleans listeners; normal end does not cancel', async () => {
  const raw = new FakeResponse();
  raw.blocked = true;
  let cancellations = 0;
  const writer = new SseWriter(raw as unknown as ServerResponse, () => { cancellations++; }, 5, 100);
  let sent = false;
  const sending = writer.send({ event: 'content_delta', data: { delta: 'line\n🙂' } }).then(() => { sent = true; });
  await delay(16);
  assert.equal(raw.frames.length, 1);
  assert.equal(sent, false);
  raw.blocked = false;
  raw.emit('drain');
  await sending;
  writer.close();
  assert.equal(cancellations, 0);
  assert.equal(raw.listenerCount('drain'), 0);
  assert.equal(raw.listenerCount('close'), 0);
  assert.equal(raw.listenerCount('error'), 0);
  assert.equal(raw.frames[0], 'event: content_delta\ndata: {"delta":"line\\n🙂"}\n\n');
});

test('writer disconnect/backpressure deadline aborts and releases listeners without a queue', async () => {
  for (const mode of ['close', 'timeout'] as const) {
    const raw = new FakeResponse();
    raw.blocked = true;
    let cancellations = 0;
    const writer = new SseWriter(raw as unknown as ServerResponse, () => { cancellations++; }, 3, 15);
    const sending = writer.send({ event: 'message_start', data: { messageId: 'm' } });
    if (mode === 'close') raw.destroy();
    await assert.rejects(sending);
    assert.equal(cancellations, 1);
    assert.equal(raw.listenerCount('drain'), 0);
    assert.equal(raw.frames.length, 1);
    writer.close();
  }
  assert.equal(encodeEvent({ event: 'message_complete', data: { messageId: 'm' } }), 'event: message_complete\ndata: {"messageId":"m"}\n\n');
});

test('writer notices a response disconnected before its listeners were attached', async () => {
  const raw = new FakeResponse();
  raw.destroy();
  let cancelled = false;
  const writer = new SseWriter(raw as unknown as ServerResponse, () => { cancelled = true; });
  await assert.rejects(writer.send({ event: 'message_start', data: { messageId: 'm' } }));
  assert.equal(cancelled, true);
  writer.close();
  assert.equal(raw.listenerCount('error'), 0);
  assert.equal(raw.listenerCount('close'), 0);
});
