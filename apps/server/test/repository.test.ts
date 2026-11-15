import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '@health-ai/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/database/db.js';
import { ChatRepository } from '../src/modules/chat/chat.repository.js';

function setup(t: TestContext, now = () => 1_700_000_000_000) {
  const db = openDatabase(':memory:');
  t.after(() => { if (db.open) db.close(); });
  return { db, repository: new ChatRepository(db, now) };
}

test('schema contains exactly the agreed fields, foreign key and index', (t) => {
  const { db } = setup(t);
  const names = (table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
  assert.deepEqual(names('conversations'), ['id', 'title', 'created_at', 'updated_at']);
  assert.deepEqual(names('messages'), ['id', 'conversation_id', 'role', 'content', 'status', 'model', 'created_at', 'completed_at']);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.ok((db.pragma('index_list(messages)') as { name: string }[]).some((row) => row.name === 'idx_messages_conversation'));
  const foreignKeys = db.pragma('foreign_key_list(messages)') as { table: string; on_delete: string }[];
  assert.equal(foreignKeys[0]?.table, 'conversations');
  assert.equal(foreignKeys[0]?.on_delete, 'CASCADE');
});

test('conversation defaults and ordering are deterministic even at identical timestamps', (t) => {
  let time = 1_700_000_000_000;
  const { repository } = setup(t, () => time);
  const first = repository.createConversation();
  const second = repository.createConversation();
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.title, '新对话');
  assert.equal(first.createdAt, time);
  assert.deepEqual(repository.listConversations().map((item) => item.id), [second.id, first.id]);
  time += 100;
  repository.createTurn(first.id, 'test', 'test-model');
  assert.deepEqual(repository.listConversations().map((item) => item.id), [first.id, second.id]);
  assert.equal(repository.getConversation(first.id)?.updatedAt, time);
});

test('createTurn atomically writes user followed by assistant at the same millisecond', (t) => {
  const { repository } = setup(t);
  const conversation = repository.createConversation();
  const { user, assistant } = repository.createTurn(conversation.id, '你好', 'test-model');
  assert.equal(user.status, 'completed');
  assert.equal(user.model, null);
  assert.equal(user.completedAt, user.createdAt);
  assert.equal(assistant.status, 'streaming');
  assert.equal(assistant.content, '');
  assert.equal(assistant.completedAt, null);
  assert.equal(assistant.model, 'test-model');
  assert.deepEqual(repository.getMessages(conversation.id), [user, assistant]);
});

