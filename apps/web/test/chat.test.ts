import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia } from 'pinia';
import type { ChatMessage, ChatStreamEvent, Conversation } from '@health-ai/shared';
import { ChatApiError, createChatApi, type ChatApi } from '../src/api/chat.js';
import { createChatController } from '../src/composables/useChat.js';
import { createSseParser } from '../src/composables/useSseParser.js';
import { useChatStore } from '../src/stores/chat.js';

function frame(event: string, data: unknown) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
function streamResponse(text: string, chunkSize = 1, onCancel?: () => void) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
    cancel() { onCancel?.(); },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('parser handles every split across CRLF, comments, multiple frames and multiple data lines', () => {
  const source = ': ping\r\n\r\nevent: custom\r\ndata: 你好🙂\r\ndata: line2\r\n\r\ndata: fallback\n\n';
  for (let split = 0; split <= source.length; split++) {
    const events: string[][] = [];
    const parser = createSseParser({ onEvent: (event, data) => { events.push([event, data]); } });
    parser.feed(source.slice(0, split));
    parser.feed(source.slice(split));
    assert.deepEqual(events, [['custom', '你好🙂\nline2'], ['message', 'fallback']]);
  }
  let count = 0;
  const parser = createSseParser({ onEvent: () => { count++; } });
  parser.feed('event: unfinished\ndata: never-dispatched');
  assert.equal(count, 0);
  assert.throws(() => parser.feed('x'.repeat(1024 * 1024)), /too large/);
});

test('API decodes UTF8 one byte at a time and cancels reader at terminal before remote EOF', async () => {
  let cancelled = false;
  let calls = 0;
  const text = frame('message_start', { messageId: 'a' }) + ': ping\n\n'
    + frame('content_delta', { delta: '你好🙂\n逐字' }) + frame('message_complete', { messageId: 'a' })
    + 'never read this trailing content'.repeat(20);
  const api = createChatApi(async (path, options) => {
    calls++;
    assert.equal(path, '/api/chat/stream');
    assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(options?.body)), { conversationId: 'c', message: 'hi' });
    return streamResponse(text, 1, () => { cancelled = true; });
  });
  const frames: ChatStreamEvent[] = [];
  await api.stream({ conversationId: 'c', message: 'hi' }, new AbortController().signal, (event) => { frames.push(event); });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(frames.map((event) => event.event), ['message_start', 'content_delta', 'message_complete']);
  assert.deepEqual(frames[1], { event: 'content_delta', data: { delta: '你好🙂\n逐字' } });
});

test('API refuses EOF without terminal, bad JSON, wrong identity/order and unexpected content type', async () => {
  for (const text of [
    frame('message_start', { messageId: 'a' }) + frame('content_delta', { delta: 'partial' }),
    'event: message_start\ndata: {broken}\n\n',
    frame('content_delta', { delta: 'before start' }),
    frame('message_start', { messageId: 'a' }) + frame('message_complete', { messageId: 'b' }),
    frame('message_start', { messageId: 'a' }) + frame('message_start', { messageId: 'a' }),
  ]) {
    const api = createChatApi(async () => streamResponse(text, 1024));
    await assert.rejects(api.stream({ conversationId: 'c', message: 'hi' }, new AbortController().signal, () => {}), { code: 'UPSTREAM_ERROR' });
  }
  const api = createChatApi(async () => new Response('<html>proxy error</html>'));
  await assert.rejects(api.stream({ conversationId: 'c', message: 'hi' }, new AbortController().signal, () => {}), { code: 'UPSTREAM_ERROR' });
});

test('API maps JSON/SSE errors to local safe messages; never retries rejected POST', async () => {
  for (const code of ['CONVERSATION_BUSY', 'UPSTREAM_TIMEOUT'] as const) {
    let calls = 0;
    const api = createChatApi(async () => {
      calls++;
      return code === 'CONVERSATION_BUSY'
        ? Response.json({ code, message: 'private upstream info' }, { status: 409 })
        : streamResponse(frame('message_error', { code, message: 'private upstream info' }));
    });
    const frames: ChatStreamEvent[] = [];
    if (code === 'CONVERSATION_BUSY') {
      await assert.rejects(api.stream({ conversationId: 'c', message: 'hi' }, new AbortController().signal, () => {}),
        { code, httpRejected: true, message: '当前会话正在生成回答' });
    } else {
      await api.stream({ conversationId: 'c', message: 'hi' }, new AbortController().signal, (event) => { frames.push(event); });
      assert.deepEqual(frames, [{ event: 'message_error', data: { code, message: '生成超时，请重试' } }]);
    }
    assert.equal(calls, 1);
  }
});

