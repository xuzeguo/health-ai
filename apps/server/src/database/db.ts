import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    db.pragma('synchronous = FULL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
