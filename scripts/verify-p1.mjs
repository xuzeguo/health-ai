import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from '../apps/server/src/app.ts';
import { loadConfig } from '../apps/server/src/config/env.ts';

// Run from the server package through `pnpm verify:p1`. tsx is loaded as a Node
// import hook; unlike its CLI, this does not require an extra IPC socket.
const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = resolve(root, 'apps/web');
const webRequire = createRequire(resolve(webRoot, 'package.json'));
const vite = await import(pathToFileURL(webRequire.resolve('vite')).href);
const app = buildApp();
let web;
let passed = false;
let errorCode;
const reportPath = resolve(root, 'docs/p1-smoke-result.json');
const sha256 = (path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const checkedSources = [
  'apps/server/src/app.ts', 'apps/server/src/index.ts', 'apps/server/src/config/env.ts',
  'apps/web/vite.config.ts', 'apps/web/src/main.ts', 'apps/web/src/App.vue',
  'apps/web/src/views/ChatView.vue', 'pnpm-lock.yaml',
];
const sourceHashes = Object.fromEntries(checkedSources.map((path) => [path, sha256(path)]));

try {
  assert.match(process.versions.node, /^22\./, 'Use Node 22 for P1 verification');
  const config = loadConfig();
  assert.ok(isAbsolute(config.databasePath), 'Database path must resolve independently of working directory');

  const apiURL = await app.listen({ port: 0, host: '127.0.0.1' });
  const apiResponse = await fetch(`${apiURL}/api/conversations`);
  assert.equal(apiResponse.status, 404, 'P1 must not register fake business endpoints');

  web = await vite.createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    // This short-lived smoke test checks transforms, not dependency prebundling.
    // Do not start an asynchronous optimizer build that close() must cancel.
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, ws: false },
    logLevel: 'error',
  });
  await web.listen();
  const address = web.httpServer?.address();
  assert.ok(address && typeof address !== 'string', 'Vite must listen on a local TCP port');
  const webURL = `http://127.0.0.1:${address.port}`;
  const page = await fetch(webURL);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>HealthAI<\/title>/);
  for (const route of ['/src/main.ts', '/src/App.vue', '/src/views/ChatView.vue']) {
    const response = await fetch(`${webURL}${route}`);
    assert.equal(response.status, 200, `${route} must compile and be served`);
    const source = await response.text();
    assert.equal(source.includes('your_api_key'), false, 'No key placeholder in browser modules');
  }

  passed = true;
} catch (error) {
  errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STARTUP_CHECK_FAILED';
} finally {
  const results = await Promise.allSettled([web?.close(), app.close()]);
  if (results.some((result) => result.status === 'rejected')) {
    passed = false;
    errorCode = 'CLEANUP_FAILED';
  }
}

// Success is recorded only after both applications have closed cleanly.
writeFileSync(reportPath, `${JSON.stringify({
  phase: 'P1', passed, checkedAt: new Date().toISOString(), nodeVersion: process.version,
  checks: passed ? ['config-load', 'fastify-local-http', 'vite-local-http', 'vue-module-transform', 'clean-shutdown'] : [],
  ...(errorCode ? { errorCode } : {}), sourceHashes,
  limitations: ['HTTP/module smoke test; browser interaction is not automated'],
}, null, 2)}\n`, { mode: 0o600 });
if (passed) {
  console.info('P1 HTTP startup checks passed. Report saved to docs/p1-smoke-result.json (no credentials).');
} else {
  console.error(`P1 HTTP startup check failed (${errorCode}). Run pnpm verify:p1 in a local terminal if the environment blocks ports. No secrets were logged.`);
  process.exitCode = 1;
}
