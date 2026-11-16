import OpenAI from 'openai';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, isPlaceholderApiKey, PROJECT_ROOT } from '../../src/config/env.js';
import { validateTool, safeFailure } from './contracts.js';

// Separate three-request experiment: complete two consecutive tool-result rounds.
const config = loadConfig();
if (isPlaceholderApiKey(config.apiKey)) throw new Error('CONFIG_UNAVAILABLE');
const sdk = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0, timeout: 60_000, logLevel: 'off' });
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{ type: 'function', function: {
  name: 'get_latest_measurement', description: 'Get latest weight.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
} }];
const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Read my latest measurement, and report exact weight.' }];
const usages: { input: number | null; output: number | null }[] = [];
let count = 0;
const started = performance.now();
let result: Record<string, unknown>;
try {
  for (let round = 0; round < 2; round++) {
    if (round) history.push({ role: 'user', content: 'Read the measurement once more to verify, using the tool again.' });
    count++;
    const response = await sdk.chat.completions.create({ model: config.model, messages: history, tools,
      tool_choice: { type: 'function', function: { name: 'get_latest_measurement' } }, max_tokens: 256,
      ...{ thinking: { type: 'disabled' } } });
    usages.push({ input: response.usage?.prompt_tokens ?? null, output: response.usage?.completion_tokens ?? null });
    const choice = response.choices[0];
    if (choice?.finish_reason !== 'tool_calls' || choice.message.tool_calls?.length !== 1) throw new Error('TOOL_ROUND_INVALID');
    history.push(choice.message);
    const call = choice.message.tool_calls[0]!;
    if (call.type !== 'function') throw new Error('TOOL_TYPE');
    validateTool(call.function.name, call.function.arguments);
    history.push({ role: 'tool', tool_call_id: call.id, content: '{"weightKg":70.2}' });
  }
  count++;
  const response = await sdk.chat.completions.create({ model: config.model, messages: history, max_tokens: 256,
    ...{ thinking: { type: 'disabled' } } });
  usages.push({ input: response.usage?.prompt_tokens ?? null, output: response.usage?.completion_tokens ?? null });
  if (response.choices[0]?.finish_reason !== 'stop' || !response.choices[0].message.content?.includes('70.2')) throw new Error('FINAL_FACT_MISSING');
  result = { passed: true, consecutiveToolRounds: 2, finalFactPresent: true };
} catch (e) { result = { passed: false, ...safeFailure(e) }; process.exitCode = 1; }
const reportPath = resolve(PROJECT_ROOT, 'docs/phase2-p0-smoke-result.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
const multiRound = { ...result, durationMs: Math.round(performance.now() - started), requestCount: count, usages };
writeFileSync(reportPath, JSON.stringify({ ...report, multiRound }, null, 2) + '\n', { mode: 0o600 });
console.info(JSON.stringify({ id: 'T0-03-multiple-rounds', ...multiRound }));
