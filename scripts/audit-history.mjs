#!/usr/bin/env node
// Snapshot-only CLI. No path in this file opens Codex Insights production storage for writing.
import { build } from 'esbuild';
import { constants, existsSync } from 'node:fs';
import { mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--repair') || argv.includes('--apply')) {
  console.error('Historical repair is disabled. No source or storage file was modified.');
  process.exit(2);
}
const commands = new Set(['audit', 'plan', 'inspect', 'validate']);
const command = commands.has(argv[0]) ? argv.shift() : 'audit';
function argument(name) {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error('Missing value for ' + name);
  return argv[at + 1];
}
const dbFile = argument('--snapshot-db');
const jsonFile = argument('--snapshot-json');
const sources = argument('--sources');
const planFile = argument('--plan');
const output = argument('--output');
if (argv.includes('--help')) {
  console.log('Usage: npm run audit:history -- [audit|plan|inspect|validate] --snapshot-db <isolated insights.sqlite> [--sources <JSONL directory>] [--output <private plan.json>] [--plan <plan.json>]');
  console.log('Use --snapshot-json <isolated sessions-index.json> instead of --snapshot-db. Repair and apply are disabled.');
  process.exit(0);
}
const allowed = new Set(['--snapshot-db', '--snapshot-json', '--sources', '--plan', '--output']);
for (let i = 0; i < argv.length; i += 2) if (!allowed.has(argv[i]) || !argv[i + 1]) throw new Error('Unsupported argument. Use --help.');
if (command === 'inspect' && !planFile || command === 'plan' && !output || command === 'validate' && !planFile || command !== 'inspect' && (Number(!!dbFile) + Number(!!jsonFile)) !== 1) {
  throw new Error('A private plan path or exactly one isolated snapshot is required. Use --help.');
}
if (command === 'inspect' && (dbFile || jsonFile || sources || output)) throw new Error('inspect accepts only --plan.');
if (command !== 'plan' && output) throw new Error('--output is available only for plan.');

