import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_ROOT } from '../apps/server/src/config/env.js';
import { createChatApi } from '../apps/web/src/api/chat.js';
import type { ChatStreamEvent } from '../packages/shared/src/index.js';

// Controlled local fixtures only. No .env load, real API request, daily DB or
// existing browser profile. Reports deliberately exclude captured process logs.
const temp = mkdtempSync(resolve(tmpdir(), 'health-ai-p6-'));
const canary = `p6-synthetic-${randomUUID()}`;
const env = { ...process.env, DEEPSEEK_API_KEY: canary, NO_COLOR: '1' };
const needles = [canary, encodeURIComponent(canary), Buffer.from(canary).toString('base64')];
const report = 'docs/p6-smoke-result.json';
const checks: string[] = [];
const metrics: Record<string, number> = {};
let stage = 'environment';
let passed = false;
let errorCode: string | undefined;
class CheckError extends Error { constructor(readonly code: string) { super(code); } }
interface Stats { active: number; calls: number; pressureChunks: number; writeFalse: number; maxBuffered: number;
  cancelAborts: number; credentialLeak: boolean; browserRequests: number; browserBodyValid: boolean }
interface BrowserResult { passed: boolean; xssExecuted: boolean; activeElements: number; linksSafe: boolean;
  networkCompleted: boolean; completedRequests: number; step: number }
