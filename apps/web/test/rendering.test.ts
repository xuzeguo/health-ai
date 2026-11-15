import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ref } from 'vue';
import hljs from 'highlight.js/lib/core';
import { useAutoScroll } from '../src/composables/useAutoScroll.js';
import { renderMarkdown } from '../src/utils/markdown.js';

test('Markdown renders lists, tables, links and newlines while raw HTML is escaped', () => {
  const rendered = renderMarkdown('# 标题\n\n- 第一项\n- 第二项\n\n| 列 | 值 |\n| --- | --- |\n| 中文 | 内容 |\n\n第一行\n第二行\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.match(rendered, /<h1>标题<\/h1>/);
  assert.match(rendered, /<li>第一项<\/li>/);
  assert.match(rendered, /<table>/);
  assert.match(rendered, /第一行<br>\n第二行/);
  assert.equal(rendered.includes('<script>'), false);
  assert.equal(rendered.includes('<img src=x'), false);
  assert.match(rendered, /&lt;script&gt;/);
});

test('explicit and linkified links open with safe attributes; javascript and unsafe data links never become hrefs', () => {
  const rendered = renderMarkdown('[示例](https://example.com "title")\n\nhttps://example.org\n\n[test](javascript:alert%281%29)\n\n[test](data:text/html;base64,PHNjcmlwdD4=)');
  const anchors = rendered.match(/<a\b[^>]*>/g) ?? [];
  assert.equal(anchors.length, 2);
  for (const anchor of anchors) {
    assert.match(anchor, /target="_blank"/);
    assert.match(anchor, /rel="noopener noreferrer"/);
  }
  assert.doesNotMatch(rendered, /href="(?:javascript|data):/i);
});

test('fenced highlighter supports only configured subset; unknown, malicious and unfinished fences remain escaped', () => {
  for (const [language, source] of [
    ['js', 'const message = "中文";'], ['ts', 'const count: number = 1;'], ['json', '{"ok":true}'],
    ['bash', 'echo "$PATH"'], ['sql', 'SELECT 1;'], ['python', 'def test():\n  return True'],
    ['html', '<div onclick="alert(1)">text</div>'], ['css', 'body { color: red; }'],
  ]) {
    const rendered = renderMarkdown(`\`\`\`${language}\n${source}\n\`\`\``);
    assert.match(rendered, /class="hljs language-/);
    assert.match(rendered, /hljs-/);
    assert.doesNotMatch(rendered, /<div onclick/);
  }
  const unknown = renderMarkdown('```unknown\n<script>alert(1)</script>\n```');
  assert.match(unknown, /&lt;script&gt;/);
  assert.doesNotMatch(unknown, /class="hljs /);
  const unfinished = renderMarkdown('```html\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(unfinished, /<img/);
  const maliciousLanguage = renderMarkdown('```js"onmouseover="alert(1)\n<script>x</script>\n```');
  assert.doesNotMatch(maliciousLanguage, / onmouseover="/);
  assert.doesNotMatch(maliciousLanguage, /<script>/);
  assert.doesNotMatch(renderMarkdown('```__proto__\n<script>x</script>\n```'), /<script>/);
});

test('auto-scroll follows content until user scrolls up over a screen, then resumes only at bottom or explicit reset', () => {
  const element = ref({ scrollHeight: 3000, clientHeight: 500, scrollTop: 2500 });
  const scroll = useAutoScroll(element);
  element.value.scrollHeight = 3100;
  scroll.afterContent();
  assert.equal(element.value.scrollTop, 2600);
  element.value.scrollTop = 1900;
  scroll.onScroll();
  assert.equal(scroll.showReturn.value, true);
  element.value.scrollHeight = 3500;
  scroll.afterContent();
  assert.equal(element.value.scrollTop, 1900);
  element.value.scrollTop = 2800;
  scroll.onScroll();
  assert.equal(scroll.showReturn.value, true);
  element.value.scrollTop = 2990;
  scroll.onScroll();
  assert.equal(scroll.showReturn.value, false);
  scroll.afterContent();
  assert.equal(element.value.scrollTop, 3000);
  element.value.scrollTop = 0;
  scroll.onScroll();
  scroll.toBottom();
  assert.equal(element.value.scrollTop, 3000);
  assert.equal(scroll.showReturn.value, false);
});

test('highlighter failure falls back to escaped code without executing or injecting HTML', (t) => {
  t.mock.method(hljs, 'highlight', () => { throw new Error('Synthetic highlighter failure'); });
  const rendered = renderMarkdown('```html\n<img src=x onerror="alert(1)">\n```');
  assert.match(rendered, /&lt;img/);
  assert.doesNotMatch(rendered, /<img|<script|class="hljs/);
});