async function isolated(file) {
  const resolved = await realpath(file);
  const segments = resolved.split(path.sep).map(part => part.toLowerCase());
  if (segments.includes('globalstorage') || segments.includes('.codex')) throw new Error('Use an isolated private snapshot, not live extension or Codex storage.');
  if (!(await stat(resolved)).isFile()) throw new Error('Snapshot is not a regular file.');
  return resolved;
}
const temporary = await mkdtemp(path.join(tmpdir(), 'codex-insights-history-audit-'));
let stage = 'bundle';
try {
  const outfile = path.join(temporary, 'audit.mjs');
  await build({ stdin: { contents: `export * from ${JSON.stringify(path.resolve('src/reconciliation/historical.ts'))}; export * from ${JSON.stringify(path.resolve('src/reconciliation/snapshot.ts'))}; export * from ${JSON.stringify(path.resolve('src/collectors/sessions.ts'))}; export * from ${JSON.stringify(path.resolve('src/storage/session-db.ts'))};`, resolveDir: process.cwd(), sourcefile: 'history-entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const api = await import(pathToFileURL(outfile).href);
  if (command === 'inspect') {
    const plan = JSON.parse(await readFile(await isolated(planFile), 'utf8'));
    if (plan?.format !== 1 || plan?.applicationEnabled !== false || !plan.summary) throw new Error('Invalid private plan.');
    const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const vector = value => ({ input: number(value?.input), cached: number(value?.cached), output: number(value?.output), reasoning: number(value?.reasoning) });
    const counts = plan.summary.classifications;
    const summary = {
      eventsAnalyzed: number(plan.summary.eventsAnalyzed), observationsAnalyzed: number(plan.summary.observationsAnalyzed),
      sourceObservations: number(plan.summary.sourceObservations),
      classifications: { confirmed_duplicate: number(counts?.confirmed_duplicate), confirmed_unique: number(counts?.confirmed_unique), ambiguous: number(counts?.ambiguous), unverifiable_legacy: number(counts?.unverifiable_legacy) },
      current: vector(plan.summary.current), demonstrableAdjustment: vector(plan.summary.demonstrableAdjustment), proposed: vector(plan.summary.proposed),
      provenanceMatchedEvents: number(plan.summary.provenanceMatchedEvents),
      uncertainAdditionalAdjustment: 'not quantified', changesApplied: false,
    };
    console.log(JSON.stringify({ mode: 'inspect', summary, applicationEnabled: false }, null, 2));
  } else {
  stage = 'snapshot';
  const snapshot = dbFile ? await api.readSqliteSnapshot(await isolated(dbFile)) : api.readJsonSnapshot(await isolated(jsonFile));
  let evidence = [];
  let sourceWarnings = 0;
  let eventFingerprints = new Map();
  if (sources) {
    stage = 'sources';
    const sourceRoot = await realpath(sources);
    if (!(await stat(sourceRoot)).isDirectory()) throw new Error('Source root must be a directory.');
    const stateFile = path.join(temporary, 'source-index.json');
    const index = new api.SessionIndex(stateFile);
    try {
      stage = 'source scan';
      const scan = await index.scan(sourceRoot);
      sourceWarnings = scan.warnings.length;
      eventFingerprints = new Map(scan.events.filter(item => item.fingerprint).map(item => [item.id, item.fingerprint]));
    } finally { index.close(); }
    stage = 'source ledger';
    const sourceDb = new api.SessionDatabase(temporary);
    try {
      if (await sourceDb.open()) evidence = [...sourceDb.read().values()].flatMap(item => item.observations ?? []).map(item => ({
        id: item.id, key: item.key, sourceFile: item.sourceFile, sessionId: item.sessionId,
        eventFingerprint: eventFingerprints.get(item.id),
        parentSessionId: item.parentSessionId, timestamp: item.timestamp,
        total: { input: item.input, cached: item.cached, output: item.output, reasoning: item.reasoning },
        last: item.lastInput === undefined ? undefined : { input: item.lastInput, cached: item.lastCached, output: item.lastOutput, reasoning: item.lastReasoning },
        decision: item.decision,
      }));
      else {
        const raw = api.readJsonSnapshot(stateFile);
        evidence = raw.observations.map(item => ({ ...item, eventFingerprint: eventFingerprints.get(item.id) }));
      }
    } finally { sourceDb.close(); }
  }
  stage = 'reconciliation';
  const plan = api.reconcileHistory(snapshot, evidence);
  if (command === 'validate') {
    const prior = JSON.parse(await readFile(await isolated(planFile), 'utf8'));
    const result = api.validatePlan(prior, snapshot, evidence);
    console.log(JSON.stringify({ mode: 'validate', ...result, applicationEnabled: false }, null, 2));
    if (!result.valid) process.exitCode = 3;
  } else if (command === 'audit') {
    console.log(JSON.stringify({ mode: 'dry-run', summary: api.publicSummary(plan), sourceWarnings, snapshotOnly: true, applicationEnabled: false }, null, 2));
  } else {
    const destination = path.resolve(output);
    const repo = await realpath(process.cwd());
    const parent = await realpath(path.dirname(destination));
    if (parent === repo || parent.startsWith(repo + path.sep)) throw new Error('Private plans must be written outside the repository.');
    if (existsSync(destination)) throw new Error('Plan already exists; refusing to overwrite it.');
    const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(plan, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    console.log(JSON.stringify({ mode: 'plan', summary: api.publicSummary(plan), sourceWarnings, planId: plan.planId, privateOutputCreated: true, applicationEnabled: false }, null, 2));
  }
  }
} catch (error) {
  // Errors may contain private filenames. Keep CLI output deliberately generic.
  const kind = error instanceof Error ? error.name : 'UnknownError';
  const code = typeof error === 'object' && error && 'code' in error && typeof error.code === 'string' ? error.code : 'unclassified';
  console.error(`Historical audit failed at ${stage} (${kind}, ${code}). Check snapshot format, permissions and arguments; no repair was attempted.`);
  process.exitCode = 2;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
