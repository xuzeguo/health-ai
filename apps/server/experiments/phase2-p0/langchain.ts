import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { loadConfig, isPlaceholderApiKey, PROJECT_ROOT } from '../../src/config/env.js';
import { Extraction, safeFailure } from './contracts.js';

const config = loadConfig();
if (isPlaceholderApiKey(config.apiKey)) throw new Error('CONFIG_UNAVAILABLE');
const model = new ChatOpenAI({ model: config.model, apiKey: config.apiKey, maxRetries: 0, timeout: 60_000, maxTokens: 512,
  modelKwargs: { thinking: { type: 'disabled' } }, configuration: { baseURL: config.baseURL, organization: null, project: null } });
const tool = { type: 'function' as const, function: { name: 'get_latest_measurement', description: 'Read latest confirmed weight.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } };
const results: { id: string; passed: boolean; durationMs: number; detail: Record<string, unknown> }[] = [];
const usages: { input: number | null; output: number | null }[] = [];
let calls = 0;
async function check(id: string, fn: () => Promise<Record<string, unknown>>) {
  const start = performance.now();
  try { const detail = await fn(); results.push({ id, passed: true, durationMs: Math.round(performance.now() - start), detail }); }
  catch (e) { results.push({ id, passed: false, durationMs: Math.round(performance.now() - start), detail: safeFailure(e) }); }
  console.info(JSON.stringify(results.at(-1)));
}
// Exactly six requests maximum; aborting stream has unknown billed usage.
await check('T0-08-prompt-json', async () => {
  calls++;
  const prompt = ChatPromptTemplate.fromMessages([['system', 'Return only JSON, do not invent missing fields.'], ['human', '{input}']]);
  const chain = prompt.pipe(model.withStructuredOutput(Extraction, { method: 'jsonMode', name: 'measurement' }));
  const data = await chain.invoke({ input: 'Synthetic: date 2026-10-01, weightKg 70.2, bodyFatRate not available. Use null for fat.' });
  if (data.date !== '2026-10-01' || data.weightKg !== 70.2 || data.bodyFatRate !== null) throw new Error('FIELD_MISMATCH');
  return { exactFields: 3, usageAvailable: false };
});
await check('T0-08-stream-tools-roundtrip', async () => {
  calls++;
  const question = 'Call get_latest_measurement and then report its exact weight.';
  const stream = await model.bindTools([tool], { tool_choice: 'get_latest_measurement' }).stream(question);
  let aggregate: AIMessageChunk | undefined;
  let chunks = 0;
  for await (const chunk of stream) { aggregate = aggregate ? aggregate.concat(chunk) : chunk; chunks++; }
  const call = aggregate?.tool_calls?.[0];
  if (!call?.id || call.name !== 'get_latest_measurement' || Object.keys(call.args).length) throw new Error('INVALID_TOOL');
  usages.push({ input: aggregate?.usage_metadata?.input_tokens ?? null, output: aggregate?.usage_metadata?.output_tokens ?? null });
  calls++;
  const answer = await model.invoke([['human', question], aggregate!, new ToolMessage({ tool_call_id: call.id, content: '{"weightKg":70.2}' })]);
  if (typeof answer.content !== 'string' || !answer.content.includes('70.2')) throw new Error('ROUNDTRIP_FAILED');
  usages.push({ input: answer.usage_metadata?.input_tokens ?? null, output: answer.usage_metadata?.output_tokens ?? null });
  return { chunks, toolResultReturned: true, finalFactPresent: true };
});
await check('T0-08-active-cancel', async () => {
  calls++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let content = false;
  try {
    const stream = await model.stream('Count from 1 to 500, one number per line.', { signal: controller.signal });
    for await (const chunk of stream) {
      if (chunk.content) { content = true; controller.abort(); break; }
    }
  } catch (e) { if (!controller.signal.aborted) throw e; }
  finally { clearTimeout(timer); }
  if (!controller.signal.aborted || !content) throw new Error('ACTIVE_CANCEL_NOT_OBSERVED');
  return { contentObserved: true, aborted: true, usageAvailable: false };
});
await check('T0-01-minimal-native-schema', async () => {
  calls++;
  const sdk = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 0, logLevel: 'off' });
  const result = await sdk.chat.completions.create({ model: config.model, max_tokens: 128,
    messages: [{ role: 'user', content: 'Return JSON with weightKg equal to 70.2.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'weight', strict: true,
      schema: { type: 'object', properties: { weightKg: { type: 'number' } }, required: ['weightKg'], additionalProperties: false } } },
    ...{ thinking: { type: 'disabled' } } });
  usages.push({ input: result.usage?.prompt_tokens ?? null, output: result.usage?.completion_tokens ?? null });
  if (result.choices[0]?.finish_reason !== 'stop' || JSON.parse(result.choices[0].message.content ?? '{}').weightKg !== 70.2) throw new Error('SCHEMA_FAILED');
  return { minimalSchemaSupported: true };
});

const reportPath = resolve(PROJECT_ROOT, 'docs/phase2-p0-smoke-result.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
writeFileSync(reportPath, JSON.stringify({ ...report, langchain: { versions: { core: '1.4.1', openai: '1.8.4' },
  checkedAt: new Date().toISOString(), requestCount: calls, usages, results } }, null, 2) + '\n', { mode: 0o600 });
if (results.some(r => !r.passed)) process.exitCode = 1;
