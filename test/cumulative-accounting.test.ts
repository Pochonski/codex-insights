import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/collectors/sessions';
import { aggregate } from '../src/analytics/aggregate';
import { SessionDatabase } from '../src/storage/session-db';

const meta = (id: string, parent?: string) => JSON.stringify({ type: 'session_meta', payload: { id, ...(parent ? { forked_from_id: parent } : {}) } });
const usage = (input: number, at: string, cached = 0, last?: number) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0, cached_input_tokens: cached, reasoning_output_tokens: 0 }, ...(last === undefined ? {} : { last_token_usage: { input_tokens: last, output_tokens: 0, cached_input_tokens: Math.min(last, cached), reasoning_output_tokens: 0 } }) } } });
const line = (...rows: string[]) => rows.join('\n') + '\n';

function env() { const dir = mkdtempSync(path.join(tmpdir(), 'codex-accounting-')); const root = path.join(dir, 'sessions'); mkdirSync(root); return { dir, root, state: path.join(dir, 'index.json'), file: (name: string) => path.join(root, name + '.jsonl') }; }
async function sqliteModule(): Promise<typeof import('node:sqlite') | undefined> { try { return await import('node:sqlite'); } catch { return undefined; } }

describe('cumulative usage lineage', () => {
  it('does not count a continuation baseline twice (170, not 320), including after restart', async () => {
    const f = env();
    try {
      writeFileSync(f.file('base'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z'), usage(150, '2026-01-01T00:01:00Z')));
      let index = new SessionIndex(f.state);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(150);
      index.close();
      writeFileSync(f.file('continuation'), line(meta('thread'), usage(150, '2026-01-01T00:02:00Z'), usage(170, '2026-01-01T00:03:00Z')));
      index = new SessionIndex(f.state);
      const scan = await index.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(170);
      expect(scan.warnings.some(value => value.includes('Ambiguous inherited'))).toBe(true);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('seeds a legacy v0.4.1 checkpoint before importing a new continuation', async () => {
    const f = env();
    try {
      writeFileSync(f.file('base'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z'), usage(150, '2026-01-01T00:01:00Z')));
      const initial = new SessionIndex(f.state); await initial.scan(f.root); initial.close();
      const sqlite = await sqliteModule();
      if (sqlite) {
        const raw = new sqlite.DatabaseSync(path.join(f.dir, 'insights.sqlite'));
        raw.exec('DELETE FROM counter_observations'); raw.close();
      }
      const fs = await import('node:fs');
      const state = JSON.parse(fs.readFileSync(f.state, 'utf8')) as Array<{ observations?: unknown[] }>;
      for (const entry of state) delete entry.observations;
      fs.writeFileSync(f.state, JSON.stringify(state));
      writeFileSync(f.file('continuation'), line(meta('thread'), usage(150, '2026-01-01T00:02:00Z'), usage(170, '2026-01-01T00:03:00Z')));
      const upgraded = new SessionIndex(f.state);
      const scan = await upgraded.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(170);
      expect(scan.warnings.some(item => item.includes('Legacy token history'))).toBe(true);
      upgraded.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('orders new rollouts by source observation time rather than filename', async () => {
    const f = env();
    try {
      writeFileSync(f.file('z-parent'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z'), usage(150, '2026-01-01T00:01:00Z')));
      writeFileSync(f.file('a-continuation'), line(meta('thread'), usage(150, '2026-01-01T00:02:00Z'), usage(170, '2026-01-01T00:03:00Z')));
      const index = new SessionIndex(f.state);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('imports an appended parent counter before a simultaneously discovered continuation', async () => {
    const f = env();
    try {
      writeFileSync(f.file('z-parent'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z')));
      const index = new SessionIndex(f.state);
      await index.scan(f.root);
      appendFileSync(f.file('z-parent'), line(usage(150, '2026-01-01T00:01:00Z')));
      writeFileSync(f.file('a-continuation'), line(meta('thread'), usage(150, '2026-01-01T00:02:00Z'), usage(170, '2026-01-01T00:03:00Z')));
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('counts independent branch increments above a shared, explicitly linked base', async () => {
    const f = env();
    try {
      writeFileSync(f.file('a-parent'), line(meta('parent'), usage(150, '2026-01-01T00:00:00Z')));
      writeFileSync(f.file('b-left'), line(meta('left', 'parent'), usage(150, '2026-01-01T00:00:00Z'), usage(170, '2026-01-01T00:02:00Z')));
      writeFileSync(f.file('c-right'), line(meta('right', 'parent'), usage(150, '2026-01-01T00:03:00Z'), usage(180, '2026-01-01T00:04:00Z')));
      const index = new SessionIndex(f.state);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(200);
      index.close();
      const db = new SessionDatabase(f.dir); await db.open();
      const decisions = db.available
        ? [...db.read().values()].flatMap(item => (item.observations ?? []).map(observation => observation.decision))
        : (JSON.parse((await import('node:fs')).readFileSync(f.state, 'utf8')) as Array<{ observations?: Array<{ decision: string }> }>).flatMap(item => (item.observations ?? []).map(observation => observation.decision));
      expect(decisions).toContain('inherited');
      expect(decisions).toContain('ambiguous');
      db.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('deduplicates rewritten observations despite changed tool item IDs', async () => {
    const f = env();
    try {
      const first = line(meta('thread'), JSON.stringify({ type: 'response_item', payload: { id: 'ctco_first' } }), usage(100, '2026-01-01T00:00:00Z'));
      const second = line(meta('thread'), JSON.stringify({ type: 'response_item', payload: { id: 'ctco_rewritten' } }), usage(100, '2026-01-01T00:00:00Z'));
      writeFileSync(f.file('a'), first); writeFileSync(f.file('b'), second);
      const index = new SessionIndex(f.state);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(100);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('counts only the increment after a rewritten file replays its former counter head',async()=>{const f=env();try{
    writeFileSync(f.file('rollout'),line(meta('thread'),usage(100,'2026-01-01T00:00:00Z'),usage(150,'2026-01-01T00:01:00Z')));
    const index=new SessionIndex(f.state);try{expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(150);
      writeFileSync(f.file('rollout'),line(meta('thread'),usage(100,'2026-01-01T00:02:00Z'),usage(150,'2026-01-01T00:03:00Z'),usage(170,'2026-01-01T00:04:00Z')));
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
    }finally{index.close();}
  }finally{rmSync(f.dir,{recursive:true,force:true});}});

  it('does not invent a delta when a rewritten sequence skips the former head',async()=>{const f=env();try{
    writeFileSync(f.file('rollout'),line(meta('thread'),usage(100,'2026-01-01T00:00:00Z'),usage(150,'2026-01-01T00:01:00Z')));
    const index=new SessionIndex(f.state);try{await index.scan(f.root);
      writeFileSync(f.file('rollout'),line(meta('thread'),usage(100,'2026-01-01T00:02:00Z'),usage(200,'2026-01-01T00:03:00Z')));
      const scan=await index.scan(f.root);expect(aggregate(scan.events).total.inputTokens).toBe(150);expect(scan.warnings.join(' ')).toContain('did not replay its prior counter head');
      appendFileSync(f.file('rollout'),usage(220,'2026-01-01T00:04:00Z')+'\n');expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
    }finally{index.close();}
  }finally{rmSync(f.dir,{recursive:true,force:true});}});

  it('preserves typed last usage when a rewritten sequence skips the former head',async()=>{const f=env();try{
    writeFileSync(f.file('rollout'),line(meta('thread'),usage(100,'2026-01-01T00:00:00Z'),usage(150,'2026-01-01T00:01:00Z')));
    const index=new SessionIndex(f.state);try{await index.scan(f.root);
      writeFileSync(f.file('rollout'),line(meta('thread'),usage(100,'2026-01-01T00:02:00Z'),usage(200,'2026-01-01T00:03:00Z',0,50)));
      const scan=await index.scan(f.root);expect(aggregate(scan.events).total.inputTokens).toBe(200);expect(scan.warnings.join(' ')).toContain('did not replay its prior counter head');
    }finally{index.close();}
  }finally{rmSync(f.dir,{recursive:true,force:true});}});

  it('does not add a rewritten cumulative sequence when timestamps and item IDs change', async () => {
    const f = env();
    try {
      writeFileSync(f.file('original'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z'), usage(150, '2026-01-01T00:01:00Z')));
      const index = new SessionIndex(f.state);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(150);
      writeFileSync(f.file('rewritten'), line(meta('thread'), JSON.stringify({ type: 'response_item', payload: { id: 'ctco_new' } }), usage(100, '2026-01-01T00:02:00Z'), usage(150, '2026-01-01T00:03:00Z')));
      const scan = await index.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(150);
      appendFileSync(f.file('rewritten'), line(usage(170, '2026-01-01T00:04:00Z')));
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('uses last usage for the first independent fork event above an inherited parent base', async () => {
    const f = env();
    try {
      writeFileSync(f.file('z-parent'), line(meta('parent'), usage(150, '2026-01-01T00:00:00Z')));
      writeFileSync(f.file('a-child'), line(meta('child', 'parent'), usage(170, '2026-01-01T00:01:00Z', 0, 20)));
      const index = new SessionIndex(f.state);
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not claim an inherited cumulative base when the ancestor file is missing', async () => {
    const f = env();
    try {
      writeFileSync(f.file('continuation'), line(meta('thread'), usage(100_020, '2026-01-01T00:00:00Z', 90_010, 20)));
      const index = new SessionIndex(f.state);
      const scan = await index.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(20);
      expect(scan.warnings.some(item => item.includes('Unverified initial cumulative baseline'))).toBe(true);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('does not count a cached inherited baseline, but counts new cached tokens', async () => {
    const f = env();
    try {
      writeFileSync(f.file('base'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z', 90)));
      writeFileSync(f.file('next'), line(meta('thread'), usage(100, '2026-01-01T00:01:00Z', 90), usage(170, '2026-01-01T00:02:00Z', 155)));
      const index = new SessionIndex(f.state);
      const totals = aggregate((await index.scan(f.root)).events).total;
      expect(totals.inputTokens).toBe(170);
      expect(totals.cachedInputTokens).toBe(155);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps a partial continuation line across restart and archives a replaced generation', async () => {
    const f = env();
    try {
      writeFileSync(f.file('base'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z')));
      let index = new SessionIndex(f.state); await index.scan(f.root); index.close();
      const pending = usage(150, '2026-01-01T00:01:00Z', 0, 50);
      writeFileSync(f.file('continuation'), line(meta('thread')) + pending);
      index = new SessionIndex(f.state); expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(100); index.close();
      appendFileSync(f.file('continuation'), '\n');
      index = new SessionIndex(f.state); expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(150); index.close();
      renameSync(f.file('continuation'), f.file('old-generation'));
      writeFileSync(f.file('continuation'), line(meta('thread'), pending, usage(170, '2026-01-01T00:02:00Z')));
      index = new SessionIndex(f.state); expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(170); index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('retains observations transactionally in SQLite and supports the JSON fallback', async () => {
    const f = env();
    try {
      writeFileSync(f.file('base'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z')));
      let index = new SessionIndex(f.state); await index.scan(f.root); index.close();
      const db = new SessionDatabase(f.dir); await db.open();
      if (db.available) expect([...db.read().values()].flatMap(item => item.observations ?? [])).toHaveLength(1);
      else expect((JSON.parse((await import('node:fs')).readFileSync(f.state, 'utf8')) as Array<{ observations?: unknown[] }>).flatMap(item => item.observations ?? [])).toHaveLength(1);
      db.close();
      class UnavailableDatabase extends SessionDatabase { override async open() { return false; } }
      writeFileSync(f.file('next'), line(meta('thread'), usage(100, '2026-01-01T00:01:00Z'), usage(120, '2026-01-01T00:02:00Z')));
      index = new SessionIndex(f.state, new UnavailableDatabase(f.dir));
      expect(aggregate((await index.scan(f.root)).events).total.inputTokens).toBe(120);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('produces equivalent accounting with SQLite and JSON fallback after restart and refresh', async () => {
    const sqlite = await sqliteModule(); if (!sqlite) return;
    const left = env(), right = env();
    class UnavailableDatabase extends SessionDatabase { override async open() { return false; } }
    try {
      for (const f of [left, right]) {
        writeFileSync(f.file('base'), line(meta('thread'), usage(100, '2026-01-01T00:00:00Z', 80), usage(150, '2026-01-01T00:01:00Z', 120)));
      }
      let sql = new SessionIndex(left.state);
      let json = new SessionIndex(right.state, new UnavailableDatabase(right.dir));
      await sql.scan(left.root); await json.scan(right.root);
      sql.close(); json.close();
      for (const f of [left, right]) {
        writeFileSync(f.file('continuation'), line(meta('thread'), usage(150, '2026-01-01T00:02:00Z', 120), usage(170, '2026-01-01T00:03:00Z', 138)));
      }
      sql = new SessionIndex(left.state);
      json = new SessionIndex(right.state, new UnavailableDatabase(right.dir));
      const sqlFirst = await sql.scan(left.root);
      const jsonFirst = await json.scan(right.root);
      expect(aggregate(sqlFirst.events).total).toEqual(aggregate(jsonFirst.events).total);
      expect(aggregate(sqlFirst.events).total.inputTokens).toBe(170);
      expect(aggregate(sqlFirst.events).total.cachedInputTokens).toBe(138);
      expect(aggregate((await sql.scan(left.root)).events).total).toEqual(aggregate((await json.scan(right.root)).events).total);
      sql.close(); json.close();
    } finally { rmSync(left.dir, { recursive: true, force: true }); rmSync(right.dir, { recursive: true, force: true }); }
  });

  it('rolls back events and observations together if checkpoint storage fails', async () => {
    if (!await sqliteModule()) return;
    const f = env();
    try {
      const db = new SessionDatabase(f.dir);
      await db.open();
      const timestamp = '2026-01-01T00:00:00.000Z';
      expect(() => db.applyIncremental({ file: 'synthetic.jsonl', checkpoint: { size: Number.NaN, mtimeMs: 1, offset: 1, identity: null, generation: null, parserState: null, partial: null, parserVersion: 2, lastReadAt: 1 }, events: [{ id: 'event', fingerprint: 'fingerprint', sourceFile: 'synthetic.jsonl', sessionId: 'thread', timestamp, inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }], observations: [{ id: 'observation', key: 'key', sourceFile: 'synthetic.jsonl', sessionId: 'thread', timestamp, input: 10, output: 0, cached: 0, reasoning: 0, decision: 'counted' }] })).toThrow();
      expect(db.read().size).toBe(0);
      db.applyIncremental({ file: 'synthetic.jsonl', checkpoint: { size: 10, mtimeMs: 1, offset: 10, identity: null, generation: null, parserState: null, partial: null, parserVersion: 2, lastReadAt: 1 }, events: [{ id: 'event', fingerprint: 'fingerprint', sourceFile: 'synthetic.jsonl', sessionId: 'thread', timestamp, inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }], observations: [{ id: 'observation', key: 'key', sourceFile: 'synthetic.jsonl', sessionId: 'thread', timestamp, input: 10, output: 0, cached: 0, reasoning: 0, decision: 'counted' }] });
      expect(db.read().get('synthetic.jsonl')?.events).toHaveLength(1);
      expect(db.read().get('synthetic.jsonl')?.observations).toHaveLength(1);
      db.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
