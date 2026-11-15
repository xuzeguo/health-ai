import type { ChatMessage } from '@health-ai/shared';
import { ChatApiError, createChatApi, type ChatApi } from '../api/chat.js';
import { useChatStore } from '../stores/chat.js';

type Store = ReturnType<typeof useChatStore>;
interface Task {
  conversationId: string;
  controller: AbortController;
  userId: string;
  assistantId: string;
  started: boolean;
  settled: Promise<void>;
}

// Exported factory keeps transport/state tests independent of browser UI APIs.
export function createChatController(store: Store, api: ChatApi, notify: (message: string) => void = () => {}) {
  let active: Task | undefined;
  let viewVersion = 0;
  const report = (error: unknown) => {
    const message = error instanceof ChatApiError ? error.message : '网络或服务异常，请检查后重试';
    store.error = message;
    notify(message);
  };
  const owns = (task: Task) => active === task && store.currentConversationId === task.conversationId;
  function stopGeneration(): void {
    if (!active) return;
    const assistant = store.messages.find((message) => message.id === active!.assistantId);
    if (owns(active) && assistant?.status === 'streaming') {
      assistant.status = 'cancelled';
      assistant.completedAt = Date.now();
    }
    active.controller.abort();
  }
  async function reconcile(task: Task) {
    // Abort closes the connection before server finalization is necessarily
    // visible. Only GET is polled, never repeat the generation POST.
    for (let attempt = 0; attempt < 20; attempt++) {
      const detail = await api.getConversation(task.conversationId);
      if (!owns(task)) return;
      const pending = detail.messages.some((message) => message.role === 'assistant' && message.status === 'streaming');
      if (pending) {
        if (attempt < 19) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
        store.error = '服务仍在收尾，已保留本地内容，请稍后刷新确认';
        return;
      }
      store.messages = detail.messages;
      const index = store.conversations.findIndex((item) => item.id === detail.conversation.id);
      if (index >= 0) store.conversations[index] = detail.conversation;
      else store.conversations.unshift(detail.conversation);
      store.conversations.sort((left, right) => right.updatedAt - left.updatedAt);
      return;
    }
  }
  async function execute(task: Task, content: string) {
    let rejected = false;
    try {
      await api.stream({ conversationId: task.conversationId, message: content }, task.controller.signal, (frame) => {
        if (!owns(task) || task.controller.signal.aborted) return;
        const assistant = store.messages.find((message) => message.id === task.assistantId);
        if (!assistant) return;
        if (frame.event === 'message_start') {
          task.started = true;
          assistant.id = frame.data.messageId;
          task.assistantId = frame.data.messageId;
        }
        if (frame.event === 'content_delta') assistant.content += frame.data.delta;
        if (frame.event === 'message_complete') assistant.status = 'completed';
        if (frame.event === 'message_cancelled') assistant.status = 'cancelled';
        if (frame.event === 'message_error') {
          assistant.status = 'failed';
          report(new ChatApiError(frame.data.code));
        }
      });
    } catch (error) {
      rejected = !task.started && error instanceof ChatApiError && error.httpRejected;
      if (owns(task)) {
        if (rejected) store.messages = store.messages.filter((message) => message.id !== task.userId && message.id !== task.assistantId);
        else {
          const assistant = store.messages.find((message) => message.id === task.assistantId);
          if (assistant?.status === 'streaming') assistant.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
        }
        if (!task.controller.signal.aborted) report(error);
      }
    } finally {
      if (!rejected && owns(task)) {
        try { await reconcile(task); } catch {
          if (owns(task)) { store.error = '暂时无法核对服务端历史，已保留本地内容，请稍后刷新确认'; notify(store.error); }
        }
      }
      if (active === task) { active = undefined; store.generating = false; }
    }
  }
  async function sendMessage(raw: string): Promise<void> {
    const content = raw.trim();
    if (store.loading || store.generating) return;
    if (!content || content.length > 8000) { report(new ChatApiError('INVALID_PARAM')); return; }
    if (!store.currentConversationId) await createConversation();
    if (!store.currentConversationId || store.generating || store.loading) return;
    store.error = null;
    store.generating = true;
    const conversationId = store.currentConversationId;
    const time = Date.now();
    const optimistic = (role: 'user' | 'assistant'): ChatMessage => ({
      id: `local-${crypto.randomUUID()}`, conversationId, role,
      content: role === 'user' ? content : '', status: role === 'user' ? 'completed' : 'streaming',
      model: null, createdAt: time, completedAt: role === 'user' ? time : null,
    });
    const user = optimistic('user');
    const assistant = optimistic('assistant');
    store.messages.push(user, assistant);
    const task: Task = { conversationId, controller: new AbortController(), userId: user.id,
      assistantId: assistant.id, started: false, settled: Promise.resolve() };
    active = task;
    task.settled = execute(task, content);
    await task.settled;
  }
  async function loadConversations(): Promise<void> {
    if (store.loading || store.generating) return;
    store.loading = true;
    store.error = null;
    try { store.conversations = await api.listConversations(); }
    catch (error) { report(error); }
    finally { store.loading = false; }
  }
  async function createConversation(): Promise<void> {
    if (store.loading) return;
    store.loading = true;
    const version = ++viewVersion;
    try {
      if (active) { stopGeneration(); await active.settled; }
      const conversation = await api.createConversation();
      if (version !== viewVersion) return;
      store.conversations.unshift(conversation);
      store.currentConversationId = conversation.id;
      store.messages = [];
      store.error = null;
    } catch (error) { report(error); }
    finally { if (version === viewVersion) store.loading = false; }
  }
  async function switchConversation(id: string): Promise<void> {
    if (store.loading || !id || id === store.currentConversationId) return;
    store.loading = true;
    const version = ++viewVersion;
    try {
      if (active) { stopGeneration(); await active.settled; }
      const detail = await api.getConversation(id);
      if (version !== viewVersion) return;
      store.currentConversationId = id;
      store.messages = detail.messages;
      store.error = null;
    } catch (error) { report(error); }
    finally { if (version === viewVersion) store.loading = false; }
  }
  async function deleteConversation(id: string): Promise<void> {
    if (store.loading || !id) return;
    if (active?.conversationId === id) { report(new ChatApiError('CONVERSATION_BUSY')); return; }
    store.loading = true;
    const version = ++viewVersion;
    try {
      await api.deleteConversation(id);
      if (version !== viewVersion) return;
      store.conversations = store.conversations.filter((conversation) => conversation.id !== id);
      store.error = null;
      if (store.currentConversationId === id) {
        store.currentConversationId = null;
        store.messages = [];
        const next = store.conversations[0];
        if (next) {
          const detail = await api.getConversation(next.id);
          if (version !== viewVersion) return;
          store.currentConversationId = next.id;
          store.messages = detail.messages;
        }
      }
    } catch (error) { report(error); }
    finally { if (version === viewVersion) store.loading = false; }
  }
  return { sendMessage, stopGeneration, createConversation, switchConversation, loadConversations, deleteConversation };
}

const controllers = new WeakMap<Store, ReturnType<typeof createChatController>>();
export function useChat(notify?: (message: string) => void) {
  const store = useChatStore();
  let controller = controllers.get(store);
  if (!controller) { controller = createChatController(store, createChatApi(), notify); controllers.set(store, controller); }
  return controller;
}
