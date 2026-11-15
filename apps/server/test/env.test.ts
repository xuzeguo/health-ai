import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { EnvironmentError, isPlaceholderApiKey, parseEnvironment, PROJECT_ROOT } from '../src/config/env.js';

test('environment defaults are resolved against repository root', () => {
  const config = parseEnvironment({ DEEPSEEK_API_KEY: 'test-key-only' });
  assert.equal(config.port, 3000);
  assert.equal(config.model, 'deepseek-flash');
  assert.equal(config.baseURL, 'https://api.deepseek.com');
  assert.equal(config.databasePath, resolve(PROJECT_ROOT, 'data/health-ai.db'));
});

test('missing key reports its name without reflecting other environment values', () => {
  assert.throws(
    () => parseEnvironment({ PORT: 'secret-marker-not-a-port' }),
    (error: unknown) => error instanceof EnvironmentError
      && error.fields.includes('DEEPSEEK_API_KEY')
      && error.fields.includes('PORT')
      && !error.message.includes('secret-marker'),
  );
});

test('rejects unsafe or Markdown URLs and invalid port without echoing input', () => {
  for (const url of ['[https://api.deepseek.com](https://api.deepseek.com)', 'file:///tmp/api', 'https://user:secret@example.com']) {
    assert.throws(
      () => parseEnvironment({ DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: url }),
      (error: unknown) => error instanceof EnvironmentError
        && error.fields.includes('DEEPSEEK_BASE_URL') && !error.message.includes(url),
    );
  }
  for (const port of ['0', '65536', '3.5', 'invalid']) {
    assert.throws(() => parseEnvironment({ DEEPSEEK_API_KEY: 'test-key', PORT: port }), EnvironmentError);
  }
});

test('explicit configuration preserves key privately and accepts absolute data path', () => {
  const absolutePath = resolve(PROJECT_ROOT, 'data/custom.db');
  const config = parseEnvironment({
    DEEPSEEK_API_KEY: 'test-key-not-real',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:8080/v1',
    DEEPSEEK_MODEL: 'test-model',
    PORT: '3100',
    DATABASE_URL: absolutePath,
  });
  assert.equal(config.apiKey, 'test-key-not-real');
  assert.equal(config.port, 3100);
  assert.equal(config.databasePath, absolutePath);
});

test('real connectivity check can reject placeholders without rejecting custom key formats', () => {
  for (const key of ['', 'your_api_key', ' YOUR_API_KEY ', 'sk-your-key', 'replace-me', '<your-key>']) {
    assert.equal(isPlaceholderApiKey(key), true);
  }
  assert.equal(isPlaceholderApiKey('test-key-not-a-placeholder'), false);
});
