import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { RunnableLambda } from '@langchain/core/runnables';
import { ExperimentVectorStore } from './vector-store.js';
import { knowledgeFixtures, retrievalQuestions, datasetVersion } from './dataset.js';
import { PROJECT_ROOT } from '../../src/config/env.js';

const executable = process.argv[2];
if (!executable || !existsSync(executable)) throw new Error('LOCAL_PROBE_BINARY_REQUIRED');
const directory = mkdtempSync(join(tmpdir(), 'healthai-local-evaluation-'));
const results: Record<string, unknown>[] = [];
function invoke(mode: string, path: string) {
  const r = spawnSync(executable!, [mode, path], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const data: unknown = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
  return { exit: r.status, data };
}
try {
  const fixtureResult = invoke('fixtures', directory);
  results.push({ id: 'local-render', passed: fixtureResult.exit === 0 });
  for (let i = 1; i <= 2; i++) {
    const r = invoke('ocr', join(directory, `report-${i}.png`));
    const ocr = r.data as { lines?: string[] } | null;
    const text = ocr?.lines?.join('\n') ?? '';
    const expected = i === 1 ? ['2026-10-01', '70.2', '18.5', '32.1'] : ['2026-10-15', '69.8', '18.0', '32.3'];
    results.push({ id: `T0-05-system-ocr-${i}`, passed: r.exit === 0 && expected.every(v => text.includes(v)),
      exit: r.exit, recognizedLines: ocr?.lines?.length ?? 0, matchedFields: expected.filter(v => text.includes(v)).length });
  }
  writeFileSync(join(directory, 'bad.png'), 'not an image');
  const bad = invoke('ocr', join(directory, 'bad.png'));
  results.push({ id: 'T0-05-corrupt-image', passed: bad.exit !== 0 });

  const textPath = join(directory, 'texts.json');
  writeFileSync(textPath, JSON.stringify([...knowledgeFixtures.map(x => x.text), ...retrievalQuestions.map(q => q.question)]));
  const started = performance.now();
  const raw = invoke('embedding', textPath);
  const data = raw.data as { available?: boolean; dimension?: number; revision?: number; vectors?: number[][] } | null;
  if (raw.exit === 0 && data?.available && data.vectors?.length === 36) {
    const vectors = data.vectors;
    const dbFile = join(directory, 'vectors.db');
    const store = new ExperimentVectorStore(dbFile);
    const space = `apple-zh-sentence-rev${data.revision}`;
    store.rebuild(space, data.dimension!, knowledgeFixtures.map((c, i) => ({ ...c, documentId: c.id, vector: vectors[i]! })));
    store.close();
    const reopened = new ExperimentVectorStore(dbFile);
    try {
      const retriever = RunnableLambda.from((index: number) => reopened.search(space, vectors[index + 6]!, 5));
      let recall1 = 0, recall5 = 0, evaluated = 0;
      const ranks: { questionId: string; expectedDocument: string; rank: number | null }[] = [];
      const negativeScores: { questionId: string; topScore: number | null }[] = [];
      const positiveScores: number[] = [];
      for (const [i, q] of retrievalQuestions.entries()) {
        const hits = await retriever.invoke(i);
        if (q.documentId === null) {
          negativeScores.push({ questionId: q.id, topScore: hits[0]?.score ?? null });
          continue;
        }
        positiveScores.push(hits[0]!.score);
        const rank = hits.findIndex(h => h.documentId === q.documentId) + 1;
        evaluated++;
        if (rank === 1) recall1++;
        if (rank > 0) recall5++;
        ranks.push({ questionId: q.id, expectedDocument: q.documentId!, rank: rank || null });
      }
      results.push({ id: 'T0-06-real-local-embedding', passed: evaluated === 24 && recall5 / evaluated >= 0.8,
        dimension: data.dimension, revision: data.revision, evaluated, recallAt1: recall1 / evaluated,
        recallAt5: recall5 / evaluated, ranks, negativeScores,
        thresholdObservation: { minPositiveTopScore: Math.min(...positiveScores),
          maxNegativeTopScore: Math.max(...negativeScores.map(x => x.topScore ?? -1)),
          separatesThisSample: Math.min(...positiveScores) > Math.max(...negativeScores.map(x => x.topScore ?? -1)) },
        durationMs: Math.round(performance.now() - started),
        limitation: 'Six synthetic documents only; not production retrieval quality or evidence sufficiency calibration.' });
      results.push({ id: 'T0-08-langchain-retriever', passed: evaluated === 24, pipeline: 'system embedding -> reopened SQLite -> RunnableLambda retriever' });
      reopened.deleteDocument('weight');
      results.push({ id: 'T0-07-real-vector-delete', passed: reopened.search(space, vectors[0]!, 5).every(x => x.documentId !== 'weight') });
    } finally { reopened.close(); }
  } else {
    results.push({ id: 'T0-06-real-local-embedding', passed: false, exit: raw.exit, reason: 'SYSTEM_CHINESE_EMBEDDING_UNAVAILABLE' });
  }
} finally { rmSync(directory, { recursive: true, force: true }); }

const path = resolve(PROJECT_ROOT, 'docs/phase2-p0-smoke-result.json');
const old = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const sourcePaths = ['apps/server/experiments/phase2-p0/local.ts', 'apps/server/experiments/phase2-p0/local-capabilities.m',
  'apps/server/experiments/phase2-p0/vector-store.ts', 'apps/server/experiments/phase2-p0/dataset.ts'];
const record = { checkedAt: new Date().toISOString(), datasetVersion, results, previousAttempts: old.localCapabilities ? [old.localCapabilities] : [],
  sourceHashes: Object.fromEntries(sourcePaths.map(p => [p, createHash('sha256').update(readFileSync(resolve(PROJECT_ROOT, p))).digest('hex')])) };
writeFileSync(path, JSON.stringify({ ...old, localCapabilities: record }, null, 2) + '\n', { mode: 0o600 });
for (const r of results) console.info(JSON.stringify(r));
if (results.some(r => !r.passed)) process.exitCode = 1;
