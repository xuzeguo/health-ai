import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChatService } from './chat.service.js';
import { SseWriter } from '../../common/sse.js';

const empty = z.object({}).strict();
const noBody = z.union([z.undefined(), empty]);
const idParams = z.object({ id: z.string().trim().min(1) }).strict();
const streamBody = z.object({
  conversationId: z.string().trim().min(1),
  message: z.string().trim().min(1).max(8000),
}).strict();

export function registerChatRoutes(app: FastifyInstance, service: ChatService): void {
  app.post('/api/chat/stream', async (request, reply) => {
    empty.parse(request.query);
    const { conversationId, message } = streamBody.parse(request.body);
    const turn = service.prepareTurn(conversationId, message);
    reply.hijack();
    const writer = new SseWriter(reply.raw, () => turn.controller.abort());
    let started = false;
    try {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      started = true;
      await service.runTurn(turn, writer);
    } catch {
      // A synchronous header/setup failure still owns an inserted turn/lock.
      // Settle it without attempting another write to the broken response.
      if (!started) {
        turn.controller.abort();
        await service.runTurn(turn, { async send() { throw new Error('Response unavailable'); } });
      }
      reply.raw.destroy();
    } finally {
      writer.close();
    }
  });

  app.get('/api/conversations', async (request) => {
    empty.parse(request.query);
    return { conversations: service.listConversations() };
  });

  app.post('/api/conversations', async (request, reply) => {
    noBody.parse(request.body);
    empty.parse(request.query);
    return reply.code(201).send({ conversation: service.createConversation() });
  });

  app.get('/api/conversations/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    empty.parse(request.query);
    return service.getConversation(id);
  });

  app.delete('/api/conversations/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    noBody.parse(request.body);
    empty.parse(request.query);
    service.deleteConversation(id);
    return { ok: true };
  });
}
