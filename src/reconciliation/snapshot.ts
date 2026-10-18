import { readFileSync } from 'node:fs';
import type { Counters, HistoricalCheckpoint, HistoricalEvent, HistoricalObservation, HistoricalSnapshot } from './historical';

type Row = Record<string, unknown>;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number => typeof value === 'number' ? value : Number(value ?? 0);
const nullable = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const counters = (row: Row, prefix = ''): Counters => ({
  input: num(row[prefix + 'input']), cached: num(row[prefix + 'cached']), output: num(row[prefix + 'output']), reasoning: num(row[prefix + 'reasoning']),
});
const eventOf = (row: Row): HistoricalEvent => ({
  id: str(row.id), fingerprint: nullable(row.fingerprint), sourceFile: str(row.source_file), sessionId: str(row.session_id), timestamp: str(row.observed_at),
  counters: { input: num(row.input_tokens), cached: num(row.cached_input_tokens), output: num(row.output_tokens), reasoning: num(row.reasoning_output_tokens) },
});
const observationOf = (row: Row): HistoricalObservation => ({
  id: str(row.id), key: str(row.observation_key), sourceFile: str(row.source_file), sessionId: str(row.session_id),
  parentSessionId: nullable(row.parent_session_id), timestamp: str(row.observed_at),
  total: counters({ input: row.input_total, cached: row.cached_total, output: row.output_total, reasoning: row.reasoning_total }),
  last: row.last_input === null || row.last_input === undefined ? undefined : counters({ input: row.last_input, cached: row.last_cached, output: row.last_output, reasoning: row.last_reasoning }),
  decision: str(row.decision),
});
const checkpointOf = (row: Row): HistoricalCheckpoint => ({ sourceFile: str(row.source_file), size: num(row.size), offset: num(row.offset),
  generation: nullable(row.generation), parserVersion: num(row.parser_version), parserState: nullable(row.parser_state) });

/** Reads an isolated SQLite snapshot. Opening a live WAL database is intentionally outside this API's contract. */
export async function readSqliteSnapshot(file: string): Promise<HistoricalSnapshot> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!has('token_events')) throw new Error('Snapshot has no token_events table.');
    const version = has('schema_migrations') ? Number((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as Row)?.version ?? 0) : 0;
    const events: HistoricalEvent[] = [];
    for (const row of db.prepare('SELECT * FROM token_events ORDER BY id').iterate()) events.push(eventOf(row as Row));
    const observations: HistoricalObservation[] = [];
    if (has('counter_observations')) for (const row of db.prepare('SELECT * FROM counter_observations ORDER BY id').iterate()) observations.push(observationOf(row as Row));
    const checkpoints: HistoricalCheckpoint[] = [];
    if (has('import_state')) for (const row of db.prepare('SELECT * FROM import_state ORDER BY source_file').iterate()) checkpoints.push(checkpointOf(row as Row));
    return { storage: 'sqlite', schemaVersion: version, events, observations, checkpoints };
  } finally { db.close(); }
}

/** The JSON fallback is read as bytes, never opened through SessionIndex (which can write). */
export function readJsonSnapshot(file: string): HistoricalSnapshot {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const entries: [string, Row][] = Array.isArray(parsed)
    ? parsed.filter((item): item is Row => !!item && typeof item === 'object' && typeof item.file === 'string').map(item => [str(item.file), item])
    : parsed && typeof parsed === 'object' ? Object.entries(parsed as Record<string, Row>) : [];
  const events: HistoricalEvent[] = [], observations: HistoricalObservation[] = [], checkpoints: HistoricalCheckpoint[] = [];
  for (const [sourceFile, entry] of entries) {
    checkpoints.push({ sourceFile, size: num(entry.size), offset: num(entry.offset), generation: nullable(entry.generation), parserVersion: num(entry.parserVersion), parserState: nullable(entry.parserState) });
    for (const item of Array.isArray(entry.events) ? entry.events : []) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Row;
      events.push({ id: str(row.id), fingerprint: nullable(row.fingerprint), sourceFile,
        sessionId: str(row.sessionId), timestamp: str(row.timestamp),
        counters: { input: num(row.inputTokens), cached: num(row.cachedInputTokens), output: num(row.outputTokens), reasoning: num(row.reasoningOutputTokens) } });
    }
    for (const item of Array.isArray(entry.observations) ? entry.observations : []) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Row;
      observations.push({ id: str(row.id), key: str(row.key), sourceFile, sessionId: str(row.sessionId),
        parentSessionId: nullable(row.parentSessionId), timestamp: str(row.timestamp),
        total: { input: num(row.input), cached: num(row.cached), output: num(row.output), reasoning: num(row.reasoning) },
        last: row.lastInput === undefined ? undefined : { input: num(row.lastInput), cached: num(row.lastCached), output: num(row.lastOutput), reasoning: num(row.lastReasoning) },
        decision: str(row.decision) });
    }
  }
  return { storage: 'json', schemaVersion: observations.length ? 6 : 5, events, observations, checkpoints };
}
