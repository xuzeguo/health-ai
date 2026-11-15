import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatMessage, ChatStreamEvent } from '../packages/shared/src/index.js';
import { buildApp } from '../apps/server/src/app.js';
import { AppError } from '../apps/server/src/common/errors.js';
import { EnvironmentError, isPlaceholderApiKey, loadConfig, PROJECT_ROOT } from '../apps/server/src/config/env.js';
import { DeepSeekProvider } from '../apps/server/src/providers/deepseek.provider.js';
import type { ModelProvider } from '../apps/server/src/providers/model-provider.js';
import { createChatApi } from '../apps/web/src/api/chat.js';

// Run only explicitly: two real model requests, isolated temporary database,
// random loopback ports. No production conversations are read or modified.
const temp = mkdtempSync(resolve(tmpdir(), 'health-ai-p4-'));
const checks: string[] = [];
let stage = 'environment';
let passed = false;
let errorCode: string | undefined;
let model: string | undefined;
const metrics: Record<string, number> = {};
const apps = new Set<ReturnType<typeof buildApp>>();
const controllers = new Set<AbortController>();
const report = 'docs/p4-smoke-result.json';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|vue|css|sql)$/.test(path) && !/\/(?:auto-imports|components)\.d\.ts$/.test(path)
      ? [relative(PROJECT_ROOT, path)] : [];
  });
}
const sourcePaths = [
  ...sources(resolve(PROJECT_ROOT, 'apps/server/src')),
  ...sources(resolve(PROJECT_ROOT, 'apps/web/src')),
  ...sources(resolve(PROJECT_ROOT, 'packages/shared/src')),
  'scripts/verify-p4.ts', 'apps/web/vite.config.ts', 'package.json', 'pnpm-lock.yaml',
].sort();
const sourceHashes = Object.fromEntries(sourcePaths.map((path) => [path,
  createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, path))).digest('hex'),
]));
async function start(provider: ModelProvider, databasePath: string) {
  const app = buildApp({ provider, databasePath, model });
  apps.add(app);
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const fetcher: typeof fetch = (input, init) => fetch(new URL(String(input), base), {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  });
  return { app, api: createChatApi(fetcher), fetcher };
}
async function close(app: ReturnType<typeof buildApp>) { await app.close(); apps.delete(app); }
async function terminal(api: ReturnType<typeof createChatApi>, id: string): Promise<ChatMessage[]> {
  for (let i = 0; i < 100; i++) {
    const { messages } = await api.getConversation(id);
    if (messages.length && messages.every((message) => message.status !== 'streaming' && message.status !== 'pending')) return messages;
    await delay(50);
  }
  throw new Error('Finalization deadline exceeded');
}
async function complete(api: ReturnType<typeof createChatApi>, prompt: string) {
  const conversation = await api.createConversation();
  const controller = new AbortController();
  controllers.add(controller);
  let content = '';
  let messageId: string | undefined;
  let completed = false;
  let chunks = 0;
  const started = Date.now();
  let firstContentMs = 0;
  await api.stream({ conversationId: conversation.id, message: prompt }, controller.signal, (frame) => {
    if (frame.event === 'message_error') throw new AppError(frame.data.code);
    if (frame.event === 'message_start') messageId = frame.data.messageId;
    if (frame.event === 'content_delta') {
      firstContentMs ||= Date.now() - started;
      content += frame.data.delta; chunks++;
    }
    if (frame.event === 'message_complete') completed = true;
  });
  controllers.delete(controller);
  const messages = await terminal(api, conversation.id);
  assert.equal(completed, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.content, prompt);
  assert.equal(messages[1]?.id, messageId);
  assert.equal(messages[1]?.status, 'completed');
  assert.equal(messages[1]?.content, content);
  assert.ok(content.length > 0);
  return { id: conversation.id, contentLength: content.length, chunks, firstContentMs };
}
async function cancel(api: ReturnType<typeof createChatApi>, fetcher: typeof fetch, prompt: string, checkBusy: boolean) {
  const conversation = await api.createConversation();
  const controller = new AbortController();
  controllers.add(controller);
  let seen!: () => void;
  let rejectSeen!: (error: unknown) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => { seen = resolveReady; rejectSeen = rejectReady; });
  let content = '';
  let prematureTerminal = false;
  const events: ChatStreamEvent['event'][] = [];
  const running = api.stream({ conversationId: conversation.id, message: prompt }, controller.signal, (frame) => {
    events.push(frame.event);
    if (frame.event === 'content_delta') { content += frame.data.delta; seen(); }
    if (frame.event === 'message_error') throw new AppError(frame.data.code);
    if (frame.event === 'message_complete') prematureTerminal = true;
  });
  const settled = running.then(() => { rejectSeen(new Error('Completed before cancellation')); }, (error: unknown) => {
    rejectSeen(error);
    if (!controller.signal.aborted) throw error;
  });
  // Observe rejection immediately even if a parallel busy check fails below.
  void settled.catch(() => {});
  await ready;
  assert.equal(prematureTerminal, false);
  if (checkBusy) {
    for (const request of [
      { path: '/api/chat/stream', init: { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.id, message: 'second' }) } },
      { path: `/api/conversations/${conversation.id}`, init: { method: 'DELETE' } },
    ]) {
      const response = await fetcher(request.path, request.init);
      assert.equal(response.status, 409);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal((await response.json() as { code: string }).code, 'CONVERSATION_BUSY');
    }
  }
  controller.abort();
  await settled;
  controllers.delete(controller);
  const messages = await terminal(api, conversation.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.status, 'cancelled');
  assert.ok(messages[1]?.content.startsWith(content));
  assert.ok(content.length > 0);
  assert.equal(events.includes('message_complete'), false);
  return { id: conversation.id, contentLength: content.length };
}

