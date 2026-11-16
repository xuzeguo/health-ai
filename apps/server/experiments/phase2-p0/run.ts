import OpenAI from 'openai';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPlaceholderApiKey, loadConfig, PROJECT_ROOT } from '../../src/config/env.js';
import { Extraction, ToolAccumulator, safeFailure, validateTool } from './contracts.js';

// Isolated synthetic experiments: never open the application database.
type Result = { id: string; passed: boolean; durationMs: number; detail: Record<string, unknown> };
const results: Result[] = [];
const calls: { input: number | null; output: number | null }[] = [];
let requestCount = 0;
let config: ReturnType<typeof loadConfig> | undefined;
let client: OpenAI;
const tool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function', function: { name: 'get_latest_measurement', description: 'Read the latest confirmed measurement.',
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] } },
};
function budget() { if (++requestCount > 12) throw new Error('BUDGET_EXCEEDED'); }
function usage(value: { prompt_tokens: number; completion_tokens: number } | null | undefined) {
  calls.push({ input: value?.prompt_tokens ?? null, output: value?.completion_tokens ?? null });
}
async function run(id: string, fn: () => Promise<Record<string, unknown>>) {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({ id, passed: true, durationMs: Math.round(performance.now() - started), detail });
  }
  catch (error) { results.push({ id, passed: false, durationMs: Math.round(performance.now() - started), detail: safeFailure(error) }); }
  const last = results.at(-1)!;
  console.info(JSON.stringify({ id, passed: last.passed, durationMs: last.durationMs, ...last.detail }));
}
const message: OpenAI.Chat.Completions.ChatCompletionMessageParam = { role: 'user', content:
  'Extract only JSON: synthetic measurement date 2026-10-01, weight 70.2 kg, body fat not provided. Keys date, weightKg, bodyFatRate. Missing fat must be null.' };
async function extract(format: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format']) {
  budget();
  const response = await client.chat.completions.create({ model: config!.model, messages: [message],
    response_format: format, max_tokens: 512, ...{ thinking: { type: 'disabled' } } });
  usage(response.usage);
  if (response.choices[0]?.finish_reason !== 'stop') throw new Error('INVALID_FINISH');
  const parsed = Extraction.parse(JSON.parse(response.choices[0].message.content ?? ''));
  if (parsed.date !== '2026-10-01' || parsed.weightKg !== 70.2 || parsed.bodyFatRate !== null) throw new Error('FIELD_MISMATCH');
  return { schemaValid: true, exactFields: 3 };
}

try {
  config = loadConfig();
  if (isPlaceholderApiKey(config.apiKey)) throw new Error('CONFIG_UNAVAILABLE');
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, organization: null, project: null,
    maxRetries: 0, timeout: 60_000, logLevel: 'off' });
  await run('T0-01-json', () => extract({ type: 'json_object' }));
  await run('T0-01-schema', () => extract({ type: 'json_schema', json_schema: {
    name: 'synthetic_measurement', strict: true, schema: z.toJSONSchema(Extraction),
  } }));
  await run('T0-03-tool-roundtrip', async () => {
    budget();
    const question: OpenAI.Chat.Completions.ChatCompletionMessageParam = { role: 'user', content: 'Use get_latest_measurement to find my latest weight. Do not guess.' };
    const response = await client.chat.completions.create({ model: config!.model, messages: [question], tools: [tool],
      tool_choice: { type: 'function', function: { name: 'get_latest_measurement' } }, max_tokens: 512,
      ...{ thinking: { type: 'disabled' } } });
    usage(response.usage);
    const choice = response.choices[0];
    if (choice?.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) throw new Error('NO_TOOL');
    const replies: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    for (const call of choice.message.tool_calls) {
      if (call.type !== 'function') throw new Error('UNKNOWN_TOOL_TYPE');
      validateTool(call.function.name, call.function.arguments);
      replies.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ weightKg: 70.2 }) });
    }
    budget();
    const answer = await client.chat.completions.create({ model: config!.model,
      messages: [question, choice.message, ...replies], max_tokens: 512, ...{ thinking: { type: 'disabled' } } });
    usage(answer.usage);
    if (answer.choices[0]?.finish_reason !== 'stop' || !answer.choices[0].message.content?.includes('70.2')) throw new Error('ROUNDTRIP_FAILED');
    return { toolCalls: replies.length, finalAnswerContainsFact: true };
  });
  await run('T0-04-stream-tools', async () => {
    budget();
    const stream = await client.chat.completions.create({ model: config!.model,
      messages: [{ role: 'user', content: 'Call get_latest_measurement now.' }], tools: [tool],
      tool_choice: { type: 'function', function: { name: 'get_latest_measurement' } },
      stream: true, stream_options: { include_usage: true }, max_tokens: 512, ...{ thinking: { type: 'disabled' } } });
    const aggregate = new ToolAccumulator();
    let chunks = 0;
    try {
      for await (const chunk of stream) {
        if (chunk.usage) usage(chunk.usage);
        const choice = chunk.choices[0];
        if (!choice) continue;
        for (const call of choice.delta.tool_calls ?? []) { aggregate.push(call); chunks++; }
        if (choice.finish_reason) aggregate.finish(choice.finish_reason);
      }
      return { toolCalls: aggregate.complete().length, argumentChunks: chunks };
    } finally { stream.controller.abort(); }
  });
  await run('T0-09-active-cancel', async () => {
    budget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let observed = false;
    try {
      const stream = await client.chat.completions.create({ model: config!.model, stream: true, max_tokens: 512,
        messages: [{ role: 'user', content: 'Count from 1 to 500 with one number per line.' }],
        ...{ thinking: { type: 'disabled' } } }, { signal: controller.signal });
      try {
        for await (const chunk of stream) {
          if (chunk.choices[0]?.delta.content) { observed = true; controller.abort(); break; }
        }
      } finally { stream.controller.abort(); }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { clearTimeout(timer); }
    if (!controller.signal.aborted || !observed) throw new Error('ACTIVE_CANCEL_NOT_OBSERVED');
    return { transportAborted: true, contentObservedBeforeAbort: observed, usageAvailable: false };
  });
} catch (error) { results.push({ id: 'configuration', passed: false, durationMs: 0, detail: safeFailure(error) }); }

const sourcePaths = ['apps/server/experiments/phase2-p0/run.ts', 'apps/server/experiments/phase2-p0/contracts.ts', 'apps/server/test/phase2-p0.test.ts', 'pnpm-lock.yaml'];
const report = {
  phase: 'F02-P0', overallPassed: false, checkedAt: new Date().toISOString(), node: process.version,
  model: config?.model, requestCount, completedUsageRecords: calls,
  results, pending: ['T0-03-multiple-rounds', 'T0-05-report-vision', 'T0-06-embedding', 'T0-07-vector-store', 'T0-08-langchain'],
  sourceHashes: Object.fromEntries(sourcePaths.map(p => [p, createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, p))).digest('hex')])),
};
const reportPath = resolve(PROJECT_ROOT, 'docs/phase2-p0-smoke-result.json');
const previous = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown> : null;
writeFileSync(reportPath, `${JSON.stringify({ ...report, previousAttempts: previous ? [previous] : [] }, null, 2)}\n`, { mode: 0o600 });
console.info(JSON.stringify({ phase: report.phase, overallPassed: false, report: 'docs/phase2-p0-smoke-result.json', requestCount,
  passedExperiments: results.filter(r => r.passed).length, failedExperiments: results.filter(r => !r.passed).length, pending: report.pending }));
if (results.some(r => !r.passed)) process.exitCode = 1;
