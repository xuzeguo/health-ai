<script setup lang="ts">
import { ref } from 'vue';
const props = defineProps<{ disabled: boolean; generating: boolean }>();
const emit = defineEmits<{ send: [content: string]; stop: [] }>();
const content = ref('');
const composing = ref(false);
function send() {
  if (props.disabled || props.generating || !content.value.trim()) return;
  emit('send', content.value);
  content.value = '';
}
function onKeydown(event: KeyboardEvent | Event) {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing.value && event.keyCode !== 229) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <form class="chat-input" @submit.prevent="send">
    <el-input v-model="content" type="textarea" :rows="3" :maxlength="8000" show-word-limit
      :disabled="disabled || generating" placeholder="输入健康问题，Enter 发送，Shift+Enter 换行" aria-label="输入健康问题"
      @keydown="onKeydown" @compositionstart="composing = true" @compositionend="composing = false" />
    <div class="input-actions">
      <span>健康知识仅供参考，如有不适请及时就医。</span>
      <el-button v-if="generating" @click="emit('stop')">停止生成</el-button>
      <el-button v-else type="primary" native-type="submit" :disabled="disabled || !content.trim()">发送</el-button>
    </div>
  </form>
</template>

<style scoped>
.chat-input { border-top: 1px solid var(--app-border); padding: 16px 24px; }
.input-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; gap: 16px; }
.input-actions span { color: var(--app-muted); font-size: 12px; }
</style>