const conversation = (id: string): Conversation => ({ id, title: '新对话', createdAt: 1, updatedAt: 2 });
const message = (id: string, content: string, status: ChatMessage['status'] = 'completed'): ChatMessage => ({
  id, conversationId: 'c', role: id === 'u' ? 'user' : 'assistant', content, status,
  model: null, createdAt: 1, completedAt: status === 'streaming' ? null : 2,
});
function setup(overrides: Partial<ChatApi> = {}) {
  const store = useChatStore(createPinia());
  store.currentConversationId = 'c';
  store.conversations = [conversation('c'), conversation('other')];
  const api: ChatApi = {
    async listConversations() { return [conversation('c')]; },
    async createConversation() { return conversation('new'); },
    async getConversation(id) { return { conversation: conversation(id), messages: [] }; },
    async deleteConversation() {},
    async stream() {},
    ...overrides,
  };
  const notices: string[] = [];
  const chat = createChatController(store, api, (notice) => notices.push(notice));
  return { store, api, chat, notices };
}

test('controller inserts optimistic messages, binds real assistant ID and reconciles authoritative user/status/times', async () => {
  const { store, chat } = setup({
    async stream(input, _signal, emit) {
      assert.equal(store.generating, true);
      assert.equal(input.message, '你好');
      assert.equal(store.messages.length, 2);
      assert.match(store.messages[0]!.id, /^local-/);
      emit({ event: 'message_start', data: { messageId: 'a' } });
      emit({ event: 'content_delta', data: { delta: '你好🙂' } });
      assert.equal(store.messages.find((item) => item.id === 'a')?.content, '你好🙂');
      emit({ event: 'message_complete', data: { messageId: 'a' } });
    },
    async getConversation() { return { conversation: conversation('c'), messages: [message('u', '你好'), message('a', '你好🙂')] }; },
  });
  await chat.sendMessage(' 你好 ');
  assert.deepEqual(store.messages.map((item) => item.id), ['u', 'a']);
  assert.equal(store.messages[1]?.completedAt, 2);
  assert.equal(store.generating, false);
  assert.equal(store.error, null);
});

test('HTTP 400/404/409 rollback temporary messages and preserve existing history', async () => {
  for (const code of ['INVALID_PARAM', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_BUSY'] as const) {
    let gets = 0;
    const { store, chat, notices } = setup({
      async stream() { throw new ChatApiError(code, true); },
      async getConversation() { gets++; throw new Error('should not reconcile rejected turn'); },
    });
    store.messages = [message('existing', 'history')];
    await chat.sendMessage('hi');
    assert.deepEqual(store.messages.map((item) => item.id), ['existing']);
    assert.equal(gets, 0);
    assert.equal(notices.length, 1);
    assert.equal(store.generating, false);
  }
});

test('ambiguous network loss before start reconciles without retry or duplicate optimistic messages', async () => {
  let calls = 0;
  let gets = 0;
  const { store, chat } = setup({
    async stream() { calls++; throw new Error('network lost after server accepted'); },
    async getConversation() { gets++; return { conversation: conversation('c'), messages: [message('u', 'hi'), message('a', 'partial', 'failed')] }; },
  });
  await chat.sendMessage('hi');
  assert.equal(calls, 1);
  assert.equal(gets, 1);
  assert.deepEqual(store.messages.map((item) => item.id), ['u', 'a']);
  assert.equal(store.messages[1]?.content, 'partial');
});

test('stop is immediate locally, preserves partial text and waits for server finalization before switching', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  const { store, chat } = setup({
    async stream(_input, signal, emit) {
      emit({ event: 'message_start', data: { messageId: 'a' } });
      emit({ event: 'content_delta', data: { delta: 'partial' } });
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('abort')); }, { once: true }));
    },
    async getConversation(id) {
      if (id === 'other') assert.equal(cancelled, true);
      return { conversation: conversation(id), messages: id === 'c' ? [message('u', 'hi'), message('a', 'partial', 'cancelled')] : [] };
    },
  });
  const sending = chat.sendMessage('hi');
  await ready;
  chat.stopGeneration();
  assert.equal(store.messages[1]?.status, 'cancelled');
  assert.equal(store.messages[1]?.content, 'partial');
  await chat.switchConversation('other');
  await sending;
  assert.equal(store.currentConversationId, 'other');
  assert.deepEqual(store.messages, []);
  assert.equal(store.generating, false);
});

test('double send is guarded; stream errors and failed reconciliation preserve rendered partial content', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { store, chat } = setup({
    async stream(_input, _signal, emit) {
      calls++;
      emit({ event: 'message_start', data: { messageId: 'a' } });
      emit({ event: 'content_delta', data: { delta: 'partial' } });
      await gate;
      emit({ event: 'message_error', data: { code: 'UPSTREAM_ERROR', message: '模型服务异常，请稍后重试' } });
    },
    async getConversation() { throw new Error('offline'); },
  });
  const running = chat.sendMessage('hi');
  await chat.sendMessage('double');
  assert.equal(calls, 1);
  release();
  await running;
  assert.equal(store.messages[1]?.content, 'partial');
  assert.equal(store.messages[1]?.status, 'failed');
  assert.equal(store.generating, false);
  assert.match(store.error ?? '', /保留本地内容/);
});
