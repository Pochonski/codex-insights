#!/usr/bin/env node
// Read-only reconciliation preview. All indexing is performed in a disposable directory.
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--repair')) {
  console.error('Repair is intentionally locked: legacy rows need a reviewed, evidence-linked change plan and a verified backup. No database was modified.');
  process.exit(2);
}
const sessions = option('--sessions');
if (!sessions || args.includes('--help')) {
  console.log('Usage: npm run audit:tokens -- --sessions <JSONL directory> [--baseline-db <SQLite database>]');
  process.exit(sessions ? 0 : 2);
}
const temporary = await mkdtemp(path.join(tmpdir(), 'codex-insights-token-audit-'));
try {
  const outfile = path.join(temporary, 'collector.mjs');
  await build({ stdin: { contents: `export * from ${JSON.stringify(path.resolve('src/collectors/sessions.ts'))}; export * from ${JSON.stringify(path.resolve('src/storage/session-db.ts'))}; export * from ${JSON.stringify(path.resolve('src/analytics/aggregate.ts'))};`, resolveDir: process.cwd(), sourcefile: 'audit-entry.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'silent' });
  const { SessionIndex, SessionDatabase, aggregate, parseSession, findSessionFiles } = await import(pathToFileURL(outfile).href);
  const files = await findSessionFiles(sessions);
  const independent = aggregate((await Promise.all(files.map(async file => parseSession(await readFile(file, 'utf8'), file)))).flat()).total;
  const index = new SessionIndex(path.join(temporary, 'index.json'));
  const scan = await index.scan(sessions);
  const proposed = aggregate(scan.events).total;
  const difference = Object.fromEntries(Object.keys(proposed).map(key => [key, independent[key] - proposed[key]]));
  index.close();
  const db = new SessionDatabase(temporary);
  await db.open();
  const observations = [...db.read().values()].flatMap(item => item.observations ?? []);
  db.close();
  const decisions = Object.fromEntries(['counted', 'duplicate', 'inherited', 'ambiguous'].map(decision => [decision, observations.filter(item => item.decision === decision).length]));
  let baseline = null;
  const baselineFile = option('--baseline-db');
  if (baselineFile) {
    const sqlite = await import('node:sqlite');
    const source = new sqlite.DatabaseSync(baselineFile, { readOnly: true });
    try {
      baseline = source.prepare('SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(cached_input_tokens),0) AS cached, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(reasoning_output_tokens),0) AS reasoning FROM token_events').get();
    } finally { source.close(); }
  }
  const categories = ['Ambiguous inherited', 'Ambiguous fork', 'Unverified initial', 'Legacy token history', 'Some cumulative token', 'Skipped invalid', 'Skipped oversized', 'Could not index', 'Codex session folder'];
  const warnings = [...new Set(scan.warnings.map(message => categories.find(category => message.startsWith(category)) ?? 'Other warning'))];
  console.log(JSON.stringify({ mode: 'dry-run', writesToSource: false, syntheticOrLocal: 'determined by --sessions', filesInspected: scan.metrics.filesInspected, bytesRead: scan.metrics.bytesRead, decisions, independentFileTotals: independent, proposedFromAvailableFiles: proposed, differenceFromIndependentFiles: difference, baselineStoredTotals: baseline, coverage: baseline ? 'Not established: archived or missing JSONL may contribute stored events; do not subtract these totals or run a repair.' : 'Only supplied JSONL files were evaluated.', ambiguousObservationsRequireReview: decisions.ambiguous, warningCategories: warnings }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
