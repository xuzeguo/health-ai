import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatOpenAI } from '@langchain/openai';
import { Extraction, ToolAccumulator, validateTool, safeFailure } from '../experiments/phase2-p0/contracts.js';
import { reportFixtures, retrievalQuestions, knowledgeFixtures } from '../experiments/phase2-p0/dataset.js';
import { checkEvidence } from '../experiments/phase2-p0/evidence-contract.js';

test('P0 extraction accepts exact synthetic values and missing fat, rejects malformed or fabricated shapes', () => {
  const valid = { date: '2026-10-01', weightKg: 70.2, bodyFatRate: null };
  assert.deepEqual(Extraction.parse(valid), valid);
  for (const input of [{}, { ...valid, extra: 1 }, { ...valid, date: '2026-02-30' },
    { ...valid, weightKg: -1 }, { ...valid, bodyFatRate: 101 },
    { date: null, weightKg: null, bodyFatRate: null }]) assert.equal(Extraction.safeParse(input).success, false);
  assert.throws(() => JSON.parse('{"weightKg":'));
});

test('P0 tool allowlist rejects unknown names, malformed JSON and extra arguments', () => {
  assert.deepEqual(validateTool('get_latest_measurement', '{}'), {});
  for (const [name, args] of [['shell', '{}'], ['get_latest_measurement', '{'],
    ['get_latest_measurement', '{"sql":"delete from messages"}']]) {
    assert.throws(() => validateTool(name!, args!));
  }
});

test('P0 aggregates interleaved tool chunks, executes only after explicit tool finish, isolates turns', () => {
  const a = new ToolAccumulator();
  a.push({ index: 0, id: 'a', function: { name: 'get_latest_measurement', arguments: '{' } });
  a.push({ index: 1, id: 'b', function: { name: 'get_latest_measurement', arguments: '{}' } });
  a.push({ index: 0, function: { arguments: '}' } });
  assert.throws(() => a.complete());
  a.finish('tool_calls');
  assert.deepEqual(a.complete().map(x => x.id), ['a', 'b']);
  assert.throws(() => a.push({ index: 0, function: { arguments: ' ' } }));
  assert.throws(() => new ToolAccumulator().complete());
});

test('P0 rejects conflicting IDs/names, invalid indices, size limits, truncation and invalid finish', () => {
  for (const change of [{ index: 0, id: 'b' }, { index: 0, function: { name: 'shell' } }]) {
    const a = new ToolAccumulator();
    a.push({ index: 0, id: 'a', function: { name: 'get_latest_measurement', arguments: '{}' } });
    assert.throws(() => a.push(change));
  }
  assert.throws(() => new ToolAccumulator().push({ index: -1 }));
  assert.throws(() => new ToolAccumulator(4).push({ index: 0, function: { arguments: '身体' } }));
  for (const reason of ['length', 'stop', null]) assert.throws(() => new ToolAccumulator().finish(reason));
  const a = new ToolAccumulator();
  a.push({ index: 0, id: 'a', function: { name: 'get_latest_measurement', arguments: '{' } });
  a.finish('tool_calls');
  assert.throws(() => a.complete());
});

test('P0 error summaries never serialize upstream bodies, credentials or reasoning', () => {
  const secret = 'SYNTHETIC_PRIVATE_MARKER';
  const error = Object.assign(new Error(secret), { status: 400, code: secret, headers: { authorization: secret } });
  assert.deepEqual(safeFailure(error), { category: 'http_error', status: 400 });
  assert.equal(JSON.stringify(safeFailure(error)).includes(secret), false);
  assert.deepEqual(safeFailure(new DOMException(secret, 'AbortError')), { category: 'cancelled', status: null });
});

test('P0 LangChain passes model, disabled thinking, tools and abort signal to SDK transport', async () => {
  let requests = 0;
  const model = new ChatOpenAI({ model: 'deepseek-flash', apiKey: 'synthetic-key', maxRetries: 0,
    modelKwargs: { thinking: { type: 'disabled' } }, configuration: { baseURL: 'https://fixture.invalid',
      fetch: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'deepseek-flash');
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.tools[0].function.name, 'get_latest_measurement');
        return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'get_latest_measurement', arguments: '{}' } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      } } });
  const result = await model.bindTools([{ type: 'function', function: { name: 'get_latest_measurement',
    parameters: { type: 'object', properties: {}, required: [] } } }]).invoke('synthetic question');
  assert.equal(requests, 1);
  assert.equal(result.tool_calls?.[0]?.id, 'call-fixture');
  assert.equal(result.tool_calls?.[0]?.name, 'get_latest_measurement');
  assert.equal(result.usage_metadata?.input_tokens, 10);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(model.invoke('cancelled', { signal: controller.signal }));
  assert.equal(requests, 1);
});

test('P0 LangChain cancels a silent transport within deadline with no automatic retry', { timeout: 3000 }, async () => {
  let requests = 0;
  let transportAborted = false;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const model = new ChatOpenAI({ model: 'deepseek-flash', apiKey: 'synthetic-key', maxRetries: 0,
    configuration: { baseURL: 'https://fixture.invalid', fetch: async (_url, init) => {
      requests++;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { transportAborted = true; reject(new DOMException('fixture timeout', 'AbortError')); };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    } } });
  const controller = new AbortController();
  const invocation = model.invoke('synthetic silent request', { signal: controller.signal });
  const failure = assert.rejects(invocation);
  await started;
  controller.abort(new DOMException('Deadline', 'TimeoutError'));
  await failure;
  // LangChain may reject at its runnable boundary before the SDK finishes cleanup.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(transportAborted, true);
});

test('P0 synthetic dataset has fixed unique labels, separate answerable/negative groups and two layouts', () => {
  assert.equal(reportFixtures.length, 20);
  assert.equal(new Set(reportFixtures.map(x => x.id)).size, 20);
  assert.equal(new Set(reportFixtures.map(x => x.layout)).size, 2);
  assert.equal(new Set(reportFixtures.map(x => x.scenario)).size, 5);
  assert.equal(reportFixtures.filter(x => x.expectedOutcome === 'reviewable').length, 12);
  assert.ok(reportFixtures.filter(x => x.scenario === 'missing_fat').every(x => x.expected.bodyFatRate === null));
  assert.equal(retrievalQuestions.length, 30);
  assert.equal(new Set(retrievalQuestions.map(x => x.id)).size, 30);
  assert.equal(retrievalQuestions.filter(x => x.documentId === null).length, 6);
  for (const q of retrievalQuestions.filter(x => x.documentId !== null)) {
    assert.ok(knowledgeFixtures.some(x => x.id === q.documentId));
  }
});

test('P0 evidence decision refuses unknown sources, inconsistent status, duplicates and injected fields', () => {
  const allowed = new Set(['fat']);
  assert.deepEqual(checkEvidence({ supported: false, sourceIds: [] }, allowed), { supported: false, sourceIds: [] });
  assert.deepEqual(checkEvidence({ supported: true, sourceIds: ['fat'] }, allowed), { supported: true, sourceIds: ['fat'] });
  for (const input of [{ supported: true, sourceIds: [] }, { supported: false, sourceIds: ['fat'] },
    { supported: true, sourceIds: ['unknown'] }, { supported: true, sourceIds: ['fat', 'fat'] },
    { supported: true, sourceIds: ['fat'], sql: 'delete all' }]) assert.throws(() => checkEvidence(input, allowed));
});
