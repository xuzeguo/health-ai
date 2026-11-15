<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '@health-ai/shared';
import { renderMarkdown } from '../../utils/markdown.js';
import 'highlight.js/styles/github.css';
const props = defineProps<{ message: ChatMessage }>();
const rendered = computed(() => props.message.role === 'assistant' ? renderMarkdown(props.message.content) : '');
</script>

<template>
  <article class="chat-message" :aria-label="message.role === 'user' ? '我的消息' : '健康助手消息'">
    <strong>{{ message.role === 'user' ? '我' : '健康助手' }}</strong>
    <div v-if="message.role === 'assistant' && message.content" class="message-content markdown" v-html="rendered"></div>
    <div v-else class="message-content plain">{{ message.content || (message.status === 'streaming' ? '正在思考…' : '暂无内容') }}</div>
    <small v-if="message.status === 'streaming'">生成中…</small>
    <small v-else-if="message.status === 'failed'">生成中断</small>
    <small v-else-if="message.status === 'cancelled'">已停止</small>
  </article>
</template>

<style scoped>
.chat-message { padding: 18px 0; border-bottom: 1px solid var(--app-border); }
.message-content { margin-top: 8px; overflow-wrap: anywhere; line-height: 1.7; }
.plain { white-space: pre-wrap; }
.markdown :deep(> :first-child) { margin-top: 0; }
.markdown :deep(> :last-child) { margin-bottom: 0; }
.markdown :deep(pre) { max-width: 100%; overflow-x: auto; padding: 12px; background: #f6f8fa; border-radius: 4px; }
.markdown :deep(pre code) { white-space: pre; font-size: 13px; }
.markdown :deep(:not(pre) > code) { padding: 2px 4px; background: #f6f8fa; border-radius: 3px; }
.markdown :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown :deep(th), .markdown :deep(td) { border: 1px solid var(--app-border); padding: 6px 10px; }
.markdown :deep(blockquote) { margin-left: 0; padding-left: 16px; border-left: 3px solid var(--app-border); color: var(--app-muted); }
.markdown :deep(img) { max-width: 100%; }
small { display: block; color: var(--app-muted); margin-top: 8px; }
</style>
