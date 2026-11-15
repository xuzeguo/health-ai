import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia } from 'pinia';
import type { ChatMessage, ChatStreamEvent, Conversation } from '@health-ai/shared';
import { ChatApiError, type ChatApi } from '../src/api/chat.js';
import { createChatController } from '../src/composables/useChat.js';
import { useChatStore } from '../src/stores/chat.js';

const conversation = (id: string, updatedAt = 1): Conversation => ({ id, title: '新对话', createdAt: 1, updatedAt });
const history = (id: string, content = id, status: ChatMessage['status'] = 'completed'): ChatMessage[] => [{
  id: `${id}-a`, conversationId: id, role: 'assistant', content, status, model: null, createdAt: 1, completedAt: 1,
}];
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(overrides: Partial<ChatApi> = {}) {
  const store = useChatStore(createPinia());
  store.currentConversationId = 'current';
  store.messages = history('current');
  store.conversations = [conversation('current'), conversation('other')];
  const api: ChatApi = {
    async listConversations() { return [conversation('current'), conversation('other')]; },
    async createConversation() { return conversation('new', 3); },
    async getConversation(id) { return { conversation: conversation(id), messages: history(id) }; },
    async deleteConversation() {}, async stream() {}, ...overrides,
  };
  const notices: string[] = [];
  const chat = createChatController(store, api, (notice) => notices.push(notice));
  return { store, chat, notices };
}

test('deleting current conversation selects next, deleting last clears view without creating a replacement POST', async () => {
  const deleted: string[] = [];
  const { store, chat } = setup({
    async deleteConversation(id) { deleted.push(id); },
    async createConversation() { throw new Error('delete must not create'); },
  });
  await chat.deleteConversation('current');
  assert.equal(store.currentConversationId, 'other');
  assert.deepEqual(store.messages, history('other'));
  assert.deepEqual(store.conversations.map((item) => item.id), ['other']);
  await chat.deleteConversation('other');
  assert.equal(store.currentConversationId, null);
  assert.deepEqual(store.messages, []);
  assert.deepEqual(store.conversations, []);
  assert.deepEqual(deleted, ['current', 'other']);
  assert.equal(store.loading, false);
});

test('remote busy delete preserves selection/history/list; double delete is guarded during the request', async () => {
  const pending = gate();
  let calls = 0;
  const { store, chat, notices } = setup({ async deleteConversation() {
    calls++;
    await pending.promise;
    throw new ChatApiError('CONVERSATION_BUSY', true);
  } });
  const deleting = chat.deleteConversation('current');
  await chat.deleteConversation('current');
  assert.equal(calls, 1);
  pending.resolve();
  await deleting;
  assert.equal(store.currentConversationId, 'current');
  assert.deepEqual(store.messages, history('current'));
  assert.equal(store.conversations.length, 2);
  assert.deepEqual(notices, ['当前会话正在生成回答']);
});

test('delete succeeds even when replacement GET fails; removed history is never shown as still selected', async () => {
  const { store, chat } = setup({ async getConversation() { throw new Error('offline'); } });
  await chat.deleteConversation('current');
  assert.equal(store.currentConversationId, null);
  assert.deepEqual(store.messages, []);
  assert.deepEqual(store.conversations.map((item) => item.id), ['other']);
  assert.ok(store.error);
});

test('switch waits for aborted stream reconciliation; late old deltas/errors cannot affect next conversation', async () => {
  const ready = gate();
  const reconciled = gate();
  const releaseReconcile = gate();
  let oldEmit!: (frame: ChatStreamEvent) => void;
  const gets: string[] = [];
  const { store, chat, notices } = setup({
    async stream(_input, signal, emit) {
      oldEmit = emit;
      emit({ event: 'message_start', data: { messageId: 'real-a' } });
      emit({ event: 'content_delta', data: { delta: 'partial' } });
      ready.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    async getConversation(id) {
      gets.push(id);
      if (id === 'current') { reconciled.resolve(); await releaseReconcile.promise; }
      return { conversation: conversation(id), messages: history(id, id, id === 'current' ? 'cancelled' : 'completed') };
    },
  });
  const sending = chat.sendMessage('hi');
  await ready.promise;
  const switching = chat.switchConversation('other');
  await reconciled.promise;
  oldEmit({ event: 'content_delta', data: { delta: 'must-ignore-during-abort' } });
  assert.equal(store.messages.at(-1)?.content, 'partial');
  assert.deepEqual(gets, ['current']);
  assert.equal(store.currentConversationId, 'current');
  releaseReconcile.resolve();
  await switching;
  await sending;
  oldEmit({ event: 'content_delta', data: { delta: 'must-ignore-after-switch' } });
  oldEmit({ event: 'message_error', data: { code: 'UPSTREAM_ERROR', message: 'ignored' } });
  assert.deepEqual(gets, ['current', 'other']);
  assert.equal(store.currentConversationId, 'other');
  assert.deepEqual(store.messages, history('other'));
  assert.deepEqual(notices, []);
  assert.equal(store.generating, false);
  assert.equal(store.loading, false);
});

test('new conversation waits for old stream cancellation and keeps the generated conversation first', async () => {
  const ready = gate();
  let aborted = false;
  const { store, chat } = setup({
    async stream(_input, signal, emit) {
      emit({ event: 'message_start', data: { messageId: 'real-a' } });
      ready.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')); }, { once: true }));
    },
    async createConversation() { assert.equal(aborted, true); return conversation('new', 4); },
  });
  const sending = chat.sendMessage('hi');
  await ready.promise;
  await chat.createConversation();
  await sending;
  assert.equal(store.currentConversationId, 'new');
  assert.equal(store.conversations[0]?.id, 'new');
  assert.deepEqual(store.messages, []);
});

test('inactive delete does not cancel active stream; active delete is rejected and completed conversation moves to top', async () => {
  const ready = gate();
  const finish = gate();
  let signal: AbortSignal | undefined;
  const deleted: string[] = [];
  const { store, chat } = setup({
    async stream(_input, currentSignal, emit) {
      signal = currentSignal;
      emit({ event: 'message_start', data: { messageId: 'real-a' } });
      ready.resolve();
      await finish.promise;
      emit({ event: 'message_complete', data: { messageId: 'real-a' } });
    },
    async deleteConversation(id) { deleted.push(id); },
    async getConversation(id) { return { conversation: conversation(id, 10), messages: history(id) }; },
  });
  store.conversations = [conversation('other', 2), conversation('third', 2), conversation('current')];
  const sending = chat.sendMessage('hi');
  await ready.promise;
  await chat.switchConversation('current'); // Selecting current row must not stop it.
  await chat.deleteConversation('current');
  await chat.deleteConversation('other');
  assert.deepEqual(deleted, ['other']);
  assert.equal(signal?.aborted, false);
  assert.equal(store.currentConversationId, 'current');
  finish.resolve();
  await sending;
  assert.deepEqual(store.conversations.map((item) => item.id), ['current', 'third']);
});

test('pending history GET blocks conflicting operations and a failed selection preserves current content', async () => {
  const pending = gate();
  let gets = 0;
  const { store, chat } = setup({ async getConversation() { gets++; await pending.promise; throw new Error('offline'); } });
  const switching = chat.switchConversation('other');
  await chat.switchConversation('another');
  await chat.createConversation();
  await chat.sendMessage('must not send');
  assert.equal(gets, 1);
  pending.resolve();
  await switching;
  assert.equal(store.currentConversationId, 'current');
  assert.deepEqual(store.messages, history('current'));
  assert.equal(store.loading, false);
  assert.equal(store.generating, false);
});
