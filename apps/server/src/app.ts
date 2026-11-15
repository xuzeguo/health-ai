import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { ZodError } from 'zod';
import { AppError } from './common/errors.js';
import { openDatabase } from './database/db.js';
import { ChatRepository } from './modules/chat/chat.repository.js';
import { registerChatRoutes } from './modules/chat/chat.route.js';
import { ChatService, type StreamOptions } from './modules/chat/chat.service.js';

interface BuildAppOptions extends StreamOptions {
  databasePath?: string;
  database?: Database.Database;
  now?: () => number;
}

export function buildApp(options: BuildAppOptions = {}) {
  // Production passes the configured path; tests default to isolated in-memory DBs.
  const database = options.database ?? openDatabase(options.databasePath ?? ':memory:');
  const repository = new ChatRepository(database, options.now);
  repository.recoverInterruptedMessages();
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    requestTimeout: 30_000,
  });

  app.setErrorHandler((error, request, reply) => {
    const clientError = error instanceof ZodError || (error instanceof Error
      && 'statusCode' in error && typeof error.statusCode === 'number'
      && error.statusCode >= 400 && error.statusCode < 500);
    const normalized = error instanceof AppError ? error : new AppError(clientError ? 'INVALID_PARAM' : 'INTERNAL_ERROR');
    const { statusCode: status, code, message } = normalized;
    // The raw Error may contain upstream headers, payloads, or API credentials.
    if (status >= 500) console.error(JSON.stringify({ requestId: request.id, code }));
    void reply.code(status).send({ code, message });
  });

  if (!options.database) app.addHook('onClose', async () => { database.close(); });
  const service = new ChatService(repository, options);
  app.addHook('preClose', async () => service.shutdown());
  registerChatRoutes(app, service);

  return app;
}
