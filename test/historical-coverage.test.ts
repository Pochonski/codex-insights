import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionDatabase, type CounterObservation, type FileCheckpoint } from '../src/storage/session-db';
import { readSqliteSnapshot } from '../src/reconciliation/snapshot';
import { reconcileHistory, validatePlan, type Counters, type SourceEvidence } from '../src/reconciliation/historical';

const counters = (input: number): Counters => ({ input, cached: Math.floor(input * .8), output: Math.floor(input / 10), reasoning: Math.floor(input / 20) });
const checkpoint: FileCheckpoint = { size: 10, mtimeMs: 1, offset: 10, identity: null, generation: null, parserState: null, partial: null, parserVersion: 2, lastReadAt: 1 };
// node:sqlite is available in the VS Code/Node 22 runtime, not in the Node 20
// compatibility lane. JSON snapshot tests in historical-reconciliation.test.ts
// continue to run on both versions.
const sqliteAvailable = Number(process.versions.node.split('.')[0]) >= 22;

async function storedFixture(run: (db: SessionDatabase) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'historical-coverage-'));
  const db = new SessionDatabase(dir);
  try {
    expect(await db.open()).toBe(true);
    run(db);
    db.close();
    return { snapshot: await readSqliteSnapshot(path.join(dir, 'insights.sqlite')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) { db.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
}
function insert(db: SessionDatabase, id: string, file: string, session: string, total: number, options: { fingerprint?: string; timestamp?: string; parent?: string; last?: number } = {}) {
  const timestamp = options.timestamp ?? '2026-01-01T00:00:00.000Z';
  const value = counters(total), recent = options.last === undefined ? undefined : counters(options.last);
  const observation: CounterObservation = { id, key: `key-${id}`, sourceFile: file, sessionId: session, parentSessionId: options.parent, timestamp,
    input: value.input, cached: value.cached, output: value.output, reasoning: value.reasoning,
    lastInput: recent?.input, lastCached: recent?.cached, lastOutput: recent?.output, lastReasoning: recent?.reasoning, decision: 'counted' };
  db.applyIncremental({ file, checkpoint, observations: [observation], events: [{ id, fingerprint: options.fingerprint, sourceFile: file, sessionId: session, timestamp,
    inputTokens: value.input, cachedInputTokens: value.cached, outputTokens: value.output, reasoningOutputTokens: value.reasoning }] });
}
function evidenceFrom(snapshot: Awaited<ReturnType<typeof readSqliteSnapshot>>): SourceEvidence[] {
  const fingerprints = new Map(snapshot.events.map(item => [item.id, item.fingerprint]));
  return snapshot.observations.map(item => ({ ...item, eventFingerprint: fingerprints.get(item.id) }));
}

describe.skipIf(!sqliteAvailable)('historical coverage on storage-valid SQLite 6 snapshots', () => {
  it('cannot store a second non-null exact fingerprint; the confirmation rule is only a fallback for inconsistent snapshots', async () => {
    const fixture = await storedFixture(db => {
      insert(db, 'a', 'first.jsonl', 'thread', 100, { fingerprint: 'identical' });
      insert(db, 'b', 'copy.jsonl', 'thread', 100, { fingerprint: 'identical' });
    });
    try {
      expect(fixture.snapshot.events).toHaveLength(1);
      const plan = reconcileHistory(fixture.snapshot, evidenceFrom(fixture.snapshot));
      expect(plan.summary.classifications.confirmed_duplicate).toBe(0);
      expect(plan.summary.current.input).toBe(100);
    } finally { fixture.cleanup(); }
  });

  it('surfaces a semantic rewrite with distinct fingerprints as a candidate, never a subtraction', async () => {
    const fixture = await storedFixture(db => {
      insert(db, 'a', 'old.jsonl', 'thread', 100, { fingerprint: 'old-fingerprint' });
      insert(db, 'b', 'rewritten.jsonl', 'thread', 100, { fingerprint: 'new-fingerprint', timestamp: '2026-01-01T00:01:00.000Z' });
    });
    try {
      const plan = reconcileHistory(fixture.snapshot, evidenceFrom(fixture.snapshot));
      expect(plan.summary.candidateCounts.rewritten_observation).toBe(2);
      expect(plan.adjustments).toHaveLength(0);
      expect(plan.summary.proposed.input).toBe(200);
      expect(validatePlan(plan, fixture.snapshot, evidenceFrom(fixture.snapshot)).valid).toBe(true);
    } finally { fixture.cleanup(); }
  });

  it('does not confuse independent forks with equal counters and timestamps', async () => {
    const fixture = await storedFixture(db => {
      insert(db, 'left', 'left.jsonl', 'fork-left', 20, { fingerprint: 'left-fingerprint' });
      insert(db, 'right', 'right.jsonl', 'fork-right', 20, { fingerprint: 'right-fingerprint' });
    });
    try {
      const plan = reconcileHistory(fixture.snapshot, evidenceFrom(fixture.snapshot));
      expect(plan.summary.candidateCounts.repeated_cumulative).toBe(0);
      expect(plan.adjustments).toHaveLength(0);
      expect(plan.summary.current.input).toBe(40);
    } finally { fixture.cleanup(); }
  });

  it('proposes only an explicitly proven inherited parent base in a valid persisted database', async () => {
    const fixture = await storedFixture(db => {
      insert(db, 'parent', 'parent.jsonl', 'parent', 150, { fingerprint: 'parent-fp' });
      insert(db, 'child', 'child.jsonl', 'child', 170, { fingerprint: 'child-fp', parent: 'parent', last: 20, timestamp: '2026-01-01T00:01:00.000Z' });
    });
    try {
      const plan = reconcileHistory(fixture.snapshot, evidenceFrom(fixture.snapshot));
      expect(plan.summary.candidateCounts.possible_inherited_base).toBe(1);
      expect(plan.adjustments).toHaveLength(1);
      expect(plan.adjustments[0].difference).toEqual(counters(150));
      expect(plan.adjustments[0].proposed).toEqual(counters(20));
      expect(plan.summary.proposed).toEqual(counters(170));
    } finally { fixture.cleanup(); }
  });

  it('keeps technical IDs and an archived source as reviewable leads without adjusting counters', async () => {
    const fixture = await storedFixture(db => {
      insert(db, 'technical', 'archived.jsonl#archived:1', 'ctco_synthetic', 100, { fingerprint: 'technical-fp' });
      insert(db, 'canonical', 'current.jsonl', 'thread', 100, { fingerprint: 'canonical-fp' });
    });
    try {
      const evidence = evidenceFrom(fixture.snapshot).filter(item => item.id === 'canonical');
      const plan = reconcileHistory(fixture.snapshot, evidence);
      expect(plan.summary.candidateCounts.archived_generation).toBe(1);
      expect(plan.summary.candidateCounts.technical_id_attribution).toBe(1);
      expect(plan.summary.classifications.unverifiable_legacy).toBe(1);
      expect(plan.adjustments).toHaveLength(0);
    } finally { fixture.cleanup(); }
  });
});
