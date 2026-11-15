import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import type { ChatMessage } from '../packages/shared/src/index.js';
import { buildApp } from '../apps/server/src/app.js';
import { AppError } from '../apps/server/src/common/errors.js';
import { EnvironmentError, isPlaceholderApiKey, loadConfig, PROJECT_ROOT } from '../apps/server/src/config/env.js';
import { DeepSeekProvider } from '../apps/server/src/providers/deepseek.provider.js';
import type { ChatInput, ModelProvider } from '../apps/server/src/providers/model-provider.js';
import { SYSTEM_PROMPT } from '../apps/server/src/prompts/system.js';
import { ChatApiError, createChatApi } from '../apps/web/src/api/chat.js';

// Explicit-only acceptance: five real calls, isolated temporary DB and loopback
// ports. The marker is synthetic test data; neither marker nor replies are logged.
const temp = mkdtempSync(resolve(tmpdir(), 'health-ai-p5-'));
const databasePath = resolve(temp, 'p5.db');
const report = 'docs/p5-smoke-result.json';
const checks: string[] = [];
const rounds: { round: number; contextMessages: number; contentChunks: number; contentLength: number; firstContentMs: number }[] = [];
const apps = new Set<ReturnType<typeof buildApp>>();
let active: AbortController | undefined;
let stage = 'environment';
let model: string | undefined;
let upstreamOrigin: string | undefined;
let passed = false;
let errorCode: string | undefined;
let reasoningLength = 0;

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
  'scripts/verify-p5.ts', 'apps/web/vite.config.ts', 'package.json', 'pnpm-lock.yaml',
].sort();
const sourceHashes = Object.fromEntries(sourcePaths.map((path) => [path,
  createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, path))).digest('hex'),
]));
async function start(provider: ModelProvider) {
  const app = buildApp({ provider, model, databasePath });
  apps.add(app);
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const fetcher: typeof fetch = (input, init) => fetch(new URL(String(input), base), {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  });
  return { app, api: createChatApi(fetcher) };
}
async function close(app: ReturnType<typeof buildApp>) { await app.close(); apps.delete(app); }
const cancel = () => active?.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  assert.match(process.versions.node, /^22\./);
  const config = loadConfig();
  if (isPlaceholderApiKey(config.apiKey)) throw new AppError('CONFIG_ERROR');
  model = config.model;
  upstreamOrigin = new URL(config.baseURL).origin;
  const real = new DeepSeekProvider(config);
  let expected: ChatInput['messages'] | undefined;
  let contextMessages = 0;
  const checkedProvider: ModelProvider = { name: 'p5-verified-deepseek', async *chatStream(input) {
    // Inspect the actual Service -> Provider boundary, not just model recall.
    assert.ok(expected);
    assert.deepEqual(input.messages, expected);
    assert.equal(input.model, model);
    contextMessages = input.messages.length;
    for await (const event of real.chatStream(input)) {
      if (event.type === 'reasoning') reasoningLength += event.delta.length;
      yield event;
    }
  } };
  stage = 'http-startup';
  const local = await start(checkedProvider);
  const conversation = await local.api.createConversation();
  const other = await local.api.createConversation();
  const marker = `健测${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const prompts = [
    `请记住本次对话的测试代号“${marker}”。以后问到测试代号时原样回复。现在只回复“已记录”。`,
    '本次对话的测试代号是什么？请仅回复代号。',
    '继续记住刚才的代号。现在请用一句话解释保持规律作息的一般好处，不要复述代号。',
    '请给出本次对话刚才记录的测试代号，不要添加其他文字。',
    '最后一次确认：请仅回复本次对话最初记录的测试代号。',
  ];
  let previous: ChatMessage[] = [];
  for (let index = 0; index < prompts.length; index++) {
    stage = `real-round-${index + 1}`;
    const prompt = prompts[index]!;
    expected = [{ role: 'system', content: SYSTEM_PROMPT },
      ...previous.filter((message) => message.status === 'completed').slice(-20).map(({ role, content }) => ({ role, content })),
      { role: 'user', content: prompt }];
    const controller = new AbortController();
    active = controller;
    let content = '';
    let contentChunks = 0;
    let completed = false;
    let messageId: string | undefined;
    const started = Date.now();
    let firstContentMs = 0;
    await local.api.stream({ conversationId: conversation.id, message: prompt }, controller.signal, (frame) => {
      if (frame.event === 'message_error') throw new AppError(frame.data.code);
      if (frame.event === 'message_start') messageId = frame.data.messageId;
      if (frame.event === 'content_delta') { firstContentMs ||= Date.now() - started; content += frame.data.delta; contentChunks++; }
      if (frame.event === 'message_complete') completed = true;
    });
    active = undefined;
    assert.equal(completed, true);
    assert.ok(content.length > 0);
    const detail = await local.api.getConversation(conversation.id);
    assert.equal(detail.messages.length, (index + 1) * 2);
    assert.ok(detail.messages.every((message) => message.status === 'completed' && message.completedAt !== null));
    assert.deepEqual(detail.messages.slice(0, -2), previous);
    assert.equal(detail.messages.at(-2)?.role, 'user');
    assert.equal(detail.messages.at(-2)?.content, prompt);
    assert.equal(detail.messages.at(-1)?.id, messageId);
    assert.equal(detail.messages.at(-1)?.content, content);
    assert.equal(contextMessages, (index + 1) * 2);
    if ([1, 3, 4].includes(index) && !content.includes(marker)) {
      errorCode = 'CONTEXT_RECALL_FAILED';
      throw new Error('Context recall mismatch');
    }
    previous = detail.messages;
    rounds.push({ round: index + 1, contextMessages, contentChunks, contentLength: content.length, firstContentMs });
    console.info(JSON.stringify({ phase: 'P5', round: index + 1, passed: true, contextMessages, contentChunks, contentLength: content.length }));
  }
  assert.equal(reasoningLength, 0);
  checks.push('five-real-http-streamed-turns', 'provider-context-order-and-no-current-duplicate',
    'persisted-history-append-only-ten-completed-messages', 'round-2-4-5-recall-original-marker', 'reasoning-not-returned');
  assert.deepEqual((await local.api.getConversation(other.id)).messages, []);
  await close(local.app);

  stage = 'reopen-switch-delete';
  const reopened = await start(checkedProvider);
  assert.deepEqual((await reopened.api.getConversation(conversation.id)).messages, previous);
  assert.deepEqual((await reopened.api.getConversation(other.id)).messages, []);
  const list = await reopened.api.listConversations();
  assert.equal(list[0]?.id, conversation.id);
  assert.equal(list.length, 2);
  checks.push('history-survives-file-database-reopen', 'conversation-isolation-and-updated-list-order');
  await reopened.api.deleteConversation(conversation.id);
  await assert.rejects(reopened.api.getConversation(conversation.id), (error: unknown) => error instanceof ChatApiError && error.code === 'CONVERSATION_NOT_FOUND');
  assert.deepEqual((await reopened.api.listConversations()).map((item) => item.id), [other.id]);
  assert.deepEqual((await reopened.api.getConversation(other.id)).messages, []);
  checks.push('delete-and-other-conversation-unchanged');
  await close(reopened.app);
  passed = true;
} catch (error) {
  errorCode ??= error instanceof AppError || error instanceof ChatApiError ? error.code
    : error instanceof EnvironmentError ? 'CONFIG_ERROR'
    : error && typeof error === 'object' && 'code' in error && error.code === 'EPERM' ? 'EPERM' : 'P5_CHECK_FAILED';
} finally {
  active?.abort();
  const results = await Promise.allSettled([...apps].map((app) => app.close()));
  if (results.some((result) => result.status === 'rejected')) { passed = false; errorCode = 'CLEANUP_FAILED'; }
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(resolve(PROJECT_ROOT, report), `${JSON.stringify({
  phase: 'P5', passed, checkedAt: new Date().toISOString(), nodeVersion: process.version, model, upstreamOrigin,
  stage: passed ? 'complete' : stage, ...(errorCode ? { errorCode } : {}), checks, rounds, reasoningLength, sourceHashes,
  limitations: ['Browser sidebar/dialog/Markdown/highlighting/scroll/IME require manual acceptance; P6 has not started'],
}, null, 2)}\n`, { mode: 0o600 });
console.info(JSON.stringify({ passed, ...(errorCode ? { errorCode, stage } : {}), rounds: rounds.length, checks: checks.length, report }));
if (!passed) process.exitCode = 1;