let browserDiagnostics: BrowserResult | undefined;
interface ProcessRun {
  child: ChildProcess; output: string; closed: boolean;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  origin?: string; failure?: string; stats?: Stats; browserResult?: BrowserResult;
}
const processes = new Set<ProcessRun>();
const aborters = new Set<AbortController>();
const safe = (value: string | Buffer) => !needles.some((needle) => value.includes(needle));
function deadline<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CheckError('CHECK_TIMEOUT')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function until(predicate: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > end) throw new CheckError('CHECK_TIMEOUT');
    await delay(30);
  }
}
function launch(args: string[], options: { executable?: string; cwd?: string } = {}): ProcessRun {
  const child = spawn(options.executable ?? process.execPath, args, {
    cwd: options.cwd ?? resolve(PROJECT_ROOT, 'apps/server'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run: ProcessRun = { child, output: '', closed: false, exit: Promise.resolve({ code: null, signal: null }) };
  run.exit = new Promise((done) => child.once('close', (code, signal) => { run.closed = true; done({ code, signal }); }));
  child.once('error', () => { run.failure = 'PROCESS_START_FAILED'; });
  let pending = '';
  child.stdout!.on('data', (buffer: Buffer) => {
    run.output += buffer.toString();
    pending += buffer.toString();
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') run.origin = event.origin;
        if (event.event === 'error') run.failure = event.code;
        if (event.event === 'stats') run.stats = event as Stats;
        if (event.event === 'browser_result') run.browserResult = event.result as BrowserResult;
      } catch { /* Build and browser diagnostics are scanned, never printed. */ }
    }
  });
  child.stderr!.on('data', (buffer: Buffer) => { run.output += buffer.toString(); });
  processes.add(run);
  return run;
}
async function stop(run: ProcessRun, signal: NodeJS.Signals = 'SIGTERM') {
  if (!run.closed) {
    run.child.kill(signal);
    try { await deadline(run.exit, 4000); }
    catch {
      run.child.kill('SIGKILL'); await deadline(run.exit, 3000);
      throw new CheckError('PROCESS_CLEANUP_TIMEOUT');
    }
  }
  assert.ok(safe(run.output));
}
async function start(path: string, browser = false) {
  const args = ['--import', 'tsx', resolve(PROJECT_ROOT, 'scripts/p6-server.ts'), path];
  if (browser) args.push(resolve(temp, 'browser/fixture.js'));
  const run = launch(args);
  await until(() => Boolean(run.origin || run.failure || run.closed));
  if (!run.origin) throw new CheckError(run.failure ?? 'FIXTURE_EXITED');
  const origin = run.origin;
  const api = createChatApi((input, init) => fetch(new URL(String(input), origin), {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  }));
  return { run, api, origin };
}
type Fixture = Awaited<ReturnType<typeof start>>;
function stream(fixture: Fixture, id: string, message: string) {
  const controller = new AbortController(); aborters.add(controller);
  const frames: ChatStreamEvent[] = [];
  let content = '';
  let firstResolve!: () => void;
  const first = new Promise<void>((done) => { firstResolve = done; });
  const outcome = fixture.api.stream({ conversationId: id, message }, controller.signal, (frame) => {
    frames.push(frame);
    if (frame.event === 'content_delta') { content += frame.data.delta; firstResolve(); }
  }).then(() => true, () => false).finally(() => { aborters.delete(controller); });
  return { controller, frames, first, outcome, content: () => content };
}
async function normal(fixture: Fixture, id: string) {
  const turn = stream(fixture, id, 'p6:normal');
  assert.equal(await deadline(turn.outcome), true);
  assert.equal(turn.frames.at(-1)?.event, 'message_complete');
  assert.equal(turn.frames.filter((frame) => frame.event === 'message_complete').length, 1);
  // Closing a reader after the terminal frame must preserve completed.
  turn.controller.abort();
  const saved = (await fixture.api.getConversation(id)).messages.at(-1)!;
  assert.equal(saved.status, 'completed'); assert.equal(saved.content, turn.content());
  assert.ok(saved.completedAt);
}
function outputFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? outputFiles(path) : [path];
  });
}
function sources(directory: string): string[] {
  return outputFiles(directory).filter((path) => /\.(?:ts|vue|css|sql|mjs)$/.test(path)
    && !/\/(?:auto-imports|components)\.d\.ts$/.test(path)).map((path) => relative(PROJECT_ROOT, path));
}
const sourcePaths = [
  ...sources(resolve(PROJECT_ROOT, 'apps/server/src')), ...sources(resolve(PROJECT_ROOT, 'apps/server/test')),
  ...sources(resolve(PROJECT_ROOT, 'apps/web/src')), ...sources(resolve(PROJECT_ROOT, 'apps/web/test')),
  ...sources(resolve(PROJECT_ROOT, 'packages/shared/src')), ...sources(resolve(PROJECT_ROOT, 'scripts')),
  'apps/web/vite.config.ts', 'package.json', 'apps/server/package.json', 'apps/web/package.json',
  'packages/shared/package.json', 'pnpm-lock.yaml',
].sort();
const sourceHashes = Object.fromEntries(sourcePaths.map((path) => [path,
  createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, path))).digest('hex'),
]));
const interrupt = () => { for (const controller of aborters) controller.abort(); for (const run of processes) if (!run.closed) run.child.kill('SIGTERM'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  assert.match(process.versions.node, /^22\./);
  stage = 'canary-production-and-browser-build';
  const builder = launch([resolve(PROJECT_ROOT, 'scripts/build-security.mjs'), temp]);
  assert.equal((await deadline(builder.exit, 30_000)).code, 0);
  assert.ok(safe(builder.output));
  const artifacts = [...outputFiles(resolve(temp, 'web')), ...outputFiles(resolve(temp, 'browser'))];
  assert.ok(artifacts.some((path) => path.endsWith('.js')));
  for (const path of artifacts) assert.ok(safe(readFileSync(path)));
  metrics.scannedArtifacts = artifacts.length;
  checks.push('synthetic-key-absent-from-production-and-browser-builds');

  stage = 'tcp-startup-and-completion-races';
  const path = resolve(temp, 'network.db');
  let fixture = await start(path);
  const conversation = await fixture.api.createConversation();
  for (let i = 0; i < 10; i++) await normal(fixture, conversation.id);
  assert.equal((await fixture.api.getConversation(conversation.id)).messages.length, 20);
  checks.push('ten-real-tcp-completion-close-cycles-no-lock-leak');

  stage = 'tcp-disconnect-concurrency';
  const held = stream(fixture, conversation.id, 'p6:cancel');
  await deadline(held.first);
  for (const [url, method, body] of [
    ['/api/chat/stream', 'POST', JSON.stringify({ conversationId: conversation.id, message: 'busy' })],
    [`/api/conversations/${conversation.id}`, 'DELETE', undefined],
  ] as const) {
    const response = await fetch(fixture.origin + url, { method, ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 409); assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await response.json() as { code: string }).code, 'CONVERSATION_BUSY');
  }
  const other = await fixture.api.createConversation(); await normal(fixture, other.id);
  held.controller.abort(); await deadline(held.outcome);
  await until(async () => (await fixture.api.getConversation(conversation.id)).messages.at(-1)?.status === 'cancelled');
  assert.equal((await fixture.api.getConversation(conversation.id)).messages.at(-1)?.content, held.content());
  await until(() => (fixture.run.stats?.cancelAborts ?? 0) > 0 && fixture.run.stats?.active === 0);
  checks.push('tcp-client-abort-cancels-provider-preserves-prefix', 'same-conversation-post-delete-409-other-conversation-proceeds');

  stage = 'tcp-timeout-and-provider-error';
  for (const [mode, code] of [['p6:timeout', 'UPSTREAM_TIMEOUT'], ['p6:error', 'UPSTREAM_ERROR']] as const) {
    const turn = stream(fixture, conversation.id, mode);
    assert.equal(await deadline(turn.outcome), true);
    const last = turn.frames.at(-1); assert.equal(last?.event, 'message_error');
    assert.ok(last?.event === 'message_error' && last.data.code === code);
    const message = (await fixture.api.getConversation(conversation.id)).messages.at(-1)!;
    assert.equal(message.status, 'failed'); assert.equal(message.content, turn.content()); assert.ok(message.content);
    assert.equal(turn.frames.some((frame) => frame.event === 'message_complete'), false);
  }
  checks.push('tcp-idle-timeout-and-upstream-failure-retain-prefix-without-false-complete');

  stage = 'tcp-paused-reader-backpressure';
  const pressureConversation = await fixture.api.createConversation();
  const slow = request(fixture.origin + '/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' } });
  // Keep errors handled after explicit destroy; this socket is owned by this check.
  const response = new Promise<import('node:http').IncomingMessage>((done, reject) => { slow.once('response', done); slow.once('error', reject); });
  slow.on('error', () => {});
  slow.end(JSON.stringify({ conversationId: pressureConversation.id, message: 'p6:pressure' }));
  try {
    const incoming = await deadline(response); incoming.pause(); incoming.on('error', () => {});
    assert.equal(incoming.statusCode, 200);
    await until(() => (fixture.run.stats?.writeFalse ?? 0) > 0 && (fixture.run.stats?.pressureChunks ?? 0) > 1);
    let stable = false;
    for (let i = 0; i < 12; i++) {
      const before = fixture.run.stats?.pressureChunks;
      await delay(120);
      const after = fixture.run.stats;
      if (after?.active === 1 && after.pressureChunks === before) { await delay(200);
        stable = fixture.run.stats?.active === 1 && fixture.run.stats?.pressureChunks === before;
        if (stable) break;
      }
    }
    assert.equal(stable, true);
    assert.ok(fixture.run.stats!.pressureChunks < 4096);
    assert.ok(fixture.run.stats!.maxBuffered <= 256 * 1024);
    metrics.pressureChunks = fixture.run.stats!.pressureChunks;
    metrics.maxBufferedBytes = fixture.run.stats!.maxBuffered;
    incoming.destroy(); slow.destroy();
  } finally { slow.destroy(); }
  await until(async () => (await fixture.api.getConversation(pressureConversation.id)).messages.at(-1)?.status === 'cancelled');
  assert.ok((await fixture.api.getConversation(pressureConversation.id)).messages.at(-1)?.content);
  await until(() => fixture.run.stats?.active === 0);
  checks.push('paused-real-tcp-reader-bounds-buffer-and-stops-provider-consumption');

  stage = 'tcp-sigkill-restart';
  const crash = stream(fixture, conversation.id, 'p6:crash'); await deadline(crash.first);
  await stop(fixture.run, 'SIGKILL');
  assert.equal(await deadline(crash.outcome), false);
  fixture = await start(path);
  const recovered = (await fixture.api.getConversation(conversation.id)).messages.at(-1)!;
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.content, crash.content()); assert.ok(recovered.completedAt);
  checks.push('sigkill-after-http-delta-restart-preserves-committed-chinese-emoji-prefix');

  stage = 'tcp-active-sigterm-cleanup';
  const shutdown = stream(fixture, conversation.id, 'p6:cancel'); await deadline(shutdown.first);
  const started = Date.now(); await stop(fixture.run); await deadline(shutdown.outcome);
  metrics.shutdownMs = Date.now() - started;
  assert.equal((await fixture.run.exit).code, 0); assert.equal(fixture.run.stats?.active, 0);
  fixture = await start(path);
  const cancelled = (await fixture.api.getConversation(conversation.id)).messages.at(-1)!;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.content, shutdown.content());
  await stop(fixture.run);
  checks.push('sigterm-cancels-active-provider-closes-database-and-exits-cleanly');

  stage = 'headless-browser-dom-and-real-fetch';
  const chrome = [process.env.P6_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => path && existsSync(path));
  if (!chrome) throw new CheckError('CHROME_NOT_FOUND');
  const browserFixture = await start(resolve(temp, 'browser.db'), true);
  const browser = launch(['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync',
    `--user-data-dir=${resolve(temp, 'chrome-profile')}`, browserFixture.origin], { executable: chrome });
  try {
    await until(() => Boolean(browserFixture.run.browserResult || browser.closed || browser.failure), 20_000);
  } catch { throw new CheckError('BROWSER_RESULT_TIMEOUT'); }
  browserDiagnostics = browserFixture.run.browserResult;
  if (!browserDiagnostics) {
    metrics.browserExitCode = (await browser.exit).code ?? -1;
    throw new CheckError(browser.failure ?? 'BROWSER_EXITED_BEFORE_RESULT');
  }
  assert.ok(safe(browser.output));
  if (browserDiagnostics.xssExecuted) throw new CheckError('BROWSER_XSS_EXECUTED');
  if (browserDiagnostics.activeElements !== 0) throw new CheckError('BROWSER_ACTIVE_HTML');
  if (!browserDiagnostics.linksSafe) throw new CheckError('BROWSER_UNSAFE_LINKS');
  if (!browserDiagnostics.networkCompleted || browserDiagnostics.completedRequests !== 5) throw new CheckError('BROWSER_API_FAILED');
  if (!browserDiagnostics.passed || browserDiagnostics.step !== 7) throw new CheckError('BROWSER_CHECK_INCOMPLETE');
  await stop(browser);
  await stop(browserFixture.run);
  metrics.browserRequests = browserFixture.run.stats?.browserRequests ?? 0;
  if (metrics.browserRequests !== 5) throw new CheckError('BROWSER_REQUEST_COUNT');
  if (browserFixture.run.stats?.credentialLeak !== false) throw new CheckError('BROWSER_CREDENTIAL_LEAK');
  if (browserFixture.run.stats?.browserBodyValid !== true) throw new CheckError('BROWSER_REQUEST_BODY_INVALID');
  checks.push('real-browser-malicious-markdown-no-active-dom-or-execution-safe-links',
    'real-browser-five-api-requests-no-key-and-stream-body-exact-contract');
  for (const run of processes) { assert.ok(safe(run.output)); if (run.stats) assert.equal(run.stats.credentialLeak, false); }
  checks.push('synthetic-key-absent-from-all-captured-process-logs');
  passed = true;
} catch (error) {
  errorCode = error instanceof CheckError ? error.code : 'P6_CHECK_FAILED';
} finally {
  for (const controller of aborters) controller.abort();
  const results = await Promise.allSettled([...processes].map((run) => stop(run)));
  if (results.some((result) => result.status === 'rejected')) { passed = false; errorCode = 'CLEANUP_FAILED'; }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(resolve(PROJECT_ROOT, report), `${JSON.stringify({ phase: 'P6', passed, checkedAt: new Date().toISOString(),
  nodeVersion: process.version, stage: passed ? 'complete' : stage, ...(errorCode ? { errorCode } : {}),
  checks, metrics, ...(browserDiagnostics ? { browserDiagnostics } : {}), sourceHashes, realModelCalls: 0,
  limitations: ['Controlled providers validate faults and lifecycle; real DeepSeek and interactive UI acceptance are recorded separately in P2/P4/P5.'],
}, null, 2)}\n`, { mode: 0o600 });
console.info(JSON.stringify({ passed, ...(errorCode ? { errorCode, stage } : {}), checks: checks.length, metrics,
  ...(browserDiagnostics ? { browserDiagnostics } : {}), report }));
if (!passed) process.exitCode = 1;
