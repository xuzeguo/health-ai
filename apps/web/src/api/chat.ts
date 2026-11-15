import { ERROR_CODES, ERROR_DEFINITIONS, type ChatMessage, type ChatStreamEvent,
  type ChatStreamRequest, type Conversation, type ErrorCode } from '@health-ai/shared';
import { createSseParser } from '../composables/useSseParser.js';

export class ChatApiError extends Error {
  constructor(readonly code: ErrorCode, readonly httpRejected = false) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = 'ChatApiError';
  }
}

function isCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.some((code) => code === value);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeEvent(event: string, raw: string): ChatStreamEvent | undefined {
  if (!['message_start', 'content_delta', 'message_complete', 'message_error', 'message_cancelled'].includes(event)) return;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new ChatApiError('UPSTREAM_ERROR'); }
  if (!object(data)) throw new ChatApiError('UPSTREAM_ERROR');
  if (event === 'content_delta' && typeof data.delta === 'string') return { event, data: { delta: data.delta } };
  if (event === 'message_error' && isCode(data.code)) {
    return { event, data: { code: data.code, message: ERROR_DEFINITIONS[data.code].message } };
  }
  if ((event === 'message_start' || event === 'message_complete' || event === 'message_cancelled')
    && typeof data.messageId === 'string' && data.messageId) return { event, data: { messageId: data.messageId } };
  throw new ChatApiError('UPSTREAM_ERROR');
}

export function createChatApi(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetcher(path, init);
    if (!response.ok) {
      let code: ErrorCode = 'INTERNAL_ERROR';
      try {
        const body: unknown = await response.json();
        if (object(body) && isCode(body.code)) code = body.code;
      } catch { /* Do not display raw proxy/HTML errors. */ }
      throw new ChatApiError(code, true);
    }
    return response;
  }
  return {
    async listConversations(): Promise<Conversation[]> {
      return (await (await request('/api/conversations')).json() as { conversations: Conversation[] }).conversations;
    },
    async createConversation(): Promise<Conversation> {
      return (await (await request('/api/conversations', { method: 'POST' })).json() as { conversation: Conversation }).conversation;
    },
    async getConversation(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
      return (await request(`/api/conversations/${encodeURIComponent(id)}`)).json();
    },
    async deleteConversation(id: string): Promise<void> {
      await request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async stream(input: ChatStreamRequest, signal: AbortSignal, onEvent: (frame: ChatStreamEvent) => void): Promise<void> {
      const response = await request('/api/chat/stream', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(input),
      });
      if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new ChatApiError('UPSTREAM_ERROR');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let messageId: string | undefined;
      let terminal = false;
      const parser = createSseParser({ onEvent(event, data) {
        if (terminal) return;
        const frame = decodeEvent(event, data);
        if (!frame) return;
        if (frame.event === 'message_start') {
          if (messageId) throw new ChatApiError('UPSTREAM_ERROR');
          messageId = frame.data.messageId;
        } else if (frame.event !== 'message_error') {
          if (!messageId || ('messageId' in frame.data && frame.data.messageId !== messageId)) throw new ChatApiError('UPSTREAM_ERROR');
        }
        if (frame.event === 'message_complete' || frame.event === 'message_cancelled' || frame.event === 'message_error') terminal = true;
        onEvent(frame);
      } });
      try {
        while (!terminal) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) { parser.feed(decoder.decode()); break; }
          parser.feed(decoder.decode(chunk.value, { stream: true }));
        }
        if (!terminal) throw new ChatApiError('UPSTREAM_ERROR');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;