try {
  assert.match(process.versions.node, /^22\./);
  const config = loadConfig();
  if (isPlaceholderApiKey(config.apiKey)) throw new AppError('CONFIG_ERROR');
  model = config.model;
  let mockAborted = false;
  const deterministic: ModelProvider = { name: 'local-verification', async *chatStream(input) {
    if (input.messages.at(-1)?.content === 'cancel smoke') {
      input.signal?.addEventListener('abort', () => { mockAborted = true; }, { once: true });
      yield { type: 'content', delta: '保留中文🙂片段' };
      await new Promise<void>((resolveWait) => input.signal?.addEventListener('abort', () => resolveWait(), { once: true }));
    } else {
      yield { type: 'content', delta: '中文🙂' };
      await delay(120);
      yield { type: 'content', delta: '\n链路成功' };
      yield { type: 'done', fullContent: '中文🙂\n链路成功' };
    }
  } };
  stage = 'local-http-normal';
  const mockPath = resolve(temp, 'local.db');
  const local = await start(deterministic, mockPath);
  const completed = await complete(local.api, 'normal smoke');
  assert.equal(completed.chunks >= 2, true);
  checks.push('http-stream-normal-request-body-close-not-cancellation', 'utf8-chinese-emoji', 'complete-get-db-consistency');
  stage = 'local-http-disconnect';
  const cancelled = await cancel(local.api, local.fetcher, 'cancel smoke', true);
  assert.equal(mockAborted, true);
  checks.push('http-disconnect-upstream-abort', 'cancel-partial-persistence', 'concurrent-post-and-delete-json-409');
  await close(local.app);
  stage = 'database-reopen';
  const reopened = await start(deterministic, mockPath);
  assert.equal((await reopened.api.getConversation(completed.id)).messages[1]?.status, 'completed');
  assert.equal((await reopened.api.getConversation(cancelled.id)).messages[1]?.status, 'cancelled');
  await close(reopened.app);
  checks.push('file-database-reopen-retains-both-terminal-states');

  const provider = new DeepSeekProvider(config);
  stage = 'real-model-complete';
  const real = await start(provider, resolve(temp, 'real.db'));
  const result = await complete(real.api, '请用两句中文介绍规律作息的一般益处，总字数不超过60字。');
  metrics.realContentChunks = result.chunks;
  metrics.realContentLength = result.contentLength;
  metrics.realFirstContentMs = result.firstContentMs;
  checks.push('real-deepseek-sse-complete-and-db-consistency');
  stage = 'real-model-cancel';
  const stopped = await cancel(real.api, real.fetcher, '请用中文详细写一篇约1500字的科普文章，解释睡眠、日常运动和均衡饮食的一般健康意义，分成十个自然段。', false);
  metrics.realCancelledContentLength = stopped.contentLength;
  checks.push('real-deepseek-disconnect-and-cancelled-partial');
  await close(real.app);
  passed = true;
} catch (error) {
  errorCode = error instanceof AppError ? error.code : error instanceof EnvironmentError ? 'CONFIG_ERROR'
    : error && typeof error === 'object' && 'code' in error && error.code === 'EPERM' ? 'EPERM' : 'P4_CHECK_FAILED';
} finally {
  for (const controller of controllers) controller.abort();
  const results = await Promise.allSettled([...apps].map((app) => app.close()));
  if (results.some((result) => result.status === 'rejected')) { passed = false; errorCode = 'CLEANUP_FAILED'; }
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(resolve(PROJECT_ROOT, report), `${JSON.stringify({
  phase: 'P4', passed, checkedAt: new Date().toISOString(), nodeVersion: process.version, model,
  stage: passed ? 'complete' : stage, ...(errorCode ? { errorCode } : {}), checks, metrics, sourceHashes,
  limitations: ['Does not automate browser rendering/IME or P6 OS-level crash/backpressure tests'],
}, null, 2)}\n`, { mode: 0o600 });
console.info(JSON.stringify({ passed, ...(errorCode ? { errorCode, stage } : {}), checks: checks.length, metrics, report }));
if (!passed) process.exitCode = 1;
