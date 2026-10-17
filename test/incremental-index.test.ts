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
  it('discovers a second canonical conversation when a new rollout has a usage event', async () => {
    const f = fixture();
    const meta = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, thread_source: 'user' } });
    const at = '2030-01-02T00:00:00Z';
    try {
      writeFileSync(f.file, meta('conversation-a') + '\n' + usage(100, at) + '\n');
      const index = new SessionIndex(f.state);
      try {
        expect((await index.scan(f.root)).events.map(e => e.sessionId)).toEqual(['conversation-a']);
        writeFileSync(path.join(f.root, 'second.jsonl'), meta('conversation-b') + '\n' + usage(50, at) + '\n');
        const refreshed = await index.scan(f.root);
        expect(refreshed.metrics.eventsNew).toBe(1);
        expect(new Set(refreshed.events.map(e => e.sessionId))).toEqual(new Set(['conversation-a', 'conversation-b']));
        expect(aggregate(refreshed.events).total.inputTokens).toBe(150);
        expect((await index.scan(f.root)).metrics.eventsNew).toBe(0);
      } finally { index.close(); }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('traces a canonical conversation with cached cumulative usage through refresh and restart', async () => {
    const f = fixture();
    const counter = (at: string, input: number, cached: number, output: number) => JSON.stringify({
      timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 },
        last_token_usage: { input_tokens: input === 58000 ? 18000 : input, cached_input_tokens: cached === 56800 ? 17800 : cached, output_tokens: output === 140 ? 40 : output },
      } },
    });
    try {
      const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'canonical-conversation', thread_source: 'user' } });
      const tool = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'ctco_tool', output: [] } });
      writeFileSync(f.file, [meta, tool, counter('2030-01-01T00:00:00Z', 40000, 39000, 100)].join('\n') + '\n');
      let index = new SessionIndex(f.state);
      let scan = await index.scan(f.root);
      expect(scan.events).toHaveLength(1);
      expect(scan.events[0].sessionId).toBe('canonical-conversation');
      appendFileSync(f.file, counter('2030-01-01T00:01:00Z', 58000, 56800, 140) + '\n');
      scan = await index.scan(f.root);
      expect(scan.events.map(e => [e.inputTokens, e.cachedInputTokens, e.outputTokens])).toEqual([[40000, 39000, 100], [18000, 17800, 40]]);
      expect(new Set(scan.events.map(e => e.sessionId))).toEqual(new Set(['canonical-conversation']));
      expect(aggregate(scan.events).sessions).toHaveLength(1);
      expect((await index.scan(f.root)).metrics.eventsNew).toBe(0);
      index.close();
      index = new SessionIndex(f.state);
      scan = await index.scan(f.root);
      expect(scan.metrics.eventsNew).toBe(0);
      expect(aggregate(scan.events).total).toMatchObject({ inputTokens: 58000, cachedInputTokens: 56800, outputTokens: 140 });
      const partial = counter('2030-01-01T00:02:00Z', 59000, 57800, 150);
      appendFileSync(f.file, partial);
      expect((await index.scan(f.root)).events).toHaveLength(2);
      appendFileSync(f.file, '\n');
      scan = await index.scan(f.root);
      expect(scan.events.map(e => e.inputTokens)).toEqual([40000, 18000, 1000]);
      expect((await index.scan(f.root)).events).toHaveLength(3);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
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
      expect(inspected.prepare('SELECT offset FROM import_state WHERE source_file=?').get('legacy.jsonl')).toMatchObject({ offset: 100 });
      inspected.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('archives a replaced file and preserves historical observations', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      await index.scan(f.root);
      renameSync(f.file, f.file + '.rotated');
      writeFileSync(f.file, usage(20, '2026-10-15T01:00:00Z') + '\n');
      const scan = await index.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(120);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
