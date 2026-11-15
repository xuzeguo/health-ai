import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../apps/server/src/app.js';
import { AppError } from '../apps/server/src/common/errors.js';
import type { ModelProvider } from '../apps/server/src/providers/model-provider.js';

// Isolated acceptance fixture. Never loaded by the production entrypoint.
const path = process.argv[2];
if (!path) throw new Error('Temporary database path required');
const browserScript = process.argv[3];
const canary = process.env.DEEPSEEK_API_KEY ?? '';
const stats = { active: 0, calls: 0, pressureChunks: 0, writeFalse: 0, maxBuffered: 0,
  cancelAborts: 0, credentialLeak: false, browserRequests: 0, browserBodyValid: true };
const report = () => console.info(JSON.stringify({ event: 'stats', ...stats }));
function aborted(signal: AbortSignal | undefined) {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
const provider: ModelProvider = { name: 'p6-controlled-local-fixture', async *chatStream(input) {
  const mode = input.messages.at(-1)?.content;
  stats.active++; stats.calls++;
  const onAbort = () => { if (mode === 'p6:cancel') stats.cancelAborts++; };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = mode === 'p6:pressure' ? setInterval(report, 100) : undefined;
  try {
    if (mode === 'p6:pressure') {
      for (let i = 0; i < 4096 && !input.signal?.aborted; i++) {
        stats.pressureChunks++;
        yield { type: 'content', delta: 'x'.repeat(64 * 1024) };
      }
      throw new AppError('UPSTREAM_ERROR');
    }
    const content = '已提交中文🙂片段';
    yield { type: 'content', delta: content };
    if (['p6:cancel', 'p6:crash', 'p6:timeout'].includes(mode ?? '')) { await aborted(input.signal); return; }
    if (mode === 'p6:error') throw new AppError('UPSTREAM_ERROR');
    await delay(15);
    yield { type: 'done', fullContent: content };
  } finally {
    clearInterval(timer);
    input.signal?.removeEventListener('abort', onAbort);
    stats.active--;
    report();
  }
} };
const app = buildApp({ provider, databasePath: path, flushBytes: 1, idleTimeoutMs: 2000 });
app.addHook('onRequest', async (request, reply) => {
  if (request.url !== '/api/chat/stream') return;
  const raw = reply.raw;
  const original = raw.write;
  raw.write = ((...args: unknown[]) => {
    const accepted = Reflect.apply(original, raw, args) as boolean;
    if (!accepted) stats.writeFalse++;
    stats.maxBuffered = Math.max(stats.maxBuffered, raw.writableLength);
    return accepted;
  }) as typeof raw.write;
});
app.addHook('preHandler', async (request) => {
  if (!request.url.startsWith('/api/')) return;
  if (browserScript) stats.browserRequests++;
  if (request.headers.authorization || (canary && JSON.stringify({ headers: request.headers, body: request.body }).includes(canary))) stats.credentialLeak = true;
  if (request.url === '/api/chat/stream') {
    const keys = Object.keys(request.body as object).sort();
    stats.browserBodyValid &&= JSON.stringify(keys) === JSON.stringify(['conversationId', 'message']);
  }
});
if (browserScript) {
  app.get('/', async (_request, reply) => reply.type('text/html').send('<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/fixture.js"></script></body></html>'));
  app.get('/fixture.js', async (_request, reply) => reply.type('application/javascript').send(readFileSync(browserScript, 'utf8')));
  app.post('/p6-result', async (request) => {
    // Only booleans and bounded counts can enter captured logs/reports.
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 7) throw new AppError('INVALID_PARAM');
    const body = request.body as Record<string, unknown>;
    const boolean = (key: string) => {
      const value = body[key];
      if (typeof value !== 'boolean') throw new AppError('INVALID_PARAM');
      return value;
    };
    const count = (key: string, max: number) => {
      const value = body[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new AppError('INVALID_PARAM');
      return value;
    };
    const result = { passed: boolean('passed'), xssExecuted: boolean('xssExecuted'), activeElements: count('activeElements', 1000),
      linksSafe: boolean('linksSafe'), networkCompleted: boolean('networkCompleted'),
      completedRequests: count('completedRequests', 5), step: count('step', 7) };
    console.info(JSON.stringify({ event: 'browser_result', result }));
    return { ok: true };
  });
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void app.close().then(() => report(), () => { process.exitCode = 1; });
});
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  console.info(JSON.stringify({ event: 'ready', origin }));
} catch (error) {
  console.info(JSON.stringify({ event: 'error', code: error && typeof error === 'object' && 'code' in error && error.code === 'EPERM' ? 'EPERM' : 'START_FAILED' }));
  await app.close();
  process.exitCode = 1;
}
