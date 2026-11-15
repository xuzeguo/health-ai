import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ChatStreamEvent } from '@health-ai/shared';
import { buildApp } from '../src/app.js';
import { SseWriter } from '../src/common/sse.js';
import { openDatabase } from '../src/database/db.js';
import { ChatRepository } from '../src/modules/chat/chat.repository.js';
import { registerChatRoutes } from '../src/modules/chat/chat.route.js';
import { ChatService } from '../src/modules/chat/chat.service.js';
import type { ModelProvider } from '../src/providers/model-provider.js';

const normal: ModelProvider = { name: 'normal', async *chatStream() {
  yield { type: 'content', delta: 'saved' };
  yield { type: 'done', fullContent: 'saved' };
} };

test('repeated completion/close races finalize once and release every conversation reservation', async () => {
  const db = openDatabase(':memory:');
  const repo = new ChatRepository(db);
  const service = new ChatService(repo, { provider: normal });
  const id = repo.createConversation().id;
  try {
    for (let i = 0; i < 40; i++) {
      const turn = service.prepareTurn(id, 'test');
      const frames: ChatStreamEvent[] = [];
      await service.runTurn(turn, { async send(frame) {
        frames.push(frame);
        if (frame.event === 'message_complete') { turn.controller.abort(); throw new Error('Client closed immediately'); }
      } });
      assert.equal(repo.getMessages(id).at(-1)?.status, 'completed');
      assert.equal(frames.filter((frame) => frame.event === 'message_complete').length, 1);
      assert.equal(frames.some((frame) => frame.event === 'message_error' || frame.event === 'message_cancelled'), false);
    }
    assert.equal(repo.getMessages(id).length, 80);
    await service.shutdown();
    assert.throws(() => service.prepareTurn(id, 'late request'), { code: 'INTERNAL_ERROR' });
  } finally { await service.shutdown(); db.close(); }
});

test('transport iterator cleanup failure cannot prevent settlement or leak the conversation lock', async () => {
  const provider: ModelProvider = { name: 'broken-cleanup', chatStream() {
    let step = 0;
    return { [Symbol.asyncIterator]() { return {
      async next() { return { done: false as const, value: step++ === 0
        ? { type: 'content' as const, delta: 'saved' } : { type: 'done' as const, fullContent: 'saved' } }; },
      return() { throw new Error('Private transport cleanup failure'); },
    }; } };
  } };
  const db = openDatabase(':memory:');
  const repo = new ChatRepository(db);
  const service = new ChatService(repo, { provider });
  const id = repo.createConversation().id;
  try {
    await service.runTurn(service.prepareTurn(id, 'test'), { async send() {} });
    await service.shutdown();
    assert.equal(repo.getMessages(id)[1]?.status, 'completed');
    service.deleteConversation(id);
  } finally { db.close(); }
});

test('header setup failure after atomic insert still settles the turn and releases its lock', async () => {
  const db = openDatabase(':memory:');
  const repo = new ChatRepository(db);
  const service = new ChatService(repo, { provider: normal });
  const id = repo.createConversation().id;
  let handler: ((request: unknown, reply: unknown) => Promise<void>) | undefined;
  const registration = {
    post(path: string, callback: typeof handler) { if (path === '/api/chat/stream') handler = callback; },
    get() {}, delete() {},
  } as unknown as FastifyInstance;
  registerChatRoutes(registration, service);
  const events = new EventEmitter();
  const raw = Object.assign(events, {
    destroyed: false, writableEnded: false,
    writeHead() { throw new Error('Private header/socket failure'); },
    destroy() { this.destroyed = true; events.emit('close'); },
    end() { this.writableEnded = true; events.emit('close'); },
  });
  try {
    assert.ok(handler);
    await handler({ query: {}, body: { conversationId: id, message: 'test' } }, { raw, hijack() {} });
    assert.equal(raw.destroyed, true);
    assert.equal(repo.getMessages(id)[1]?.status, 'cancelled');
    service.deleteConversation(id);
  } finally { await service.shutdown(); db.close(); }
});

test('writer lifecycle removes heartbeat/close/error/drain listeners across repeated uses', async () => {
  for (let i = 0; i < 50; i++) {
    const events = new EventEmitter();
    const raw = Object.assign(events, {
      destroyed: false, writableEnded: false,
      write() { return true; },
      end() { this.writableEnded = true; events.emit('close'); },
    });
    let cancelled = false;
    const writer = new SseWriter(raw as unknown as ServerResponse, () => { cancelled = true; }, 2);
    await writer.send({ event: 'message_start', data: { messageId: 'm' } });
    writer.close();
    writer.close();
    assert.equal(cancelled, false);
    for (const event of ['close', 'error', 'drain']) assert.equal(raw.listenerCount(event), 0);
  }
});

test('SIGKILL of independent SQLite writer preserves committed prefix and startup changes streaming to failed', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-ai-kill-'));
  const path = join(dir, 'chat.db');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {openDatabase} from './src/database/db.ts';
    import {ChatRepository} from './src/modules/chat/chat.repository.ts';
    const db=openDatabase(process.argv[1]); const repo=new ChatRepository(db);
    const c=repo.createConversation(); const turn=repo.createTurn(c.id,'synthetic question','test');
    repo.appendMessageContent(turn.assistant.id,'已提交中文🙂');
    console.log(JSON.stringify({id:c.id})); setInterval(()=>{},1000);
  `, path], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Child readiness timeout')), 5000);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('\n')) { clearTimeout(timer); resolve(output.split('\n')[0]!); }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Child failed')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before readiness')); });
    });
    const { id } = JSON.parse(ready) as { id: string };
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal((await exited).signal, 'SIGKILL');
    app = buildApp({ databasePath: path });
    const result = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const { messages } = result.json();
    assert.equal(messages[1].content, '已提交中文🙂');
    assert.equal(messages[1].status, 'failed');
    assert.ok(messages[1].completedAt);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
