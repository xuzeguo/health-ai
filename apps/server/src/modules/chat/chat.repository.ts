import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatMessage, Conversation, MessageStatus } from '@health-ai/shared';

type TerminalStatus = Extract<MessageStatus, 'completed' | 'failed' | 'cancelled'>;
const conversationColumns = 'id, title, created_at AS createdAt, updated_at AS updatedAt';
const messageColumns = `id, conversation_id AS conversationId, role, content, status, model,
  created_at AS createdAt, completed_at AS completedAt`;

export class ChatRepository {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  createConversation(): Conversation {
    const time = this.now();
    const conversation = { id: randomUUID(), title: '新对话', createdAt: time, updatedAt: time };
    this.db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(conversation.id, conversation.title, time, time);
    return conversation;
  }

  listConversations(): Conversation[] {
    return this.db.prepare<[], Conversation>(`SELECT ${conversationColumns} FROM conversations ORDER BY updated_at DESC, rowid DESC`).all();
  }

  getConversation(id: string): Conversation | undefined {
    return this.db.prepare<[string], Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id = ?`).get(id);
  }

  deleteConversation(id: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes === 1;
  }

  getMessages(conversationId: string): ChatMessage[] {
    return this.db.prepare<[string], ChatMessage>(`SELECT ${messageColumns} FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`).all(conversationId);
  }

  getCompletedMessages(conversationId: string, limit: number, excludeMessageId?: string): ChatMessage[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid history limit');
    return this.db.prepare<[string, string | null, string | null, number], ChatMessage>(`
      SELECT ${messageColumns} FROM (
        SELECT rowid AS insertion_order, * FROM messages
        WHERE conversation_id = ? AND status = 'completed' AND (? IS NULL OR id != ?)
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, insertion_order ASC
    `).all(conversationId, excludeMessageId ?? null, excludeMessageId ?? null, limit);
  }

  insertMessage(message: ChatMessage): void {
    this.db.prepare(`INSERT INTO messages
      (id, conversation_id, role, content, status, model, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.conversationId, message.role, message.content,
        message.status, message.model, message.createdAt, message.completedAt);
  }

  createTurn(conversationId: string, content: string, model: string): { user: ChatMessage; assistant: ChatMessage } {
    return this.db.transaction(() => {
      const time = this.now();
      const user: ChatMessage = {
        id: randomUUID(), conversationId, role: 'user', content, status: 'completed',
        model: null, createdAt: time, completedAt: time,
      };
      const assistant: ChatMessage = {
        id: randomUUID(), conversationId, role: 'assistant', content: '', status: 'streaming',
        model, createdAt: time, completedAt: null,
      };
      this.insertMessage(user);
      this.insertMessage(assistant);
      this.touchConversation(conversationId, time);
      return { user, assistant };
    })();
  }

  appendMessageContent(id: string, delta: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE messages SET content = content || ?
        WHERE id = ? AND role = 'assistant' AND status = 'streaming'`).run(delta, id).changes === 1;
      if (changed) this.touchMessageConversation(id);
      return changed;
    })();
  }

  updateMessageStatus(id: string, status: TerminalStatus): boolean {
    return this.finalizeMessage(id, status);
  }

  finalizeMessage(id: string, status: TerminalStatus, finalDelta = ''): boolean {
    return this.db.transaction(() => {
      const time = this.now();
      const changed = this.db.prepare(`UPDATE messages SET content = content || ?, status = ?, completed_at = ?
        WHERE id = ? AND role = 'assistant' AND status IN ('pending', 'streaming')`)
        .run(finalDelta, status, time, id).changes === 1;
      if (changed) this.touchMessageConversation(id, time);
      return changed;
    })();
  }

  recoverInterruptedMessages(): number {
    return this.db.transaction(() => {
      const time = this.now();
      this.db.prepare(`UPDATE conversations SET updated_at = MAX(updated_at, ?)
        WHERE id IN (SELECT conversation_id FROM messages WHERE role = 'assistant' AND status = 'streaming')`).run(time);
      return this.db.prepare(`UPDATE messages SET status = 'failed', completed_at = ?
        WHERE role = 'assistant' AND status = 'streaming'`).run(time).changes;
    })();
  }

  private touchConversation(id: string, time = this.now()): void {
    this.db.prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(time, id);
  }

  private touchMessageConversation(id: string, time = this.now()): void {
    this.db.prepare(`UPDATE conversations SET updated_at = MAX(updated_at, ?)
      WHERE id = (SELECT conversation_id FROM messages WHERE id = ?)`).run(time, id);
  }
}
