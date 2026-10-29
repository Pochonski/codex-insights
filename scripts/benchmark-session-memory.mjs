import {build} from 'esbuild';
import {appendFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

if (typeof global.gc !== 'function') throw new Error('Run with node --expose-gc.');
const count = Number(process.argv[2] ?? 1000);
const perFile = Number(process.argv[3] ?? 100);
if (!Number.isSafeInteger(count) || count < 1 || count > 2000 || !Number.isSafeInteger(perFile) || perFile < 1 || perFile > 200) {
  throw new Error('Usage: node --expose-gc scripts/benchmark-session-memory.mjs [1..2000 files] [1..200 events per file]');
}

const dir = await mkdtemp(path.join(tmpdir(), 'codex-insights-memory-'));
const moduleFile = path.join(dir, 'index.mjs');
const sessions = path.join(dir, 'sessions');
const storage = path.join(dir, 'storage');
const measurements = [];
const measure = (phase, scan) => {
  global.gc();
  const memory = process.memoryUsage();
  measurements.push({
    phase,
    rssMiB: Number((memory.rss / 1048576).toFixed(1)),
    heapUsedMiB: Number((memory.heapUsed / 1048576).toFixed(1)),
    externalMiB: Number((memory.external / 1048576).toFixed(1)),
    ...(scan ? {scanMs: Number(scan.metrics.durationMs.toFixed(2)), bytesRead: scan.metrics.bytesRead, events: scan.events.length} : {}),
  });
};
const usage = (index) => JSON.stringify({
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  type: 'event_msg',
  payload: {type: 'token_count', info: {total_token_usage: {
    input_tokens: index * 100,
    output_tokens: index * 20,
    cached_input_tokens: index * 80,
    reasoning_output_tokens: index * 2,
  }}},
});

try {
  await build({
    stdin: {contents: `export {SessionIndex} from ${JSON.stringify(path.join(process.cwd(), 'src/collectors/sessions.ts'))};`, resolveDir: process.cwd(), sourcefile: 'memory-entry.ts', loader: 'ts'},
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: moduleFile, logLevel: 'silent',
  });
  const {SessionIndex} = await import(pathToFileURL(moduleFile).href);
  await mkdir(sessions);
  await mkdir(storage);
  measure('start');
  for (let file = 0; file < count; file++) {
    const rows = [JSON.stringify({type: 'session_meta', payload: {id: `synthetic-${file}`}})];
    for (let index = 1; index <= perFile; index++) rows.push(usage(index));
    await writeFile(path.join(sessions, `session-${file}.jsonl`), rows.join('\n') + '\n');
  }
  measure('fixtures-written');
  const index = new SessionIndex(path.join(storage, 'sessions-index.json'));
  try {
    let scan = await index.scan(sessions);
    measure('first-import', scan);
    scan = await index.scan(sessions);
    measure('unchanged-refresh', scan);
    scan = undefined;
    for (let file = 0; file < count; file += 10) {
      await appendFile(path.join(sessions, `session-${file}.jsonl`), usage(perFile + 1) + '\n');
    }
    scan = await index.scan(sessions);
    measure('changed-refresh', scan);
    scan = undefined;
  } finally {
    index.close();
  }
  measure('after-close');
  console.log(JSON.stringify({node: process.version, platform: `${process.platform} ${process.arch}`, files: count, eventsPerFile: perFile, synthetic: true, gcBeforeMeasurements: true, measurements}, null, 2));
} finally {
  await rm(dir, {recursive: true, force: true});
}
