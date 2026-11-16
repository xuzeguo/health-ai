import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentVectorStore } from './vector-store.js';
import { knowledgeFixtures } from './dataset.js';

const dir = mkdtempSync(join(tmpdir(), 'healthai-retrieval-diagnostic-'));
try {
  const path = join(dir, 'input.json');
  const queries = ['体脂率是什么意思？请根据给定资料解释并引用来源编号。', '体脂率是什么意思？', '体脂率代表什么比例？'];
  writeFileSync(path, JSON.stringify([...knowledgeFixtures.map(x => x.text), ...queries]));
  const r = spawnSync(process.argv[2]!, ['embedding', path], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) {
    console.info(JSON.stringify({ embeddingSucceeded: false, exit: r.status }));
    process.exitCode = 1;
  } else {
    const data = JSON.parse(r.stdout) as { dimension: number; vectors: number[][] };
    const store = new ExperimentVectorStore(':memory:');
    try {
      store.rebuild('diagnostic', data.dimension, knowledgeFixtures.map((x, i) => ({ ...x, documentId: x.id, vector: data.vectors[i]! })));
      for (let i = 0; i < queries.length; i++) {
        const hits = store.search('diagnostic', data.vectors[6 + i]!, 6);
        console.info(JSON.stringify({ queryId: i, ranking: hits.map(x => ({ id: x.id, score: x.score })) }));
      }
    } finally { store.close(); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
