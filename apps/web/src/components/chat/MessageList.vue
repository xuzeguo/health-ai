<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { ChatMessage as Message } from '@health-ai/shared';
import ChatMessage from './ChatMessage.vue';
import { useAutoScroll } from '../../composables/useAutoScroll.js';
const props = defineProps<{ messages: Message[]; conversationId: string | null }>();
const viewport = ref<HTMLElement | null>(null);
const { showReturn, onScroll, toBottom, afterContent } = useAutoScroll(viewport);
watch(() => props.conversationId, async (_id, _old, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  await nextTick();
  if (!cancelled) toBottom();
}, { flush: 'post' });
watch(() => {
  const last = props.messages.at(-1);
  return [props.messages.length, last?.id, last?.content.length, last?.status];
}, async (_value, _old, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  await nextTick();
  if (!cancelled) afterContent();
}, { flush: 'post' });
onMounted(toBottom);
</script>

<template>
  <section class="message-area" aria-label="对话消息">
    <div ref="viewport" class="message-list" aria-live="polite" aria-relevant="additions text" @scroll.passive="onScroll">
      <el-empty v-if="messages.length === 0" description="开始新的对话" />
      <ChatMessage v-for="message in messages" :key="message.id" :message="message" />
    </div>
    <el-button v-if="showReturn" class="return-bottom" @click="toBottom">回到底部</el-button>
  </section>
</template>

<style scoped>
.message-area { position: relative; min-height: 0; min-width: 0; flex: 1; display: flex; }
.message-list { min-height: 0; min-width: 0; flex: 1; overflow-y: auto; padding: 0 24px 20px; overflow-anchor: none; }
.return-bottom { position: absolute; right: 28px; bottom: 12px; }
</style>
