import { ref, type Ref } from 'vue';

export interface ScrollViewport { scrollHeight: number; clientHeight: number; scrollTop: number }

export function useAutoScroll(viewport: Readonly<Ref<ScrollViewport | null>>) {
  const following = ref(true);
  const showReturn = ref(false);
  function onScroll() {
    const element = viewport.value;
    if (!element) return;
    const gap = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
    if (gap <= 24) following.value = true;
    else if (gap > element.clientHeight) following.value = false;
    showReturn.value = !following.value && gap > 24;
  }
  function toBottom() {
    const element = viewport.value;
    following.value = true;
    showReturn.value = false;
    if (element) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }
  function afterContent() { if (following.value) toBottom(); }
  return { showReturn, onScroll, toBottom, afterContent };
}
