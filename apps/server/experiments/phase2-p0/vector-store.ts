import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

interface Chunk { id: string; documentId: string; text: string; vector: number[] }
function normalize(vector: number[], dimension: number) {
  if (!Number.isInteger(dimension) || dimension < 1 || vector.length !== dimension
    || !vector.every(Number.isFinite)) throw new Error('VECTOR_DIMENSION_OR_VALUE');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('VECTOR_ZERO_OR_OVERFLOW');
  return vector.map(v => v / norm);
}

// P0 small-corpus candidate: exact O(ND) cosine scan, not an ANN index.
export class ExperimentVectorStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, dimension INTEGER NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        space TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL,
        text TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(space, generation, id));
      CREATE TABLE IF NOT EXISTS deleted_documents (id TEXT PRIMARY KEY);
    `);
  }
  rebuild(space: string, dimension: number, chunks: Chunk[]) {
    if (!space.trim() || !Number.isInteger(dimension) || dimension < 1 || dimension > 4096 || chunks.length > 2000) throw new Error('SPACE_LIMIT');
    const generation = randomUUID();
    const prepared = chunks.map(c => ({ ...c, vector: normalize(c.vector, dimension) }));
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of prepared) {
        if (!c.id || !c.documentId || !c.text) throw new Error('CHUNK_INVALID');
        insert.run(space, generation, c.id, c.documentId, c.text, JSON.stringify(c.vector));
      }
      this.db.prepare(`INSERT INTO spaces VALUES (?, ?, ?) ON CONFLICT(id)
        DO UPDATE SET dimension=excluded.dimension, generation=excluded.generation`).run(space, dimension, generation);
      this.db.prepare('DELETE FROM chunks WHERE space=? AND generation<>?').run(space, generation);
    })();
  }
  deleteDocument(id: string) {
    // Logical deletion is authoritative even when physical cleanup is deferred.
    this.db.prepare('INSERT OR IGNORE INTO deleted_documents VALUES (?)').run(id);
  }
  search(space: string, query: number[], k: number) {
    if (!Number.isInteger(k) || k < 1 || k > 500) throw new Error('LIMIT_INVALID');
    const metadata = this.db.prepare('SELECT dimension, generation FROM spaces WHERE id=?').get(space) as
      { dimension: number; generation: string } | undefined;
    if (!metadata) throw new Error('SPACE_NOT_FOUND');
    const normalized = normalize(query, metadata.dimension);
    const rows = this.db.prepare(`SELECT id, document_id, text, vector FROM chunks
      WHERE space=? AND generation=? AND NOT EXISTS
      (SELECT 1 FROM deleted_documents d WHERE d.id=chunks.document_id)`).all(space, metadata.generation) as
      { id: string; document_id: string; text: string; vector: string }[];
    return rows.map(r => {
      const vector = JSON.parse(r.vector) as number[];
      const score = vector.reduce((sum, v, i) => sum + v * normalized[i]!, 0);
      return { id: r.id, documentId: r.document_id, text: r.text, score };
    }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, k);
  }
  close() { this.db.close(); }
}
