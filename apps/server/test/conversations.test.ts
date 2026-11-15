import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ChatMessage, Conversation } from '@health-ai/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/database/db.js';
import { ChatRepository } from '../src/modules/chat/chat.repository.js';

function setup(t: TestContext) {
  const db = openDatabase(':memory:');
  const app = buildApp({ database: db });
  t.after(async () => { await app.close(); db.close(); });
  return { app, db, repository: new ChatRepository(db) };
}

test('conversation API creates, lists, reads all states and deletes with exact response contract', async (t) => {
  const { app, repository } = setup(t);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/conversations' })).json(), { conversations: [] });
  const created = await app.inject({ method: 'POST', url: '/api/conversations' });
  assert.equal(created.statusCode, 201);
  const { conversation } = created.json<{ conversation: Conversation }>();
  assert.equal(conversation.title, '新对话');
  assert.deepEqual(Object.keys(conversation).sort(), ['createdAt', 'id', 'title', 'updatedAt']);
  assert.equal(typeof conversation.createdAt, 'number');
  const turn = repository.createTurn(conversation.id, 'test content', 'test-model');
  repository.finalizeMessage(turn.assistant.id, 'cancelled', 'partial content');
  const list = await app.inject({ method: 'GET', url: '/api/conversations' });
  assert.equal(list.json<{ conversations: Conversation[] }>().conversations[0]?.id, conversation.id);
  const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}` });
  assert.equal(detail.statusCode, 200);
  const body = detail.json<{ conversation: Conversation; messages: ChatMessage[] }>();
  assert.deepEqual(Object.keys(body).sort(), ['conversation', 'messages']);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1]?.status, 'cancelled');
  assert.equal(body.messages[1]?.content, 'partial content');
  assert.deepEqual(Object.keys(body.messages[1] ?? {}).sort(), [
    'completedAt', 'content', 'conversationId', 'createdAt', 'id', 'model', 'role', 'status',
  ]);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/conversations/${conversation.id}` });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { ok: true });
  assert.deepEqual(repository.getMessages(conversation.id), []);
});

test('missing conversation and repeated deletion use existing 404 code', async (t) => {
  const { app } = setup(t);
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/api/conversations/not-found' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在或已删除' });
  }
});

test('unknown payload/query fields and whitespace ID are rejected without exposing input', async (t) => {
  const { app, repository } = setup(t);
  const cases = [
    { method: 'POST', url: '/api/conversations', payload: { title: 'test-secret-body' } },
    { method: 'GET', url: '/api/conversations?unexpected=test-secret-query' },
    { method: 'GET', url: '/api/conversations/%20%20' },
    { method: 'DELETE', url: '/api/conversations/not-found', payload: { unexpected: 'test-secret-body' } },
  ] as const;
  for (const request of cases) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { code: 'INVALID_PARAM', message: '输入有误，请检查后重试' });
    assert.equal(response.body.includes('test-secret'), false);
  }
  assert.deepEqual(repository.listConversations(), []);
});

test('invalid JSON, unsupported content type and oversized bodies have a uniform safe error', async (t) => {
  const { app } = setup(t);
  for (const request of [
    { headers: { 'content-type': 'application/json' }, payload: '{test-secret-invalid-json' },
    { headers: { 'content-type': 'application/xml' }, payload: '<test-secret />' },
    { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ message: 'x'.repeat(140 * 1024) }) },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/conversations', ...request });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { code: 'INVALID_PARAM', message: '输入有误，请检查后重试' });
    assert.equal(response.body.includes('test-secret'), false);
  }
});

test('DB write failures are safe 500 responses with no false success or leaked body', async (t) => {
  const { app, db, repository } = setup(t);
  const logs: string[] = [];
  t.mock.method(console, 'error', (message: unknown) => { logs.push(String(message)); });
  db.exec(`CREATE TRIGGER reject_conversation BEFORE INSERT ON conversations
    BEGIN SELECT RAISE(ABORT, 'test-secret-sql-error'); END`);
  const response = await app.inject({ method: 'POST', url: '/api/conversations' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { code: 'INTERNAL_ERROR', message: '服务异常，请重试' });
  assert.deepEqual(repository.listConversations(), []);
  assert.equal(response.body.includes('test-secret'), false);
  assert.equal(logs.join('').includes('test-secret'), false);
});
