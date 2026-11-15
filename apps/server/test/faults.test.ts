import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ERROR_CODES, ERROR_DEFINITIONS, type ChatStreamEvent, type ErrorCode } from '@health-ai/shared';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/common/errors.js';
import { openDatabase } from '../src/database/db.js';
import { ChatRepository } from '../src/modules/chat/chat.repository.js';
import { ChatService } from '../src/modules/chat/chat.service.js';
import { DeepSeekProvider } from '../src/providers/deepseek.provider.js';
import type { ChatInput, ModelProvider } from '../src/providers/model-provider.js';

function setup(t: TestContext, provider: ModelProvider) {
  const db = openDatabase(':memory:');
  const repo = new ChatRepository(db);
  const service = new ChatService(repo, { provider, flushBytes: 1 });
  const id = repo.createConversation().id;
  t.after(async () => { await service.shutdown(); db.close(); });
  return { db, repo, service, id };
}

test('all fixed errors retain exact status/message, no diagnostic fields or extra public codes', () => {
  assert.equal(ERROR_CODES.length, 8);
  for (const code of ERROR_CODES) {
    const error = new AppError(code);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, ERROR_DEFINITIONS[code].status);
    assert.equal(error.message, ERROR_DEFINITIONS[code].message);
    assert.equal('cause' in error || 'headers' in error, false);
  }
});

test('real SDK errors propagate through Service/SSE with one upstream call and sanitized failed state', async (t) => {
  const cases: [number, ErrorCode][] = [[401, 'CONFIG_ERROR'], [403, 'CONFIG_ERROR'], [429, 'RATE_LIMITED'],
    [408, 'UPSTREAM_TIMEOUT'], [504, 'UPSTREAM_TIMEOUT'], [500, 'UPSTREAM_ERROR']];
  for (const [status, code] of cases) {
    await t.test(String(status), async (t) => {
      let calls = 0;
      const provider = new DeepSeekProvider({ apiKey: 'p6-synthetic-secret', baseURL: 'https://example.invalid' }, {
        fetch: async () => {
          calls++;
          return Response.json({ error: { message: 'p6-private-upstream-data' } }, { status, headers: { 'x-private': 'p6-private-header' } });
        },
      });
      const db = openDatabase(':memory:');
      const app = buildApp({ database: db, provider });
      t.after(async () => { await app.close(); db.close(); });
      const repo = new ChatRepository(db);
      const id = repo.createConversation().id;
      const result = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { conversationId: id, message: 'p6-private-user' } });
      assert.equal(result.statusCode, 200); // Failures after start use SSE.
      assert.match(result.body, /event: message_start\n/);
      assert.ok(result.body.includes(JSON.stringify({ code, message: ERROR_DEFINITIONS[code].message })));
      assert.doesNotMatch(result.body, /message_complete|p6-private|p6-synthetic/);
      assert.equal(repo.getMessages(id)[1]?.status, 'failed');
      assert.equal(calls, 1);
    });
  }
});

