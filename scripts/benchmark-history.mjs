#!/usr/bin/env node
// One synthetic size per process: node --expose-gc scripts/benchmark-history.mjs --size 100000
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const at = process.argv.indexOf('--size');
const count = Number(process.argv[at + 1]);
if (at < 0 || ![1_000, 10_000, 100_000, 200_000].includes(count)) throw new Error('Use --size 1000, 10000, 100000, or 200000.');
const temp = await mkdtemp(path.join(tmpdir(), 'codex-insights-history-bench-'));
try {
  const outfile = path.join(temp, 'engine.mjs');
  await build({ entryPoints: ['src/reconciliation/historical.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const { reconcileHistory } = await import(pathToFileURL(outfile).href);
  const memory = () => { global.gc?.(); const m = process.memoryUsage(); return { rssMiB: +(m.rss / 1048576).toFixed(2), heapMiB: +(m.heapUsed / 1048576).toFixed(2), externalMiB: +(m.external / 1048576).toFixed(2) }; };
  const initial = memory();
  const events = [];
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(9, '0');
    events.push({ id, fingerprint: 'fingerprint-' + id, sourceFile: '/synthetic/rollout-' + Math.floor(i / 100) + '.jsonl', sessionId: 'session-' + Math.floor(i / 100),
      timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), counters: { input: 100, cached: 80, output: 10, reasoning: 3 } });
  }
  const afterEvents = memory();
  const observations = events.map((event, i) => ({ id: event.id, key: 'key-' + event.id, sourceFile: event.sourceFile, sessionId: event.sessionId, timestamp: event.timestamp,
    total: { input: (i % 100 + 1) * 100, cached: (i % 100 + 1) * 80, output: (i % 100 + 1) * 10, reasoning: (i % 100 + 1) * 3 },
    last: event.counters, decision: 'counted' }));
  const afterLedger = memory();
  const start = performance.now();
  const plan = reconcileHistory({ storage: 'sqlite', schemaVersion: 6, events, observations, checkpoints: [] }, observations);
  const reconcileMs = performance.now() - start;
  const afterReconcile = memory();
  const serializeStart = performance.now();
  const planBytes = Buffer.byteLength(JSON.stringify(plan));
  const serializeMs = performance.now() - serializeStart;
  const afterPlan = memory();
  console.log(JSON.stringify({ size: count, platform: process.platform, architecture: process.arch, node: process.version, cpu: cpus()[0]?.model, systemMemoryGiB: +(totalmem() / 1073741824).toFixed(2),
    initial, afterEvents, afterLedger, afterReconcile, afterPlan, reconcileMs: +reconcileMs.toFixed(2), serializeMs: +serializeMs.toFixed(2), planMiB: +(planBytes / 1048576).toFixed(2),
    adjustments: plan.adjustments.length, inputCurrent: plan.summary.current.input, inputProposed: plan.summary.proposed.input, note: 'Whole Node benchmark process, not extension-host incremental memory or peak RSS.' }));
} finally { await rm(temp, { recursive: true, force: true }); }
