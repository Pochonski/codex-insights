import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/collectors/sessions';
import { aggregate } from '../src/analytics/aggregate';
import { SessionDatabase } from '../src/storage/session-db';

function usage(input: number, timestamp: string): string {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0 } } } });
}

function fixture(): { dir: string; root: string; file: string; state: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-incremental-'));
  const root = path.join(dir, 'sessions');
  const file = path.join(root, 'session.jsonl');
  require('node:fs').mkdirSync(root);
  return { dir, root, file, state: path.join(dir, 'index.json') };
}

describe('incremental JSONL indexing', () => {
  it('reads only appended bytes and does not duplicate cumulative counters', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      const first = await index.scan(f.root);
      appendFileSync(f.file, usage(150, '2026-10-15T00:01:00Z') + '\n');
      const second = await index.scan(f.root);
      expect(first.metrics.bytesRead).toBeGreaterThan(0);
      expect(second.metrics.bytesRead).toBeLessThan(statSync(f.file).size);
      expect(aggregate(second.events).total.inputTokens).toBe(150);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps an incomplete final line until it is completed', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      await index.scan(f.root);
      const trailing = usage(150, '2026-10-15T00:01:00Z');
      appendFileSync(f.file, trailing);
      const partial = await index.scan(f.root);
      expect(aggregate(partial.events).total.inputTokens).toBe(100);
      appendFileSync(f.file, '\n');
      const complete = await index.scan(f.root);
      expect(aggregate(complete.events).total.inputTokens).toBe(150);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('continues from a durable byte checkpoint after a restart', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const first = new SessionIndex(f.state);
      await first.scan(f.root);
      first.close();
      appendFileSync(f.file, usage(150, '2026-10-15T00:01:00Z') + '\n');
      const restarted = new SessionIndex(f.state);
      const second = await restarted.scan(f.root);
      appendFileSync(f.file, usage(200, '2026-10-15T00:02:00Z') + '\n');
      const third = await restarted.scan(f.root);
      expect(second.metrics.bytesRead).toBeLessThan(statSync(f.file).size);
      expect(aggregate(third.events).total.inputTokens).toBe(200);
      restarted.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('retries an incomplete line after a restart without counting it twice', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n' + usage(150, '2026-10-15T00:01:00Z'));
      const first = new SessionIndex(f.state);
      expect(aggregate((await first.scan(f.root)).events).total.inputTokens).toBe(100);
      first.close();
      appendFileSync(f.file, '\n');
      const restarted = new SessionIndex(f.state);
      expect(aggregate((await restarted.scan(f.root)).events).total.inputTokens).toBe(150);
      restarted.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('migrates a v0.3.1 database without changing rows or allowing duplicate fingerprints', async () => {
    let sqlite: typeof import('node:sqlite');
    try { sqlite = await import('node:sqlite'); } catch { return; }
    const f = fixture();
    try {
      const databasePath = path.join(f.dir, 'insights.sqlite');
      const legacy = new sqlite.DatabaseSync(databasePath);
      legacy.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE models(id TEXT PRIMARY KEY); CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,model_id TEXT,started_at TEXT); CREATE TABLE token_events(id TEXT PRIMARY KEY,fingerprint TEXT,source_file TEXT NOT NULL,session_id TEXT NOT NULL,observed_at TEXT NOT NULL,model_id TEXT,project_id TEXT,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL,reasoning_output_tokens INTEGER NOT NULL); CREATE UNIQUE INDEX idx_token_events_fingerprint ON token_events(fingerprint) WHERE fingerprint IS NOT NULL; CREATE TABLE import_state(source_file TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime_ms REAL NOT NULL); INSERT INTO schema_migrations VALUES(4,1);');
      legacy.prepare('INSERT INTO token_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('legacy-event','legacy-fingerprint','legacy.jsonl','legacy-session','2026-10-15T00:00:00.000Z','gpt-test','/demo',100,20,50,5);
      legacy.prepare('INSERT INTO import_state VALUES(?,?,?)').run('legacy.jsonl',100,1);
      legacy.close();
      const upgraded = new SessionDatabase(f.dir);
      await upgraded.open();
      const restored = upgraded.read();
      expect(aggregate([...restored.values()].flatMap((entry) => entry.events)).total).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, reasoningOutputTokens: 5 });
      upgraded.applyIncremental({ file: 'legacy.jsonl', checkpoint: { size: 100, mtimeMs: 1, offset: 100, identity: null, generation: null, parserState: null, partial: null, parserVersion: 2, lastReadAt: 1 }, events: [{ id: 'duplicate-id', fingerprint: 'legacy-fingerprint', sourceFile: 'legacy.jsonl', sessionId: 'legacy-session', timestamp: '2026-10-15T00:00:00.000Z', model: 'gpt-test', project: '/demo', inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, reasoningOutputTokens: 5 }] });
      upgraded.close();
      const inspected = new sqlite.DatabaseSync(databasePath);
      expect(inspected.prepare('SELECT COUNT(*) AS count FROM token_events').get()).toMatchObject({ count: 1 });
      expect(inspected.prepare('SELECT version FROM schema_migrations WHERE version=5').get()).toMatchObject({ version: 5 });
      expect(inspected.prepare('SELECT version FROM schema_migrations WHERE version=6').get()).toMatchObject({ version: 6 });
      expect(inspected.prepare('SELECT offset FROM import_state WHERE source_file=?').get('legacy.jsonl')).toMatchObject({ offset: 100 });
      inspected.close();
      const reopened = new SessionDatabase(f.dir);
      await reopened.open();
      expect(aggregate([...reopened.read().values()].flatMap(entry => entry.events)).total.inputTokens).toBe(100);
      reopened.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('archives a replaced file and preserves historical observations', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      await index.scan(f.root);
      renameSync(f.file, f.file + '.rotated');
      writeFileSync(f.file, JSON.stringify({ type: 'session_meta', payload: { id: 'new-thread' } }) + '\n' + usage(20, '2026-10-15T01:00:00Z') + '\n');
      const scan = await index.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(120);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
