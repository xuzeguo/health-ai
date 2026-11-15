import { buildApp } from './app.js';
import { EnvironmentError, isPlaceholderApiKey, loadConfig } from './config/env.js';
import { DeepSeekProvider } from './providers/deepseek.provider.js';

try {
  const config = loadConfig();
  const app = buildApp({
    databasePath: config.databasePath,
    provider: isPlaceholderApiKey(config.apiKey) ? undefined : new DeepSeekProvider(config),
    model: config.model,
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }

  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.info(`HealthAI API listening on http://127.0.0.1:${config.port}`);
} catch (error) {
  // Config errors report field names only; startup errors are never dumped raw.
  console.error(error instanceof EnvironmentError ? error.message : '服务启动失败，请检查端口、依赖和本地环境');
  process.exitCode = 1;
}
