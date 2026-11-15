import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError } from '../apps/server/src/common/errors.js';
import { EnvironmentError, isPlaceholderApiKey, loadConfig, PROJECT_ROOT } from '../apps/server/src/config/env.js';
import { DeepSeekProvider } from '../apps/server/src/providers/deepseek.provider.js';

const sourcePaths = [
  'apps/server/src/providers/model-provider.ts',
  'apps/server/src/providers/deepseek.provider.ts',
  'apps/server/src/common/errors.ts',
  'apps/server/src/config/env.ts',
  'packages/shared/src/chat.ts',
  'packages/shared/src/errors.ts',
  'scripts/test-provider.ts',
  'pnpm-lock.yaml',
];
const sourceHashes = Object.fromEntries(sourcePaths.map((path) => [
  path, createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, path))).digest('hex'),
]));
const controller = new AbortController();
const started = performance.now();
let timer: ReturnType<typeof setTimeout> | undefined;
let contentChunks = 0;
let contentLength = 0;
let reasoningLength = 0;
let firstContentMs: number | null = null;
let completed = false;
let model: string | undefined;
let upstreamOrigin: string | undefined;
const refreshDeadline = () => {
  clearTimeout(timer);
  timer = setTimeout(() => controller.abort(new AppError('UPSTREAM_TIMEOUT')), 60_000);
};
const cancel = () => controller.abort(new DOMException('Operator cancelled', 'AbortError'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  const config = loadConfig();
  upstreamOrigin = new URL(config.baseURL).origin;
  if (isPlaceholderApiKey(config.apiKey)) throw new AppError('CONFIG_ERROR');
  model = config.model;
  const provider = new DeepSeekProvider(config);
  refreshDeadline();
  for await (const event of provider.chatStream({
    model,
    messages: [{ role: 'user', content: '请只回复：连接成功。' }],
    signal: controller.signal,
  })) {
    if (event.type === 'content') {
      refreshDeadline();
      firstContentMs ??= Math.round(performance.now() - started);
      contentChunks++;
      contentLength += event.delta.length;
    } else if (event.type === 'reasoning') {
      reasoningLength += event.delta.length;
    } else {
      if (event.fullContent.length !== contentLength) throw new AppError('UPSTREAM_ERROR');
      completed = true;
    }
  }
  if (!completed || !contentLength || reasoningLength) throw new AppError('UPSTREAM_ERROR');
  const report = {
    phase: 'P2', passed: true, checkedAt: new Date().toISOString(), model, upstreamOrigin,
    officialDeepSeekEndpoint: upstreamOrigin === 'https://api.deepseek.com',
    thinkingDisabledRequested: true, reasoningLength, contentChunks, contentLength,
    firstContentMs, durationMs: Math.round(performance.now() - started), sourceHashes,
  };
  writeFileSync(resolve(PROJECT_ROOT, 'docs/provider-smoke-result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.info(JSON.stringify({
    passed: true, model, contentChunks, contentLength, reasoningLength,
    firstContentMs, report: 'docs/provider-smoke-result.json',
  }));
} catch (error) {
  const timeout = controller.signal.reason instanceof AppError && controller.signal.reason.code === 'UPSTREAM_TIMEOUT';
  const code = timeout ? 'UPSTREAM_TIMEOUT' : error instanceof AppError ? error.code : error instanceof EnvironmentError ? 'CONFIG_ERROR' : 'UPSTREAM_ERROR';
  writeFileSync(resolve(PROJECT_ROOT, 'docs/provider-smoke-result.json'), `${JSON.stringify({
    phase: 'P2', passed: false, checkedAt: new Date().toISOString(), model, upstreamOrigin, code,
    contentChunks, contentLength, reasoningLength,
    durationMs: Math.round(performance.now() - started), sourceHashes,
  }, null, 2)}\n`, { mode: 0o600 });
  console.error(JSON.stringify({ passed: false, code,
    hint: code === 'CONFIG_ERROR' ? '请在本地 .env 填写有效 Key 并检查配置；不要发送 Key 到聊天。' : '请检查网络、账户和上游服务。日志不包含 Key、请求头或回复正文。',
  }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
