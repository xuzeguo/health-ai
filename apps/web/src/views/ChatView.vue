<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage } from 'element-plus';
import 'element-plus/es/components/message/style/css';
import ChatInput from '../components/chat/ChatInput.vue';
import MessageList from '../components/chat/MessageList.vue';
import ConversationSidebar from '../components/chat/ConversationSidebar.vue';
import { useChat } from '../composables/useChat.js';
import { useChatStore } from '../stores/chat.js';

const store = useChatStore();
const { conversations, currentConversationId, messages, loading, generating, error } = storeToRefs(store);
const chat = useChat((message) => { ElMessage.error(message); });
onMounted(async () => {
  await chat.loadConversations();
  if (store.error) return;
  const first = store.conversations[0];
  if (first) await chat.switchConversation(first.id);
  else await chat.createConversation();
});
onBeforeUnmount(() => chat.stopGeneration());
</script>

<template>
  <main class="chat-workspace" aria-label="HealthAI 聊天工作区">
    <ConversationSidebar :conversations="conversations" :current-id="currentConversationId" :loading="loading" :generating="generating"
      @create="chat.createConversation" @select="chat.switchConversation" @delete="chat.deleteConversation" />
    <section class="conversation-panel" aria-label="当前会话">
      <header><h1>HealthAI 健康助手</h1></header>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <MessageList v-loading="loading" :messages="messages" :conversation-id="currentConversationId" />
      <ChatInput :disabled="loading" :generating="generating" @send="chat.sendMessage" @stop="chat.stopGeneration" />
    </section>
  </main>
</template>

<style scoped>
.chat-workspace { max-width: 1280px; min-width: 900px; height: 100dvh; margin: 0 auto; display: flex; border-inline: 1px solid var(--app-border); }
.conversation-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; }
header { padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--app-border); }
h1 { margin: 0; font-size: 20px; }
.error { margin: 12px 24px 0; color: #b42318; font-size: 14px; }
</style>
