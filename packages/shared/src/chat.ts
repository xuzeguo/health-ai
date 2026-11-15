export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  model: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface ChatStreamRequest {
  conversationId: string;
  message: string;
}

export type ModelEvent =
  | { type: 'content'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'done'; fullContent: string };

export type ChatStreamEvent =
  | { event: 'message_start'; data: { messageId: string } }
  | { event: 'content_delta'; data: { delta: string } }
  | { event: 'message_complete'; data: { messageId: string } }
  | { event: 'message_error'; data: { code: import('./errors.js').ErrorCode; message: string } }
  | { event: 'message_cancelled'; data: { messageId: string } };
