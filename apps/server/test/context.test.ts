import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ChatMessage } from '@health-ai/shared';
import { openDatabase } from '../src/database/db.js';
import { ChatRepository } from '../src/modules/chat/chat.repository.js';
import { ChatService } from '../src/modules/chat/chat.service.js';
import { SYSTEM_PROMPT } from '../src/prompts/system.js';
import type { ChatInput, ModelProvider } from '../src/providers/model-provider.js';

test('provider receives latest 20 completed messages in stable order, excluding current user before limit', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const repo = new ChatRepository(db, () => 100);
  const id = repo.createConversation().id;
  const other = repo.createConversation().id;
  const completed: ChatMessage[] = [];
  for (let i = 0; i < 25; i++) {
    const item: ChatMessage = { id: randomUUID(), conversationId: id, role: i % 2 ? 'assistant' : 'user',
      content: `history-${i}`, status: 'completed', model: null, createdAt: 100, completedAt: 100 };
    repo.insertMessage(item);
    completed.push(item);
  }
  for (const status of ['pending', 'streaming', 'failed', 'cancelled'] as const) {
    repo.insertMessage({ id: randomUUID(), conversationId: id, role: 'assistant', content: `excluded-${status}`,
      status, model: null, createdAt: 100, completedAt: null });
  }
  repo.createTurn(other, 'excluded-other-conversation', 'test');
  let captured: ChatInput | undefined;
  const provider: ModelProvider = { name: 'context-test', async *chatStream(input) {
    captured = input;
    yield { type: 'content', delta: 'answer' };
    yield { type: 'done', fullContent: 'answer' };
  } };
  const service = new ChatService(repo, { provider, model: 'configured-model' });
  await service.runTurn(service.prepareTurn(id, 'current-only-once'), { async send() {} });
  assert.ok(captured);
  assert.equal(captured.model, 'configured-model');
  assert.deepEqual(captured.messages, [
    { role: 'system', content: SYSTEM_PROMPT },
    ...completed.slice(-20).map(({ role, content }) => ({ role, content })),
    { role: 'user', content: 'current-only-once' },
  ]);
  assert.equal(captured.messages.filter((message) => message.content === 'current-only-once').length, 1);
});

test('five sequential turns use persisted replies exactly once and never carry history across conversations', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const repo = new ChatRepository(db, () => 1);
  const id = repo.createConversation().id;
  const other = repo.createConversation().id;
  const seen: ChatInput['messages'][] = [];
  const provider: ModelProvider = { name: 'context-test', async *chatStream(input) {
    seen.push(input.messages);
    const answer = `answer-${seen.length}`;
    yield { type: 'content', delta: answer };
    yield { type: 'done', fullContent: answer };
  } };
  const service = new ChatService(repo, { provider });
  for (let turn = 1; turn <= 5; turn++) {
    await service.runTurn(service.prepareTurn(id, `question-${turn}`), { async send() {} });
    assert.equal(seen[turn - 1]?.length, 2 * turn);
    assert.deepEqual(seen[turn - 1]?.slice(1), [
      ...Array.from({ length: turn - 1 }, (_, i) => [
        { role: 'user', content: `question-${i + 1}` }, { role: 'assistant', content: `answer-${i + 1}` },
      ]).flat(),
      { role: 'user', content: `question-${turn}` },
    ]);
  }
  await service.runTurn(service.prepareTurn(other, 'isolated'), { async send() {} });
  assert.deepEqual(seen[5], [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'isolated' }]);
});
