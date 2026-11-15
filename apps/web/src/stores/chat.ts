import { defineStore } from 'pinia';
import type { ChatMessage, Conversation } from '@health-ai/shared';

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversations: [] as Conversation[],
    currentConversationId: null as string | null,
    messages: [] as ChatMessage[],
    loading: false,
    generating: false,
    error: null as string | null,
  }),
});