test('failed assistant insert rolls back user insert and conversation update', (t) => {
  let time = 10;
  const { db, repository } = setup(t, () => time);
  const conversation = repository.createConversation();
  time = 20;
  db.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant'
    BEGIN SELECT RAISE(ABORT, 'test insert failure'); END`);
  assert.throws(() => repository.createTurn(conversation.id, 'must roll back', 'test-model'));
  assert.deepEqual(repository.getMessages(conversation.id), []);
  assert.equal(repository.getConversation(conversation.id)?.updatedAt, 10);
});

test('full history includes failed/cancelled while model history excludes incomplete assistant', (t) => {
  const { repository } = setup(t);
  const conversation = repository.createConversation();
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const turn = repository.createTurn(conversation.id, status, 'test-model');
    repository.finalizeMessage(turn.assistant.id, status, `partial-${status}`);
  }
  repository.createTurn(conversation.id, 'active', 'test-model');
  const all = repository.getMessages(conversation.id);
  assert.equal(all.length, 8);
  assert.deepEqual(all.filter((m) => m.role === 'assistant').map((m) => m.status), ['completed', 'failed', 'cancelled', 'streaming']);
  const context = repository.getCompletedMessages(conversation.id, 20);
  assert.equal(context.length, 5);
  assert.ok(context.every((message) => message.status === 'completed'));
});

test('context selects latest 20 before restoring chronological order and excludes current user before limit', (t) => {
  const { repository } = setup(t);
  const conversation = repository.createConversation();
  for (let index = 0; index < 15; index++) {
    const turn = repository.createTurn(conversation.id, `u${index}`, 'test-model');
    repository.finalizeMessage(turn.assistant.id, 'completed', `a${index}`);
  }
  const current = repository.createTurn(conversation.id, 'current', 'test-model');
  const expected = repository.getMessages(conversation.id)
    .filter((m) => m.status === 'completed' && m.id !== current.user.id).slice(-20);
  const context = repository.getCompletedMessages(conversation.id, 20, current.user.id);
  assert.deepEqual(context, expected);
  assert.equal(context[0]?.content, 'u5');
  assert.equal(context.at(-1)?.content, 'a14');
  assert.equal(context.some((message) => message.id === current.user.id), false);
});

test('conversation isolation and SQL-bound identifiers/content prevent cross reads and SQL injection', (t) => {
  const { repository } = setup(t);
  const first = repository.createConversation();
  const second = repository.createConversation();
  const content = "'; DROP TABLE messages; --";
  repository.createTurn(first.id, content, 'test-model');
  assert.equal(repository.getMessages(first.id)[0]?.content, content);
  assert.deepEqual(repository.getMessages(second.id), []);
  assert.deepEqual(repository.getCompletedMessages(second.id, 20), []);
  assert.equal(repository.getConversation("' OR 1=1 --"), undefined);
  assert.equal(repository.deleteConversation("' OR 1=1 --"), false);
  assert.equal(repository.listConversations().length, 2);
});

test('SQLite enforces foreign keys, role and status constraints', (t) => {
  const { db, repository } = setup(t);
  const message: ChatMessage = {
    id: 'orphan', conversationId: 'missing', role: 'user', content: '', status: 'completed',
    model: null, createdAt: 1, completedAt: 1,
  };
  assert.throws(() => repository.insertMessage(message), /FOREIGN KEY/);
  const conversation = repository.createConversation();
  const insert = db.prepare(`INSERT INTO messages
    (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, '', ?, 1)`);
  assert.throws(() => insert.run('bad-role', conversation.id, 'system', 'completed'), /CHECK/);
  assert.throws(() => insert.run('bad-status', conversation.id, 'user', 'unknown'), /CHECK/);
});

test('delete cascades all states without affecting another conversation', (t) => {
  const { repository } = setup(t);
  const first = repository.createConversation();
  const second = repository.createConversation();
  repository.createTurn(first.id, 'one', 'test-model');
  repository.createTurn(second.id, 'two', 'test-model');
  assert.equal(repository.deleteConversation(first.id), true);
  assert.equal(repository.deleteConversation(first.id), false);
  assert.deepEqual(repository.getMessages(first.id), []);
  assert.equal(repository.getMessages(second.id).length, 2);
});

test('content appends monotonically and a terminal state cannot be overwritten by late close', (t) => {
  const { repository } = setup(t);
  const conversation = repository.createConversation();
  const { assistant } = repository.createTurn(conversation.id, 'test', 'test-model');
  assert.equal(repository.appendMessageContent(assistant.id, 'hello'), true);
  assert.equal(repository.finalizeMessage(assistant.id, 'completed', ' world'), true);
  assert.equal(repository.finalizeMessage(assistant.id, 'cancelled', 'incorrect late data'), false);
  assert.equal(repository.appendMessageContent(assistant.id, 'incorrect extra'), false);
  const message = repository.getMessages(conversation.id)[1];
  assert.equal(message?.content, 'hello world');
  assert.equal(message?.status, 'completed');
  assert.ok(message?.completedAt);
});

test('failed terminal transaction cannot append duplicate tail or indicate completed', (t) => {
  const { db, repository } = setup(t);
  const conversation = repository.createConversation();
  const { assistant } = repository.createTurn(conversation.id, 'test', 'test-model');
  repository.appendMessageContent(assistant.id, 'persisted');
  db.exec(`CREATE TRIGGER reject_completed BEFORE UPDATE ON messages WHEN NEW.status = 'completed'
    BEGIN SELECT RAISE(ABORT, 'test update failure'); END`);
  assert.throws(() => repository.finalizeMessage(assistant.id, 'completed', ' tail'));
  assert.equal(repository.getMessages(conversation.id)[1]?.content, 'persisted');
  assert.equal(repository.getMessages(conversation.id)[1]?.status, 'streaming');
});

test('startup recovery preserves partial content and leaves other terminal states unchanged', (t) => {
  let time = 1;
  const { repository } = setup(t, () => time);
  const conversation = repository.createConversation();
  const streaming = repository.createTurn(conversation.id, 'test', 'test-model');
  repository.appendMessageContent(streaming.assistant.id, 'saved prefix');
  const completed = repository.createTurn(conversation.id, 'test2', 'test-model');
  repository.finalizeMessage(completed.assistant.id, 'completed', 'completed answer');
  time = 100;
  assert.equal(repository.recoverInterruptedMessages(), 1);
  assert.equal(repository.recoverInterruptedMessages(), 0);
  const messages = repository.getMessages(conversation.id);
  assert.equal(messages[1]?.status, 'failed');
  assert.equal(messages[1]?.content, 'saved prefix');
  assert.equal(messages[1]?.completedAt, 100);
  assert.equal(messages[3]?.status, 'completed');
  assert.equal(messages[3]?.content, 'completed answer');
  assert.equal(repository.getConversation(conversation.id)?.updatedAt, 100);
});

test('history limit is validated and a backwards clock never decreases conversation updatedAt', (t) => {
  let time = 100;
  const { repository } = setup(t, () => time);
  const conversation = repository.createConversation();
  time = 50;
  repository.createTurn(conversation.id, 'test', 'test-model');
  assert.equal(repository.getConversation(conversation.id)?.updatedAt, 100);
  assert.deepEqual(repository.getCompletedMessages(conversation.id, 0), []);
  for (const limit of [-1, 1.5, NaN, Infinity]) assert.throws(() => repository.getCompletedMessages(conversation.id, limit), RangeError);
});

test('file database uses WAL, survives independent process restart and recovers interrupted messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-ai-p3-'));
  const path = join(dir, 'nested', 'chat.db');
  let db: ReturnType<typeof openDatabase> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {openDatabase} from './src/database/db.ts';
      import {ChatRepository} from './src/modules/chat/chat.repository.ts';
      const db=openDatabase(process.argv[1]);
      const repo=new ChatRepository(db);
      const c=repo.createConversation();
      const done=repo.createTurn(c.id,'first','test-model');
      repo.finalizeMessage(done.assistant.id,'completed','saved answer');
      const interrupted=repo.createTurn(c.id,'second','test-model');
      repo.appendMessageContent(interrupted.assistant.id,'saved partial');
      console.log(JSON.stringify({id:c.id}));
      db.close();
    `, path], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 10_000 });
    const { id } = JSON.parse(stdout) as { id: string };
    db = openDatabase(path);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    const repo = new ChatRepository(db);
    assert.equal(repo.getMessages(id)[1]?.content, 'saved answer');
    assert.equal(repo.getMessages(id)[3]?.status, 'streaming');
    db.close();
    db = undefined;

    app = buildApp({ databasePath: path });
    const response = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    assert.equal(response.statusCode, 200);
    const result = response.json<{ messages: ChatMessage[] }>();
    assert.equal(result.messages[3]?.content, 'saved partial');
    assert.equal(result.messages[3]?.status, 'failed');
    assert.equal(result.messages[1]?.status, 'completed');
    await app.close();
    app = undefined;
  } finally {
    await app?.close();
    if (db?.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
