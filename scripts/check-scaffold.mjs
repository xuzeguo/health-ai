import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const packages = ['package.json', 'apps/web/package.json', 'apps/server/package.json', 'packages/shared/package.json'];
for (const file of packages) json(file);

const web = json('apps/web/package.json');
const server = json('apps/server/package.json');
const shared = json('packages/shared/package.json');
assert.equal(web.dependencies['@health-ai/shared'], 'workspace:*');
assert.equal(server.dependencies['@health-ai/shared'], 'workspace:*');
assert.equal(shared.exports['.'], './src/index.ts');
assert.equal(Object.keys(shared.dependencies ?? {}).length, 0);
assert.equal(json('tsconfig.base.json').compilerOptions.strict, true);

for (const file of [
  'WORK_PLAN.md', 'docs/DECISIONS.md', '.env.example', '.gitignore',
  'pnpm-workspace.yaml', 'apps/web/src/App.vue', 'apps/web/src/views/ChatView.vue',
  'apps/server/src/app.ts', 'apps/server/src/index.ts', 'apps/server/src/config/env.ts',
]) assert.ok(existsSync(resolve(root, file)), `Missing ${file}`);

const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8').split('\n');
for (const item of ['.env', 'data/', 'node_modules/', 'dist/']) assert.ok(ignore.includes(item));
console.info('Scaffold structure checks passed. Dependency installation, typechecking and runtime checks are separate gates.');
