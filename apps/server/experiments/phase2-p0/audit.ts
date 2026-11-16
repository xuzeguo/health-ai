import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, PROJECT_ROOT } from '../../src/config/env.js';

const reportPath = resolve(PROJECT_ROOT, 'docs/phase2-p0-smoke-result.json');
const raw = readFileSync(reportPath, 'utf8');
const report = JSON.parse(raw) as Record<string, unknown>;
const key = loadConfig().apiKey;
const bannedKeys = new Set(['apiKey', 'authorization', 'messages', 'reasoning_content', 'base64', 'rawResponse', 'rawReport', 'extractedText']);
function inspect(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(inspect);
  if (typeof value === 'object' && value !== null) return Object.entries(value).every(([k, v]) => !bannedKeys.has(k) && inspect(v));
  return true;
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(directory, e.name)) : [join(directory, e.name)]);
}
const artifacts = files(resolve(PROJECT_ROOT, 'apps/web/dist'));
const secretsAbsent = !raw.includes(key) && artifacts.every(p => !readFileSync(p, 'utf8').includes(key));
const privateMode = (statSync(reportPath).mode & 0o777) === 0o600;
const sourcePaths = ['apps/server/experiments/phase2-p0/contracts.ts', 'apps/server/experiments/phase2-p0/evidence-contract.ts',
  'apps/server/experiments/phase2-p0/local-capabilities.m', 'apps/server/experiments/phase2-p0/local.ts',
  'apps/server/experiments/phase2-p0/vector-store.ts', 'apps/server/experiments/phase2-p0/dataset.ts',
  'apps/server/experiments/phase2-p0/extraction.ts', 'apps/server/experiments/phase2-p0/evidence.ts',
  'apps/server/test/phase2-p0.test.ts', 'apps/server/test/phase2-vector.test.ts', 'pnpm-lock.yaml'];
const audit = { checkedAt: new Date().toISOString(), passed: secretsAbsent && inspect(report) && privateMode,
  keyAbsent: secretsAbsent, privateMode, forbiddenRawFieldsAbsent: inspect(report), scannedBuildArtifacts: artifacts.length,
  sourceHashes: Object.fromEntries(sourcePaths.map(p => [p, createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, p))).digest('hex')])) };
writeFileSync(reportPath, JSON.stringify({ ...report, audit }, null, 2) + '\n', { mode: 0o600 });
console.info(JSON.stringify({ id: 'T0-10-artifact-audit', ...audit, sourceHashes: undefined }));
if (!audit.passed) process.exitCode = 1;
