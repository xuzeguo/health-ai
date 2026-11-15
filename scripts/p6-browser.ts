import { createChatApi } from '../apps/web/src/api/chat.js';
import { renderMarkdown } from '../apps/web/src/utils/markdown.js';

declare global { interface Window { __p6Xss: number } }
const result = { passed: false, xssExecuted: false, activeElements: 0, linksSafe: false,
  networkCompleted: false, completedRequests: 0, step: 0 };
async function run() {
  window.__p6Xss = 0;
  const payloads = [
    '<script>window.__p6Xss=1</script>',
    '<img src="/missing-p6" onerror="window.__p6Xss=1">',
    '<svg onload="window.__p6Xss=1"></svg>',
    '<iframe srcdoc="<script>parent.__p6Xss=1</script>"></iframe>',
    '[bad](javascript:window.__p6Xss=1)',
    '[bad](data:text/html;base64,PHNjcmlwdD4=)',
    '```html\n<img src=x onerror="window.__p6Xss=1">\n```',
    '```unknown\n</code><img src=x onerror="window.__p6Xss=1">\n```',
    '[safe](https://example.invalid)\n\nhttps://example.invalid',
  ];
  const sandbox = document.createElement('div');
  sandbox.innerHTML = renderMarkdown(payloads.join('\n\n'));
  document.body.append(sandbox);
  result.step = 1;
  const inspect = () => {
    const links = Array.from(sandbox.querySelectorAll('a'));
    result.xssExecuted = window.__p6Xss !== 0;
    result.activeElements = sandbox.querySelectorAll('script,iframe,svg,[onerror],[onload],[onclick]').length;
    result.linksSafe = links.length === 2 && links.every((link) => link.target === '_blank'
      && link.rel === 'noopener noreferrer' && !/^(?:javascript|data):/i.test(link.getAttribute('href') ?? ''));
  };
  inspect();
  const api = createChatApi(); // Real browser fetch; no transport stub.
  await api.listConversations();
  result.completedRequests++; result.step = 2;
  const conversation = await api.createConversation();
  result.completedRequests++; result.step = 3;
  await api.getConversation(conversation.id);
  result.completedRequests++; result.step = 4;
  let complete = false;
  await api.stream({ conversationId: conversation.id, message: 'p6:normal' }, new AbortController().signal, (frame) => {
    if (frame.event === 'message_error') throw new Error('Browser stream failed');
    if (frame.event === 'message_complete') complete = true;
  });
  result.completedRequests++; result.step = 5;
  await api.deleteConversation(conversation.id);
  result.completedRequests++; result.step = 6;
  await new Promise((resolve) => setTimeout(resolve, 100));
  inspect();
  result.networkCompleted = complete; result.step = 7;
  result.passed = complete && !result.xssExecuted && result.activeElements === 0 && result.linksSafe;
}
async function publish() {
  document.body.replaceChildren();
  const pre = document.createElement('pre'); pre.id = 'p6-result'; pre.textContent = JSON.stringify(result); document.body.append(pre);
  // Test-only callback. The parent waits on wall time for this acknowledgement,
  // rather than dumping DOM before an async fetch/SSE chain has completed.
  await fetch('/p6-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
}
void run().then(publish, publish).catch(() => {});
