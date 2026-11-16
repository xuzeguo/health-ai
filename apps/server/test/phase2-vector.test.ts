import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentVectorStore } from '../experiments/phase2-p0/vector-store.js';

test('P0 vectors persist on reopen, rank deterministically, filter deleted documents and bind IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'healthai-vector-'));
  const file = join(dir, 'test.db');
  try {
    const store = new ExperimentVectorStore(file);
    store.rebuild('space-a', 2, [
      { id: 'a', documentId: 'doc-a', text: 'synthetic-a', vector: [1, 0] },
      { id: 'b', documentId: 'doc-b', text: 'synthetic-b', vector: [0, 1] },
      { id: "c' OR 1=1 --", documentId: 'doc-c', text: 'synthetic-c', vector: [1, 1] },
    ]);
    assert.deepEqual(store.search('space-a', [1, 0], 2).map(x => x.id), ['a', "c' OR 1=1 --"]);
    store.close();
    const reopened = new ExperimentVectorStore(file);
    try {
      assert.equal(reopened.search('space-a', [1, 0], 1)[0]?.id, 'a');
      reopened.deleteDocument('doc-a');
      assert.equal(reopened.search('space-a', [1, 0], 1)[0]?.documentId, 'doc-c');
      assert.equal(reopened.search('space-a', [1, 0], 10).length, 2);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0 vector rebuild switches generation atomically and failure preserves old generation', () => {
  const s = new ExperimentVectorStore(':memory:');
  try {
    s.rebuild('a', 2, [{ id: 'same', documentId: 'doc', text: 'old', vector: [1, 0] }]);
    assert.throws(() => s.rebuild('a', 2, [
      { id: 'same', documentId: 'doc', text: 'new', vector: [0, 1] },
      { id: 'same', documentId: 'doc', text: 'duplicate', vector: [1, 0] },
    ]));
    assert.equal(s.search('a', [1, 0], 1)[0]?.text, 'old');
    s.rebuild('a', 2, [{ id: 'same', documentId: 'doc', text: 'new', vector: [0, 1] }]);
    assert.equal(s.search('a', [0, 1], 1)[0]?.text, 'new');
    s.rebuild('b', 3, [{ id: 'same', documentId: 'doc2', text: 'other-space', vector: [1, 0, 0] }]);
    assert.equal(s.search('b', [1, 0, 0], 1)[0]?.text, 'other-space');
    assert.equal(s.search('a', [0, 1], 1)[0]?.text, 'new');
  } finally { s.close(); }
});

test('P0 vectors reject wrong dimensions, non-finite values, zero vectors, unknown space and invalid limits', () => {
  const s = new ExperimentVectorStore(':memory:');
  try {
    s.rebuild('a', 2, [{ id: '1', documentId: 'd', text: 'x', vector: [1, 0] }]);
    for (const vector of [[1], [NaN, 1], [Infinity, 1], [0, 0]]) {
      assert.throws(() => s.search('a', vector, 1));
      assert.throws(() => s.rebuild('a', 2, [{ id: 'x', documentId: 'd', text: 'x', vector }]));
    }
    assert.throws(() => s.search('missing', [1, 0], 1));
    for (const k of [0, -1, 501, 1.5]) assert.throws(() => s.search('a', [1, 0], k));
    assert.equal(s.search('a', [1, 0], 1)[0]?.id, '1');
  } finally { s.close(); }
});
