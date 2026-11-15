import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Anchored to this module, not process.cwd(); both root and package scripts agree.
export const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().trim().min(1),
  DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com').refine((value) => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol)
        && !url.username && !url.password && !/[\[\]()\s]/.test(value);
    } catch {
      return false;
    }
  }),
  DEEPSEEK_MODEL: z.string().trim().min(1).default('deepseek-flash'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().trim().min(1).default('./data/health-ai.db'),
});

export class EnvironmentError extends Error {
  constructor(public readonly fields: string[]) {
    super(`环境变量缺失或无效：${fields.join(', ')}`);
    this.name = 'EnvironmentError';
  }
}

export interface AppConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  port: number;
  databasePath: string;
}

export function parseEnvironment(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Never print Zod's complete issue/input objects: they may contain the key.
    throw new EnvironmentError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  const env = result.data;
  return {
    apiKey: env.DEEPSEEK_API_KEY,
    baseURL: env.DEEPSEEK_BASE_URL,
    model: env.DEEPSEEK_MODEL,
    port: env.PORT,
    databasePath: resolve(PROJECT_ROOT, env.DATABASE_URL),
  };
}

export function loadConfig(): AppConfig {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) loadEnvFile(envPath);
  return parseEnvironment(process.env);
}

export function isPlaceholderApiKey(value: string): boolean {
  const key = value.trim();
  return !key || /^(?:your[_-].*|sk-your-key.*|replace[_-]?me|changeme|<.*>)$/i.test(key);
}
