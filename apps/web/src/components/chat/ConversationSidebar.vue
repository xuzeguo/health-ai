<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Conversation } from '@health-ai/shared';

const props = defineProps<{
  conversations: Conversation[];
  currentId: string | null;
  loading: boolean;
  generating: boolean;
}>();
const emit = defineEmits<{ create: []; select: [id: string]; delete: [id: string] }>();
const deleteTarget = ref<Conversation | null>(null);
const dialogOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (value: boolean) => { if (!value) deleteTarget.value = null; },
});
const formatTime = (time: number) => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(time);
function confirmDelete() {
  const id = deleteTarget.value?.id;
  if (!id || props.loading || (props.generating && props.currentId === id)) return;
  deleteTarget.value = null;
  emit('delete', id);
}
</script>

<template>
  <aside class="conversation-sidebar" aria-label="会话侧栏">
    <div class="sidebar-header">
      <h2>会话</h2>
      <el-button :disabled="loading" @click="emit('create')">新建对话</el-button>
    </div>
    <nav aria-label="历史会话" :aria-busy="loading">
      <el-empty v-if="conversations.length === 0" description="暂无会话" :image-size="64" />
      <ul v-else>
        <li v-for="conversation in conversations" :key="conversation.id" :class="{ selected: conversation.id === currentId }">
          <el-button class="conversation-select" text :disabled="loading" :aria-current="conversation.id === currentId ? 'page' : undefined"
            :aria-label="`${conversation.title}，${formatTime(conversation.updatedAt)}，${conversation.id.slice(-4)}`"
            @click="emit('select', conversation.id)">
            <span class="conversation-label">
              <span class="conversation-title">{{ conversation.title }}</span>
              <small>{{ formatTime(conversation.updatedAt) }} · {{ conversation.id.slice(-4) }}</small>
            </span>
          </el-button>
          <el-button text class="delete-button" :disabled="loading || (generating && conversation.id === currentId)"
            :title="generating && conversation.id === currentId ? '请先停止生成' : '删除会话'"
            :aria-label="`删除${conversation.title} ${conversation.id.slice(-4)}`" @click="deleteTarget = conversation">删除</el-button>
        </li>
      </ul>
    </nav>
    <el-dialog v-model="dialogOpen" title="删除会话" width="400px" :close-on-click-modal="false">
      <p>确定删除“{{ deleteTarget?.title }}”吗？该会话的所有消息也会删除，无法恢复。</p>
      <template #footer>
        <el-button @click="deleteTarget = null">取消</el-button>
        <el-button type="danger" :disabled="loading" @click="confirmDelete">确认删除</el-button>
      </template>
    </el-dialog>
  </aside>
</template>

<style scoped>
.conversation-sidebar { width: 260px; flex: 0 0 260px; display: flex; flex-direction: column; border-right: 1px solid var(--app-border); }
.sidebar-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--app-border); }
h2 { margin: 0; font-size: 16px; }
nav { flex: 1; overflow-y: auto; min-height: 0; }
ul { list-style: none; margin: 0; padding: 8px; }
li { display: flex; align-items: center; border-radius: 4px; margin-bottom: 4px; }
li.selected { background: #eff6ff; }
.conversation-select { flex: 1; min-width: 0; height: auto; padding: 10px 8px; justify-content: flex-start; }
.conversation-select :deep(> span) { min-width: 0; width: 100%; }
.conversation-label { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; width: 100%; }
.conversation-title { display: block; overflow: hidden; text-overflow: ellipsis; max-width: 100%; white-space: nowrap; }
small { color: var(--app-muted); font-size: 11px; }
.delete-button { margin-left: 0; padding-inline: 6px; }
</style>
