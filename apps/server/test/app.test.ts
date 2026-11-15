import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/common/errors.js';

test('application initializes without requiring a network or model request', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/conversations' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { conversations: [] });
});

test('application errors retain only their public error code and message', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  app.get('/test-only', async () => { throw new AppError('INVALID_PARAM'); });
  const response = await app.inject({ method: 'GET', url: '/test-only' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { code: 'INVALID_PARAM', message: '输入有误，请检查后重试' });
});

test('unknown error payload and upstream headers are not reflected to client or log', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'error', (message: unknown) => { output.push(String(message)); });
  const app = buildApp();
  t.after(() => app.close());
  app.get('/test-only', async () => {
    throw Object.assign(new Error('test-secret-do-not-log'), { headers: { authorization: 'test-secret-do-not-log' } });
  });
  const response = await app.inject({ method: 'GET', url: '/test-only' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { code: 'INTERNAL_ERROR', message: '服务异常，请重试' });
  assert.equal(response.body.includes('test-secret'), false);
  assert.equal(output.length, 1);
  assert.equal(output.join('').includes('test-secret'), false);
});
