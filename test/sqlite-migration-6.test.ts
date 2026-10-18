import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionDatabase, type IncrementalFileUpdate } from '../src/storage/session-db';

async function sqliteModule(): Promise<typeof import('node:sqlite') | undefined> {
  try { return await import('node:sqlite'); } catch { return undefined; }
}

function createV5(sqlite: typeof import('node:sqlite'), file: string, obstruct = false): void {
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES(5, 1);
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE models(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT, model_id TEXT, started_at TEXT);
    CREATE TABLE token_events(id TEXT PRIMARY KEY, fingerprint TEXT, source_file TEXT NOT NULL, session_id TEXT NOT NULL, observed_at TEXT NOT NULL, model_id TEXT, project_id TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL);
    CREATE UNIQUE INDEX idx_token_events_fingerprint ON token_events(fingerprint) WHERE fingerprint IS NOT NULL;
    CREATE TABLE import_state(source_file TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, offset INTEGER NOT NULL, identity TEXT, generation TEXT, parser_state TEXT, partial TEXT, parser_version INTEGER NOT NULL, last_read_at INTEGER);
    INSERT INTO projects VALUES('project','Synthetic');
    INSERT INTO models VALUES('model');
    INSERT INTO sessions VALUES('thread','project','model','2026-01-01T00:00:00Z');
    INSERT INTO token_events VALUES('event-1','fingerprint-1','synthetic.jsonl','thread','2026-01-01T00:00:00Z','model','project',100,5,80,2);
    INSERT INTO import_state VALUES('synthetic.jsonl',123,1,123,NULL,NULL,NULL,NULL,2,1);
  `);
  if (obstruct) db.exec('CREATE VIEW counter_observations AS SELECT id FROM token_events');
  db.close();
}

function count(db: import('node:sqlite').DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('SQLite migration 5 to 6', () => {
  it('preserves historical rows and totals on an isolated backup and remains idempotent', async () => {
    const sqlite = await sqliteModule(); if (!sqlite) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-migration-'));
    try {
      const file = path.join(dir, 'insights.sqlite');
      createV5(sqlite, file);
      copyFileSync(file, path.join(dir, 'verified-backup.sqlite'));
      const storage = new SessionDatabase(dir);
      expect(await storage.open()).toBe(true);
      let rows = storage.read();
      expect(rows.get('synthetic.jsonl')?.events).toHaveLength(1);
      expect(rows.get('synthetic.jsonl')?.events[0].inputTokens).toBe(100);
      storage.close();

      const raw = new sqlite.DatabaseSync(file);
      expect(count(raw, 'schema_migrations')).toBeGreaterThanOrEqual(1);
      expect((raw.prepare('SELECT count(*) AS count FROM schema_migrations WHERE version=6').get() as { count: number }).count).toBe(1);
      expect(count(raw, 'token_events')).toBe(1);
      expect(count(raw, 'counter_observations')).toBe(0);
      expect((raw.prepare('PRAGMA integrity_check').get() as Record<string, string>).integrity_check).toBe('ok');
      const indices = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='counter_observations'").all() as Array<{ name: string }>).map(row => row.name);
      expect(indices).toContain('idx_counter_observations_key');
      expect(indices).toContain('idx_counter_observations_session');
      raw.close();

      expect(await storage.open()).toBe(true);
      const update: IncrementalFileUpdate = {
        file: 'synthetic.jsonl',
        checkpoint: { size: 124, mtimeMs: 2, offset: 124, identity: null, generation: null, parserState: null, partial: null, parserVersion: 2, lastReadAt: 2 },
        events: [{ id: 'event-1', fingerprint: 'fingerprint-1', sourceFile: 'synthetic.jsonl', sessionId: 'thread', timestamp: '2026-01-01T00:00:00Z', inputTokens: 100, outputTokens: 5, cachedInputTokens: 80, reasoningOutputTokens: 2 }],
        observations: [{ id: 'observation-1', key: 'key-1', sourceFile: 'synthetic.jsonl', sessionId: 'thread', timestamp: '2026-01-01T00:00:00Z', input: 100, output: 5, cached: 80, reasoning: 2, decision: 'counted' }],
      };
      storage.applyIncremental(update);
      storage.applyIncremental(update);
      rows = storage.read();
      expect(rows.get('synthetic.jsonl')?.events).toHaveLength(1);
      expect(rows.get('synthetic.jsonl')?.observations).toHaveLength(1);
      expect(rows.get('synthetic.jsonl')?.offset).toBe(124);
      storage.close();
      const reopened = new SessionDatabase(dir);
      expect(await reopened.open()).toBe(true);
      expect(reopened.read().get('synthetic.jsonl')?.events).toHaveLength(1);
      reopened.close();
      const backup = new sqlite.DatabaseSync(path.join(dir, 'verified-backup.sqlite'));
      expect(count(backup, 'token_events')).toBe(1);
      expect(count(backup, 'schema_migrations')).toBe(1);
      backup.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rolls back a failed migration and can retry after the obstruction is removed', async () => {
    const sqlite = await sqliteModule(); if (!sqlite) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-migration-fail-'));
    try {
      const file = path.join(dir, 'insights.sqlite');
      createV5(sqlite, file, true);
      const storage = new SessionDatabase(dir);
      await expect(storage.open()).rejects.toThrow('original file was preserved');
      const raw = new sqlite.DatabaseSync(file);
      expect(count(raw, 'token_events')).toBe(1);
      expect((raw.prepare('SELECT count(*) AS count FROM schema_migrations WHERE version=6').get() as { count: number }).count).toBe(0);
      expect((raw.prepare('PRAGMA integrity_check').get() as Record<string, string>).integrity_check).toBe('ok');
      raw.exec('DROP VIEW counter_observations');
      raw.close();
      expect(await storage.open()).toBe(true);
      expect(storage.read().get('synthetic.jsonl')?.events).toHaveLength(1);
      storage.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
