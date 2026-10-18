import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { reconcileHistory, validatePlan, type Counters, type HistoricalEvent, type HistoricalObservation, type HistoricalSnapshot } from '../src/reconciliation/historical';
import { readJsonSnapshot, readSqliteSnapshot } from '../src/reconciliation/snapshot';
import { SessionIndex } from '../src/collectors/sessions';

const v = (input: number, cached = 0, output = 0, reasoning = 0): Counters => ({ input, cached, output, reasoning });
const event = (id: string, amount: Counters, options: Partial<HistoricalEvent> = {}): HistoricalEvent => ({
  id, sourceFile: `/synthetic/${id}.jsonl`, sessionId: 'thread', timestamp: '2026-01-01T00:00:00.000Z', counters: amount, ...options,
});
const observation = (id: string, total: Counters, options: Partial<HistoricalObservation> = {}): HistoricalObservation => ({
  id, key: `key-${id}`, sourceFile: `/synthetic/${id}.jsonl`, sessionId: 'thread', timestamp: '2026-01-01T00:00:00.000Z', total, decision: 'counted', ...options,
});
const snapshot = (events: HistoricalEvent[], observations: HistoricalObservation[] = []): HistoricalSnapshot => ({ storage: 'sqlite', schemaVersion: 6, events, observations, checkpoints: [] });

