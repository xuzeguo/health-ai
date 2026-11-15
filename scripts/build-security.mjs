import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = resolve(root, 'apps/web');
const webRequire = createRequire(resolve(webRoot, 'package.json'));
const destination = process.argv[2];
if (!destination) throw new Error('Temporary destination required');
try {
  const vite = await import(pathToFileURL(webRequire.resolve('vite')).href);
  const common = { root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), mode: 'p6-security', logLevel: 'silent' };
  await vite.build({ ...common, build: { outDir: resolve(destination, 'web'), emptyOutDir: true } });
  await vite.build({ ...common, build: { outDir: resolve(destination, 'browser'), emptyOutDir: true,
    lib: { entry: resolve(root, 'scripts/p6-browser.ts'), name: 'P6Security', formats: ['iife'], fileName: () => 'fixture.js' } } });
  console.info(JSON.stringify({ passed: true }));
} catch {
  console.info(JSON.stringify({ passed: false, code: 'SECURITY_BUILD_FAILED' }));
  process.exitCode = 1;
}