test('atomic initial DB failure remains JSON and never calls the provider', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = openDatabase(':memory:');
  let calls = 0;
  const provider: ModelProvider = { name: 'unused', async *chatStream() { calls++; yield { type: 'done', fullContent: '' }; } };
  const app = buildApp({ database: db, provider });
  t.after(async () => { await app.close(); db.close(); });
  const repo = new ChatRepository(db);
  const id = repo.createConversation().id;
  db.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON messages WHEN NEW.role='assistant'
    BEGIN SELECT RAISE(ABORT,'private initial DB error'); END`);
  const result = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { conversationId: id, message: 'private user text' } });
  assert.equal(result.statusCode, 500);
  assert.match(result.headers['content-type'] ?? '', /application\/json/);
  assert.deepEqual(result.json(), { code: 'INTERNAL_ERROR', message: ERROR_DEFINITIONS.INTERNAL_ERROR.message });
  assert.deepEqual(repo.getMessages(id), []);
  assert.equal(calls, 0);
});

test('batch DB failure aborts upstream before waiting for the error frame and releases the conversation lock', async (t) => {
  let signal: AbortSignal | undefined;
  const provider: ModelProvider = { name: 'fault', async *chatStream(input) {
    signal = input.signal;
    yield { type: 'content', delta: 'kept tail' };
    await new Promise<void>(() => {});
  } };
  const { db, repo, service, id } = setup(t, provider);
  db.exec(`CREATE TRIGGER reject_batch BEFORE UPDATE ON messages WHEN NEW.status='streaming'
    BEGIN SELECT RAISE(ABORT,'private DB detail'); END`);
  const frames: ChatStreamEvent[] = [];
  let abortedAtError: boolean | undefined;
  await service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) {
    frames.push(frame);
    if (frame.event === 'message_error') abortedAtError = signal?.aborted;
  } });
  assert.equal(abortedAtError, true, 'Upstream must be stopped before potentially slow terminal writes');
  assert.equal(repo.getMessages(id)[1]?.status, 'failed');
  assert.equal(repo.getMessages(id)[1]?.content, 'kept tail');
  assert.deepEqual(frames.map((frame) => frame.event), ['message_start', 'message_error']);
  service.deleteConversation(id);
});

test('failed completion commit sends no false complete, retains published prefix and commits failed state', async (t) => {
  const provider: ModelProvider = { name: 'fault', async *chatStream() {
    yield { type: 'content', delta: 'published' };
    yield { type: 'done', fullContent: 'published' };
  } };
  const { db, repo, service, id } = setup(t, provider);
  db.exec(`CREATE TRIGGER reject_complete BEFORE UPDATE ON messages WHEN NEW.role='assistant' AND NEW.status='completed'
    BEGIN SELECT RAISE(ABORT,'private finalization detail'); END`);
  const frames: ChatStreamEvent[] = [];
  await service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) { frames.push(frame); } });
  assert.deepEqual(frames.map((frame) => frame.event), ['message_start', 'content_delta', 'message_error']);
  assert.equal(repo.getMessages(id)[1]?.content, 'published');
  assert.equal(repo.getMessages(id)[1]?.status, 'failed');
  assert.ok(JSON.stringify(frames).includes('INTERNAL_ERROR'));
  assert.doesNotMatch(JSON.stringify(frames), /private/);
});

test('total DB write outage preserves committed prefix, logs no SQL/text, sends no success and recovers after restart', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (message: unknown) => { logs.push(String(message)); });
  const provider: ModelProvider = { name: 'fault', async *chatStream() {
    yield { type: 'content', delta: 'prefix' };
    yield { type: 'content', delta: 'private tail' };
    yield { type: 'done', fullContent: 'prefixprivate tail' };
  } };
  const { db, repo, service, id } = setup(t, provider);
  const frames: ChatStreamEvent[] = [];
  await service.runTurn(service.prepareTurn(id, 'private user'), { async send(frame) {
    frames.push(frame);
    if (frame.event === 'content_delta') db.exec(`CREATE TRIGGER reject_writes BEFORE UPDATE ON messages
      BEGIN SELECT RAISE(ABORT,'private disk failure'); END`);
  } });
  assert.equal(repo.getMessages(id)[1]?.content, 'prefix');
  assert.equal(repo.getMessages(id)[1]?.status, 'streaming'); // Cannot claim a write that failed.
  assert.equal(frames.at(-1)?.event, 'message_error');
  assert.doesNotMatch(JSON.stringify(frames) + logs.join(''), /private/);
  db.exec('DROP TRIGGER reject_writes');
  assert.equal(repo.recoverInterruptedMessages(), 1);
  assert.equal(repo.getMessages(id)[1]?.status, 'failed');
  assert.equal(repo.getMessages(id)[1]?.content, 'prefix');
});

test('timeout before any content and after committed content remains failed, not cancelled', async (t) => {
  for (const partial of ['', 'prefix']) {
    let captured: ChatInput | undefined;
    const provider: ModelProvider = { name: 'silent', async *chatStream(input) {
      captured = input;
      if (partial) yield { type: 'content', delta: partial };
      await new Promise<void>(() => {});
    } };
    const { db, repo, id } = setup(t, provider);
    const service = new ChatService(repo, { provider, idleTimeoutMs: 15, flushBytes: 1 });
    const frames: ChatStreamEvent[] = [];
    await service.runTurn(service.prepareTurn(id, 'test'), { async send(frame) { frames.push(frame); } });
    assert.equal(captured?.signal?.aborted, true);
    assert.equal(repo.getMessages(id)[1]?.status, 'failed');
    assert.equal(repo.getMessages(id)[1]?.content, partial);
    assert.equal(frames.at(-1)?.event, 'message_error');
    assert.ok(JSON.stringify(frames.at(-1)).includes('UPSTREAM_TIMEOUT'));
    assert.equal(db.open, true);
  }
});