describe('historical reconciliation is conservative', () => {
  it('confirms the exact repeated fingerprint while preserving the first event', () => {
    const s = snapshot([event('a', v(100, 80, 10, 4), { fingerprint: 'exact' }), event('b', v(100, 80, 10, 4), { fingerprint: 'exact' })]);
    const plan = reconcileHistory(s);
    expect(plan.summary.current).toEqual(v(200, 160, 20, 8));
    expect(plan.summary.demonstrableAdjustment).toEqual(v(100, 80, 10, 4));
    expect(plan.summary.proposed).toEqual(v(100, 80, 10, 4));
    expect(plan.adjustments.map(item => item.eventId)).toEqual(['b']);
    expect(plan.applicationEnabled).toBe(false);
  });

  it('does not treat equal amounts or same canonical ID as a duplicate', () => {
    const s = snapshot([event('a', v(100)), event('b', v(100))]);
    expect(reconcileHistory(s).adjustments).toEqual([]);
  });

  it('rejects conflicting deltas for the same fingerprint', () => {
    const s = snapshot([event('a', v(100), { fingerprint: 'x' }), event('b', v(150), { fingerprint: 'x' })]);
    const p = reconcileHistory(s);
    expect(p.adjustments).toEqual([]);
    expect(p.summary.classifications.ambiguous).toBe(2);
  });

  it('keeps a rewritten observation ambiguous even when timestamp and totals agree without exact provenance', () => {
    const a = event('a', v(150, 125, 15, 5), { sourceFile: '/synthetic/old.jsonl' });
    const b = event('b', v(150, 125, 15, 5), { sourceFile: '/synthetic/new.jsonl' });
    const oa = observation('a', v(150, 125, 15, 5), { sourceFile: a.sourceFile, last: v(50, 40, 5, 2) });
    const ob = observation('b', v(150, 125, 15, 5), { sourceFile: b.sourceFile, last: v(50, 40, 5, 2), key: oa.key });
    const p = reconcileHistory(snapshot([a, b]), [oa, ob]);
    expect(p.adjustments).toEqual([]);
    expect(p.summary.classifications.ambiguous).toBeGreaterThan(0);
    expect(p.summary.proposed).toEqual(v(300, 250, 30, 10));
  });

  it('does not infer a rewritten duplicate from matching counters at different timestamps', () => {
    const a = event('a', v(100), { sourceFile: '/synthetic/old.jsonl' });
    const b = event('b', v(100), { sourceFile: '/synthetic/new.jsonl' });
    const p = reconcileHistory(snapshot([a, b]), [
      observation('a', v(100), { sourceFile: a.sourceFile, last: v(100) }),
      observation('b', v(100), { sourceFile: b.sourceFile, timestamp: '2026-01-01T00:01:00Z', last: v(100) }),
    ]);
    expect(p.adjustments).toEqual([]);
    expect(p.summary.classifications.ambiguous).toBeGreaterThan(0);
  });

  it('keeps matching parent and child baselines as candidates while retaining independent fork increments', () => {
    const parent = event('parent', v(150, 120, 15, 5), { sourceFile: '/synthetic/parent.jsonl', sessionId: 'parent' });
    const leftBase = event('left-base', v(150, 120, 15, 5), { sourceFile: '/synthetic/left.jsonl', sessionId: 'left' });
    const rightBase = event('right-base', v(150, 120, 15, 5), { sourceFile: '/synthetic/right.jsonl', sessionId: 'right' });
    const leftNew = event('left-new', v(20, 18, 2, 1), { sourceFile: leftBase.sourceFile, sessionId: 'left', timestamp: '2026-01-01T00:01:00Z' });
    const rightNew = event('right-new', v(30, 20, 3, 1), { sourceFile: rightBase.sourceFile, sessionId: 'right', timestamp: '2026-01-01T00:02:00Z' });
    const evidence = [
      observation('parent', v(150, 120, 15, 5), { sourceFile: parent.sourceFile, sessionId: 'parent' }),
      observation('left-base', v(150, 120, 15, 5), { sourceFile: leftBase.sourceFile, sessionId: 'left', parentSessionId: 'parent' }),
      observation('right-base', v(150, 120, 15, 5), { sourceFile: rightBase.sourceFile, sessionId: 'right', parentSessionId: 'parent' }),
      observation('left-new', v(170, 138, 17, 6), { sourceFile: leftBase.sourceFile, sessionId: 'left', timestamp: leftNew.timestamp, last: v(20, 18, 2, 1) }),
      observation('right-new', v(180, 140, 18, 6), { sourceFile: rightBase.sourceFile, sessionId: 'right', timestamp: rightNew.timestamp, last: v(30, 20, 3, 1) }),
    ];
    const p = reconcileHistory(snapshot([parent, leftBase, rightBase, leftNew, rightNew]), evidence);
    expect(p.adjustments).toEqual([]);
    expect(p.summary.candidateCounts.possible_inherited_base).toBe(2);
    expect(p.summary.proposed).toEqual(p.summary.current);
    expect(p.findings.find(item => item.eventId === 'left-new')?.classification).toBe('confirmed_unique');
    expect(p.findings.find(item => item.eventId === 'right-new')?.classification).toBe('confirmed_unique');
  });

  it('removes only an explicitly inherited cumulative base and retains the typed new increment', () => {
    const parent = event('parent', v(150, 120, 15, 5), { sourceFile: '/synthetic/parent.jsonl', sessionId: 'parent' });
    const child = event('child', v(170, 138, 17, 6), { sourceFile: '/synthetic/child.jsonl', sessionId: 'child' });
    const p = reconcileHistory(snapshot([parent, child]), [
      observation('parent', v(150, 120, 15, 5), { sourceFile: parent.sourceFile, sessionId: 'parent' }),
      observation('child', v(170, 138, 17, 6), { sourceFile: child.sourceFile, sessionId: 'child', parentSessionId: 'parent', timestamp: '2026-01-01T00:01:00Z', last: v(20, 18, 2, 1) }),
    ]);
    expect(p.adjustments).toHaveLength(1);
    expect(p.adjustments[0].proposed).toEqual(v(20, 18, 2, 1));
    expect(p.summary.demonstrableAdjustment).toEqual(v(150, 120, 15, 5));
    expect(p.summary.proposed).toEqual(v(170, 138, 17, 6));
  });

  it('does not subtract a suspected inherited base across files without explicit lineage', () => {
    const parent = event('parent', v(150), { sourceFile: '/synthetic/parent.jsonl' });
    const child = event('child', v(170), { sourceFile: '/synthetic/child.jsonl' });
    const p = reconcileHistory(snapshot([parent, child]), [
      observation('parent', v(150), { sourceFile: parent.sourceFile }),
      observation('child', v(170), { sourceFile: child.sourceFile, last: v(20), decision: 'ambiguous' }),
    ]);
    expect(p.adjustments).toHaveLength(0);
    expect(p.findings.find(item => item.eventId === 'child')?.classification).toBe('ambiguous');
  });

  it('leaves forks with no explicit matching parent observation ambiguous', () => {
    const e = event('fork', v(150), { sessionId: 'fork' });
    const p = reconcileHistory(snapshot([e]), [observation('fork', v(150), { sessionId: 'fork', parentSessionId: 'missing', decision: 'ambiguous' })]);
    expect(p.adjustments).toEqual([]);
    expect(p.summary.classifications.ambiguous).toBe(1);
  });

  it('does not equate a technical ctco ID with a conversation without source evidence', () => {
    const p = reconcileHistory(snapshot([event('item', v(500), { sessionId: 'ctco_synthetic' }), event('thread', v(500))]));
    expect(p.adjustments).toEqual([]);
    expect(p.summary.classifications.unverifiable_legacy).toBe(2);
  });

  it('flags a ctco-attributed historical row when the surviving source proves another canonical identity', () => {
    const old = event('legacy', v(100, 80, 10, 2), { sessionId: 'ctco_synthetic', fingerprint: 'source-fingerprint' });
    const source = observation('new-id', v(100, 80, 10, 2), { sourceFile: '/synthetic/current.jsonl', sessionId: 'canonical-thread', last: v(100, 80, 10, 2) });
    const p = reconcileHistory(snapshot([old]), [{ ...source, eventFingerprint: old.fingerprint }]);
    expect(p.summary.provenanceMatchedEvents).toBe(1);
    expect(p.summary.classifications.ambiguous).toBe(1);
    expect(p.adjustments).toEqual([]);
  });

  it('keeps archived generations without surviving bytes as unverifiable', () => {
    const old = event('old', v(100), { sourceFile: '/synthetic/rollout.jsonl#archived:abc' });
    const current = event('current', v(120), { sourceFile: '/synthetic/rollout.jsonl' });
    const p = reconcileHistory(snapshot([old, current]), [observation('current', v(120), { sourceFile: current.sourceFile, last: v(20), decision: 'ambiguous' })]);
    expect(p.findings.find(item => item.eventId === 'old')?.classification).toBe('unverifiable_legacy');
    expect(p.adjustments).toEqual([]);
  });

  it('does not collapse identical counters from independent canonical forks', () => {
    const left = event('left', v(20), { sessionId: 'fork-left' });
    const right = event('right', v(20), { sessionId: 'fork-right' });
    const p = reconcileHistory(snapshot([left, right]), [
      observation('left', v(170), { sessionId: left.sessionId, last: v(20) }),
      observation('right', v(170), { sessionId: right.sessionId, last: v(20) }),
    ]);
    expect(p.summary.proposed.input).toBe(40);
    expect(p.adjustments).toEqual([]);
  });

  it('invalidates a plan when a checkpoint advances after a new import', () => {
    const s = snapshot([event('a', v(100))]);
    s.checkpoints.push({ sourceFile: '/synthetic/a.jsonl', size: 100, offset: 100, parserVersion: 2 });
    const p = reconcileHistory(s);
    expect(validatePlan(p, s).valid).toBe(true);
    const changed = { ...s, checkpoints: [{ ...s.checkpoints[0], offset: 101, size: 101 }] };
    expect(validatePlan(p, changed).valid).toBe(false);
  });

  it('invalidates a plan when new source evidence appears without database writes', () => {
    const s = snapshot([event('a', v(100))]);
    const p = reconcileHistory(s);
    expect(validatePlan(p, s, [observation('a', v(100), { last: v(100) })]).valid).toBe(false);
  });

  it('keeps a partially available generation and an out-of-order observation unresolved', () => {
    const e = event('part', v(50));
    const p = reconcileHistory(snapshot([e]), [observation('part', v(150), { timestamp: '2026-01-01T00:00:01Z', decision: 'ambiguous' })]);
    expect(p.adjustments).toEqual([]);
    expect(p.summary.classifications.ambiguous).toBe(1);
  });

  it('marks old rows with no JSONL or ledger unverifiable and preserves their totals', () => {
    const p = reconcileHistory(snapshot([event('legacy', v(1000000, 950000, 2500, 1000))]));
    expect(p.summary.proposed).toEqual(p.summary.current);
    expect(p.summary.classifications.unverifiable_legacy).toBe(1);
    expect(p.summary.uncertainAdditionalAdjustment).toBe('not quantified');
  });

  it('classifies a counter reset or out-of-order sequence without a typed increment as ambiguous', () => {
    const e = event('reset', v(100));
    const p = reconcileHistory(snapshot([e]), [observation('reset', v(10), { decision: 'ambiguous' })]);
    expect(p.summary.classifications.ambiguous).toBe(1);
    expect(p.adjustments).toHaveLength(0);
  });

  it('refuses malformed cache or reasoning subsets', () => {
    for (const counters of [v(5, 6), v(5, 0, 3, 4)]) {
      const p = reconcileHistory(snapshot([event('bad', counters)]));
      expect(p.summary.classifications.ambiguous).toBe(1);
      expect(p.adjustments).toHaveLength(0);
    }
  });

  it('stops when accumulated counters would lose integer precision', () => {
    expect(() => reconcileHistory(snapshot([event('a', v(Number.MAX_SAFE_INTEGER)), event('b', v(1))]))).toThrow('safe integer');
  });

  it('is independent of event and evidence traversal order', () => {
    const events = [event('b', v(100), { fingerprint: 'same' }), event('a', v(100), { fingerprint: 'same' })];
    const first = reconcileHistory(snapshot(events));
    const reversed = reconcileHistory(snapshot([...events].reverse()));
    expect(reversed).toEqual(first);
  });

  it('detects a stale or tampered plan and never enables application', () => {
    const s = snapshot([event('a', v(100))]);
    const p = reconcileHistory(s);
    expect(validatePlan(p, s).valid).toBe(true);
    expect(validatePlan(p, snapshot([event('a', v(101))])).valid).toBe(false);
    expect(validatePlan({ ...p, summary: { ...p.summary, proposed: v(0) } }, s).valid).toBe(false);
    expect(validatePlan({ ...p, applicationEnabled: true as false }, s).valid).toBe(false);
  });

  it('returns a stable plan on repeated dry-runs and does not mutate inputs', () => {
    const s = snapshot([event('a', v(100), { fingerprint: 'x' }), event('b', v(100), { fingerprint: 'x' })]);
    const before = JSON.stringify(s);
    expect(reconcileHistory(s)).toEqual(reconcileHistory(s));
    expect(JSON.stringify(s)).toBe(before);
  });

  it('loads an isolated JSON fallback without writing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-json-'));
    try {
      const file = path.join(dir, 'index.json');
      const source = { '/synthetic/a.jsonl': { size: 99, mtimeMs: 1, offset: 99, parserVersion: 2, events: [{ id: 'a', sessionId: 'thread', timestamp: '2026-01-01', inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 2, fingerprint: 'fp' }], observations: [{ id: 'a', key: 'key-a', sessionId: 'thread', timestamp: '2026-01-01', input: 100, cached: 80, output: 10, reasoning: 2, decision: 'counted' }] } };
      writeFileSync(file, JSON.stringify(source));
      const before = readFileSync(file);
      const parsed = readJsonSnapshot(file);
      expect(parsed.events[0].counters).toEqual(v(100, 80, 10, 2));
      expect(parsed.observations).toHaveLength(1);
      expect(reconcileHistory(parsed).summary.current).toEqual(v(100, 80, 10, 2));
      expect(readFileSync(file).equals(before)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads schema 5 and 6 SQLite snapshots without applying a migration', async () => {
    let sqlite: typeof import('node:sqlite'); try { sqlite = await import('node:sqlite'); } catch { return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-sqlite-'));
    try {
      const file = path.join(dir, 'snapshot.sqlite');
      const db = new sqlite.DatabaseSync(file);
      db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER); INSERT INTO schema_migrations VALUES(5,1); CREATE TABLE token_events(id TEXT, fingerprint TEXT, source_file TEXT, session_id TEXT, observed_at TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_output_tokens INTEGER); INSERT INTO token_events VALUES('a','fp','/synthetic/a.jsonl','thread','2026-01-01',100,80,10,2); CREATE TABLE import_state(source_file TEXT,size INTEGER,offset INTEGER,generation TEXT,parser_version INTEGER,parser_state TEXT); INSERT INTO import_state VALUES('/synthetic/a.jsonl',99,99,NULL,2,NULL)");
      db.close();
      const before = readFileSync(file);
      expect((await readSqliteSnapshot(file)).schemaVersion).toBe(5);
      expect(readFileSync(file).equals(before)).toBe(true);
      const reopened = new sqlite.DatabaseSync(file);
      reopened.exec("CREATE TABLE counter_observations(id TEXT,observation_key TEXT,source_file TEXT,session_id TEXT,parent_session_id TEXT,observed_at TEXT,input_total INTEGER,cached_total INTEGER,output_total INTEGER,reasoning_total INTEGER,last_input INTEGER,last_cached INTEGER,last_output INTEGER,last_reasoning INTEGER,decision TEXT); INSERT INTO schema_migrations VALUES(6,2)");
      reopened.close();
      expect((await readSqliteSnapshot(file)).schemaVersion).toBe(6);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps SQLite and JSON fallback accounting equivalent on isolated synthetic copies', async () => {
    let sqlite: typeof import('node:sqlite'); try { sqlite = await import('node:sqlite'); } catch { return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-equivalence-'));
    try {
      const dbFile = path.join(dir, 'snapshot.sqlite');
      const db = new sqlite.DatabaseSync(dbFile);
      db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER); INSERT INTO schema_migrations VALUES(6,1); CREATE TABLE token_events(id TEXT,fingerprint TEXT,source_file TEXT,session_id TEXT,observed_at TEXT,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,reasoning_output_tokens INTEGER); INSERT INTO token_events VALUES('a','same','/synthetic/a.jsonl','thread','2026-01-01',100,80,10,2); INSERT INTO token_events VALUES('b','same','/synthetic/b.jsonl','thread','2026-01-01',100,80,10,2)");
      db.close();
      const jsonFile = path.join(dir, 'index.json');
      writeFileSync(jsonFile, JSON.stringify(['a', 'b'].map(id => ({ file: `/synthetic/${id}.jsonl`, size: 1, mtimeMs: 1, parserVersion: 2,
        events: [{ id, fingerprint: 'same', sourceFile: `/synthetic/${id}.jsonl`, sessionId: 'thread', timestamp: '2026-01-01', inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 2 }] }))));
      expect(reconcileHistory(await readSqliteSnapshot(dbFile)).summary).toEqual(reconcileHistory(readJsonSnapshot(jsonFile)).summary);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('detects a changed isolated SQLite copy and verifies restoration from a synthetic backup', async () => {
    let sqlite: typeof import('node:sqlite'); try { sqlite = await import('node:sqlite'); } catch { return; }
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-restore-'));
    try {
      const file = path.join(dir, 'snapshot.sqlite'), backup = path.join(dir, 'backup.sqlite');
      const db = new sqlite.DatabaseSync(file);
      db.exec("CREATE TABLE token_events(id TEXT,fingerprint TEXT,source_file TEXT,session_id TEXT,observed_at TEXT,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,reasoning_output_tokens INTEGER); INSERT INTO token_events VALUES('a','x','synthetic','thread','2026-01-01',100,80,10,2)");
      db.close(); copyFileSync(file, backup);
      const original = await readSqliteSnapshot(file);
      const plan = reconcileHistory(original);
      const writable = new sqlite.DatabaseSync(file);
      writable.exec("INSERT INTO token_events VALUES('b','y','synthetic','thread','2026-01-02',20,18,2,1)");
      writable.close();
      expect(validatePlan(plan, await readSqliteSnapshot(file)).valid).toBe(false);
      copyFileSync(backup, file);
      expect(validatePlan(plan, await readSqliteSnapshot(file)).valid).toBe(true);
      expect((await readSqliteSnapshot(file)).events).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('enforces a non-writing repair CLI gate even without an input path', () => {
    expect(() => execFileSync(process.execPath, ['scripts/audit-history.mjs', '--repair'], { stdio: 'pipe' })).toThrow();
  });

  it('audits, writes a private plan, inspects it and rejects a stale snapshot without source writes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-cli-'));
    try {
      const file = path.join(dir, 'snapshot.json');
      const planFile = path.join(dir, 'private-plan.json');
      const source = { '/synthetic/a.jsonl': { size: 9, mtimeMs: 1, offset: 9, parserVersion: 2,
        events: [
          { id: 'a', sessionId: 'thread', timestamp: '2026-01-01', inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 2, fingerprint: 'f' },
          { id: 'b', sessionId: 'thread', timestamp: '2026-01-01', inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 2, fingerprint: 'f' },
        ], observations: [] } };
      writeFileSync(file, JSON.stringify(source));
      const original = readFileSync(file);
      const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/audit-history.mjs', ...args], { encoding: 'utf8' });
      const audit = run('audit', '--snapshot-json', file);
      expect(audit.status).toBe(0);
      expect(JSON.parse(audit.stdout).summary.current).toEqual(v(200, 160, 20, 4));
      expect(JSON.parse(audit.stdout).summary.demonstrableAdjustment).toEqual(v(100, 80, 10, 2));
      expect(JSON.parse(audit.stdout).summary.proposed).toEqual(v(100, 80, 10, 2));
      expect(readFileSync(file).equals(original)).toBe(true);
      const created = run('plan', '--snapshot-json', file, '--output', planFile);
      expect(created.status).toBe(0);
      expect((statSync(planFile).mode & 0o777)).toBe(0o600);
      expect(run('inspect', '--plan', planFile).status).toBe(0);
      expect(JSON.parse(run('validate', '--snapshot-json', file, '--plan', planFile).stdout).valid).toBe(true);
      source['/synthetic/a.jsonl'].events[0].inputTokens = 101;
      writeFileSync(file, JSON.stringify(source));
      const stale = run('validate', '--snapshot-json', file, '--plan', planFile);
      expect(stale.status).toBe(3);
      expect(JSON.parse(stale.stdout).valid).toBe(false);
      expect(run('plan', '--snapshot-json', file, '--output', planFile).status).toBe(2);
      const liveLike = path.join(dir, 'globalStorage'); mkdirSync(liveLike);
      writeFileSync(path.join(liveLike, 'insights.sqlite'), '{}');
      expect(run('audit', '--snapshot-json', path.join(liveLike, 'insights.sqlite')).status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('links a synthetic legacy technical ID by source fingerprint without inventing a duplicate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-source-link-'));
    try {
      const root = path.join(dir, 'sessions'); mkdirSync(root);
      const rollout = path.join(root, 'rollout.jsonl');
      const meta = { type: 'session_meta', payload: { id: 'canonical-thread' } };
      const token = { type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 2 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 2 } } } };
      writeFileSync(rollout, JSON.stringify(meta) + '\n' + JSON.stringify(token) + '\n');
      const indexFile = path.join(dir, 'source-index.json');
      const index = new SessionIndex(indexFile);
      const scan = await index.scan(root); index.close();
      expect(scan.events).toHaveLength(1);
      const copied = path.join(dir, 'legacy-copy.json');
      const legacy = { [rollout + '#archived:synthetic']: { size: 100, mtimeMs: 1, offset: 100, parserVersion: 1,
        events: [{ ...scan.events[0], id: 'old-id', sessionId: 'ctco_synthetic' }], observations: [] } };
      writeFileSync(copied, JSON.stringify(legacy));
      const result = spawnSync(process.execPath, ['scripts/audit-history.mjs', 'audit', '--snapshot-json', copied, '--sources', root], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      const summary = JSON.parse(result.stdout).summary;
      expect(summary.provenanceMatchedEvents).toBe(1);
      expect(summary.classifications.ambiguous).toBe(1);
      expect(summary.demonstrableAdjustment.input).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
