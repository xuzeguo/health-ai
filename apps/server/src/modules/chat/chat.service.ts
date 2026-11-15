import { AppError } from '../../common/errors.js';
import type { ChatRepository } from './chat.repository.js';
import type { ModelEvent, ModelProvider } from '../../providers/model-provider.js';
import type { StreamSink } from '../../common/sse.js';
import { SYSTEM_PROMPT } from '../../prompts/system.js';

export interface StreamOptions {
  provider?: ModelProvider;
  model?: string;
  idleTimeoutMs?: number;
  flushIntervalMs?: number;
  flushBytes?: number;
}

interface Turn {
  conversationId: string;
  user: ReturnType<ChatRepository['createTurn']>['user'];
  assistant: ReturnType<ChatRepository['createTurn']>['assistant'];
  controller: AbortController;
  settled: Promise<void>;
  resolve: () => void;
}

// Race even a silent iterator against idle timeout/disconnect. SDK receives the
// same signal; listener removal prevents per-chunk accumulation.
function nextOrTick<T>(next: Promise<T>, ms: number, signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('Generation interrupted')); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    next.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export class ChatService {
  private readonly active = new Map<string, Turn>();
  private stopping = false;
  constructor(private readonly repository: ChatRepository, private readonly options: StreamOptions = {}) {}

  listConversations() {
    return this.repository.listConversations();
  }

  createConversation() {
    return this.repository.createConversation();
  }

  getConversation(id: string) {
    const conversation = this.repository.getConversation(id);
    if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND');
    return { conversation, messages: this.repository.getMessages(id) };
  }

  deleteConversation(id: string): void {
    if (this.active.has(id)) throw new AppError('CONVERSATION_BUSY');
    if (!this.repository.deleteConversation(id)) throw new AppError('CONVERSATION_NOT_FOUND');
  }

  prepareTurn(conversationId: string, content: string): Turn {
    if (this.stopping) throw new AppError('INTERNAL_ERROR');
    if (!this.repository.getConversation(conversationId)) throw new AppError('CONVERSATION_NOT_FOUND');
    if (this.active.has(conversationId)) throw new AppError('CONVERSATION_BUSY');
    if (!this.options.provider) throw new AppError('CONFIG_ERROR');
    // Synchronous through reservation and atomic insert: no await race window.
    const messages = this.repository.createTurn(conversationId, content, this.options.model ?? 'deepseek-flash');
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    const turn = { conversationId, ...messages, controller: new AbortController(), settled, resolve };
    this.active.set(conversationId, turn);
    return turn;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const tasks = [...this.active.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map((task) => task.settled));
  }

  async runTurn(turn: Turn, sink: StreamSink): Promise<void> {
    const { signal } = turn.controller;
    let content = '';
    let persistedLength = 0;
    let finalized = false;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let iterator: AsyncIterator<ModelEvent> | undefined;
    const armTimeout = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; turn.controller.abort(); }, this.options.idleTimeoutMs ?? 60_000);
    };
    const flush = async () => {
      signal.throwIfAborted();
      const delta = content.slice(persistedLength);
      if (!delta) return;
      // Do not publish text the database has not committed.
      try {
        if (!this.repository.appendMessageContent(turn.assistant.id, delta)) throw new Error('Message not writable');
      } catch { throw new AppError('INTERNAL_ERROR'); }
      persistedLength = content.length;
      await sink.send({ event: 'content_delta', data: { delta } }, signal);
    };
    try {
      let history: ReturnType<ChatRepository['getCompletedMessages']>;
      try { history = this.repository.getCompletedMessages(turn.conversationId, 20, turn.user.id); }
      catch { throw new AppError('INTERNAL_ERROR'); }
      armTimeout();
      await sink.send({ event: 'message_start', data: { messageId: turn.assistant.id } }, signal);
      const stream = this.options.provider!.chatStream({
        model: turn.assistant.model!, signal,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.map(({ role, content }) => ({ role, content })),
          { role: 'user', content: turn.user.content },
        ],
      });
      iterator = stream[Symbol.asyncIterator]();
      let next = iterator.next();
      let lastFlush = Date.now();
      let done = false;
      while (!done) {
        const remaining = content.length === persistedLength ? (this.options.idleTimeoutMs ?? 60_000)
          : Math.max(1, (this.options.flushIntervalMs ?? 75) - (Date.now() - lastFlush));
        const result = await nextOrTick(next, remaining, signal);
        signal.throwIfAborted();
        if (result) {
          if (result.done) throw new AppError('UPSTREAM_ERROR');
          const event = result.value;
          if (event.type === 'content' && event.delta) { content += event.delta; armTimeout(); }
          if (event.type === 'done') {
            if (!content || event.fullContent !== content) throw new AppError('UPSTREAM_ERROR');
            done = true;
          }
        }
        if (done || Date.now() - lastFlush >= (this.options.flushIntervalMs ?? 75)
          || Buffer.byteLength(content.slice(persistedLength)) >= (this.options.flushBytes ?? 1024)) {
          await flush();
          lastFlush = Date.now();
        }
        // Keep at most one upstream read in flight, including during a timer tick.
        if (result && !done) next = iterator.next();
      }
      signal.throwIfAborted();
      try {
        if (!this.repository.finalizeMessage(turn.assistant.id, 'completed')) throw new Error('Message not writable');
      } catch { throw new AppError('INTERNAL_ERROR'); }
      finalized = true;
      clearTimeout(idleTimer);
      await sink.send({ event: 'message_complete', data: { messageId: turn.assistant.id } });
    } catch (error) {
      clearTimeout(idleTimer);
      if (!finalized) {
        let normalized = timedOut ? new AppError('UPSTREAM_TIMEOUT')
          : error instanceof AppError ? error : new AppError('UPSTREAM_ERROR');
        const cancelled = signal.aborted && !timedOut;
        // Stop transport before DB recovery / a potentially slow error frame.
        // Classify first so our own abort never turns a fault into cancelled.
        turn.controller.abort();
        try {
          if (!this.repository.finalizeMessage(turn.assistant.id, cancelled ? 'cancelled' : 'failed', content.slice(persistedLength))) {
            throw new AppError('INTERNAL_ERROR');
          }
        } catch {
          normalized = new AppError('INTERNAL_ERROR');
          console.error(JSON.stringify({ code: normalized.code, messageId: turn.assistant.id }));
        }
        const frame = cancelled && normalized.code !== 'INTERNAL_ERROR'
          ? { event: 'message_cancelled' as const, data: { messageId: turn.assistant.id } }
          : { event: 'message_error' as const, data: { code: normalized.code, message: normalized.message } };
        try { await sink.send(frame); } catch { /* Connection is gone; DB remains authoritative. */ }
      }
    } finally {
      clearTimeout(idleTimer);
      turn.controller.abort();
      // A non-cooperative transport must not retain the conversation lock.
      try { if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {}); }
      catch { /* Transport cleanup cannot prevent lock/settled cleanup. */ }
      if (this.active.get(turn.conversationId) === turn) this.active.delete(turn.conversationId);
      turn.resolve();
    }
  }
}
