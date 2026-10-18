import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type UsageEvent } from '../core/types';
import {
  SESSION_PARSER_VERSION,
  SessionDatabase,
  type CounterObservation,
  type FileCheckpoint,
  type IncrementalFileUpdate,
  type IndexedFile,
} from '../storage/session-db';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const SAMPLE_BYTES = 4096;

interface TokenTotals {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
}

function totalsKey(session: string, value: TokenTotals): string {
  return JSON.stringify([session, value.input, value.output, value.cached, value.reasoning]);
}

class CounterLookup {
  private readonly keys = new Set<string>();
  private readonly totals = new Set<string>();
  private readonly totalSources = new Map<string, Set<string>>();
  private readonly timed = new Set<string>();
  private readonly sessions = new Set<string>();
  constructor(items: CounterObservation[] = []) { for (const item of items) this.add(item); }
  add(item: CounterObservation): void {
    this.keys.add(item.key);
    const totalKey = totalsKey(item.sessionId, { input: item.input, output: item.output, cached: item.cached, reasoning: item.reasoning });
    this.totals.add(totalKey);
    let sources = this.totalSources.get(totalKey);
    if (!sources) { sources = new Set<string>(); this.totalSources.set(totalKey, sources); }
    sources.add(item.sourceFile);
    this.timed.add(JSON.stringify([item.sessionId, item.timestamp, item.input, item.output, item.cached, item.reasoning]));
    this.sessions.add(item.sessionId);
  }
  hasKey(key: string): boolean { return this.keys.has(key); }
  hasTotal(session: string, value: TokenTotals): boolean { return this.totals.has(totalsKey(session, value)); }
  hasTotalInOtherSource(session: string, value: TokenTotals, sourceFile: string): boolean {
    const sources = this.totalSources.get(totalsKey(session, value));
    return !!sources && [...sources].some(source => source !== sourceFile);
  }
  hasTotalAt(session: string, timestamp: string, value: TokenTotals): boolean { return this.timed.has(JSON.stringify([session, timestamp, value.input, value.output, value.cached, value.reasoning])); }
  hasSession(session: string): boolean { return this.sessions.has(session); }
}

interface ParserState {
  sessionId?: string;
  // Set only from session_meta. Response item payload.id identifies an item, not a session.
  canonicalSessionId?: string;
  parentSessionId?: string;
  // Preserve the v0.4.1 fingerprint scheme so copied legacy records still deduplicate.
  fingerprintSessionId?: string;
  metadataChecked?: boolean;
  project?: string;
  model?: string;
  lastTotals?: TokenTotals;
  lastTimestamp?: number;
}

export interface ScanMetrics {
  filesInspected: number;
  filesModified: number;
  bytesRead: number;
  eventsNew: number;
  eventsDeduplicated: number;
  parseErrors: number;
  durationMs: number;
}

export interface SessionScanResult {
  filesScanned: number;
  events: UsageEvent[];
  warnings: string[];
  metrics: ScanMetrics;
}

interface ParseResult {
  events: UsageEvent[];
  observations: CounterObservation[];
  state: ParserState;
  confirmedBytes: number;
  partial: Buffer;
  warnings: string[];
}

interface FileImportResult {
  file: IndexedFile;
  update: IncrementalFileUpdate;
  archiveFile?: string;
  metrics: Pick<ScanMetrics, 'bytesRead' | 'eventsNew' | 'eventsDeduplicated' | 'parseErrors'>;
  warnings: string[];
}

export interface SessionSource {
  readonly root: string;
  readonly stateFile: string;
  readonly maxFiles: number;
  findSessionFiles(): Promise<string[]>;
}

export class DefaultSessionSource implements SessionSource {
  public readonly root: string;
  public readonly stateFile: string;
  public readonly maxFiles: number;

  public constructor(root = path.join(os.homedir(), '.codex', 'sessions'), stateFile = path.join(os.homedir(), '.codex-insights', 'session-index.json'), maxFiles = 2000) {
    this.root = root;
    this.stateFile = stateFile;
    this.maxFiles = maxFiles;
  }

  public async findSessionFiles(): Promise<string[]> {
    const results: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await visit(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    };
    await visit(this.root);
    // Deterministic selection: keep the newest names when the discovery limit truncates.
    results.sort();
    return results.slice(Math.max(0, results.length - this.maxFiles));
  }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function totalsOf(record: Record<string, unknown>): TokenTotals | undefined {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
  if (record.type !== 'event_msg' || payload.type !== 'token_count') return undefined;
  const info = payload.info && typeof payload.info === 'object' ? payload.info as Record<string, unknown> : {};
  // A token_count event's typed cumulative field takes precedence. Generic
  // `usage` objects have event-specific semantics and are not thread totals.
  const usage = info.total_token_usage ?? payload.total_token_usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const data = usage as Record<string, unknown>;
  const input = numberValue(data.input_tokens ?? data.input);
  const output = numberValue(data.output_tokens ?? data.output);
  const cached = numberValue(data.cached_input_tokens ?? data.cached_input ?? data.cache_read_input_tokens);
  const reasoning = numberValue(data.reasoning_output_tokens ?? data.reasoning);
  if (input === 0 && output === 0 && cached === 0 && reasoning === 0) {
    return undefined;
  }
  return { input, output, cached, reasoning };
}

function lastUsageOf(record: Record<string, unknown>): TokenTotals | undefined {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
  const info = payload.info && typeof payload.info === 'object' ? payload.info as Record<string, unknown> : {};
  const raw = info.last_token_usage;
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const fields = [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.reasoning_output_tokens];
  if (fields.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return undefined;
  return { input: fields[0] as number, output: fields[1] as number, cached: fields[2] as number, reasoning: fields[3] as number };
}

function projectOf(record: Record<string, unknown>): string | undefined {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
  const candidates = [record.project, record.cwd, record.workspace, record.project_path, payload.project, payload.cwd];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function modelOf(record: Record<string, unknown>): string | undefined {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
  const candidates = [record.model, record.model_name, record.model_id, payload.model];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function initialState(): ParserState {
  return { metadataChecked: true };
}

function decodeState(value: string | null | undefined): ParserState {
  if (!value) {
    return initialState();
  }
  try {
    const parsed = JSON.parse(value) as ParserState;
    return parsed && typeof parsed === 'object' ? parsed : initialState();
  } catch {
    return initialState();
  }
}

function encodeState(value: ParserState): string {
  return JSON.stringify(value);
}

function fingerprint(record: Record<string, unknown>, sessionId: string): string {
  return createHash('sha256').update(sessionId).update(':').update(JSON.stringify(record)).digest('hex');
}

function stableEventId(sourceFile: string, lineOffset: number, record: Record<string, unknown>): string {
  return createHash('sha256').update(sourceFile).update(':').update(String(lineOffset)).update(':').update(JSON.stringify(record)).digest('hex').slice(0, 24);
}

function parseSessionBuffer(content: Buffer, sourceFile: string, previous: ParserState, baseOffset: number, known: CounterLookup = new CounterLookup()): ParseResult {
  const state: ParserState = { ...previous, lastTotals: previous.lastTotals ? { ...previous.lastTotals } : undefined };
  const events: UsageEvent[] = [];
  const observations: CounterObservation[] = [];
  const local = new CounterLookup();
  const warnings: string[] = [];
  let cursor = 0;
  let confirmedBytes = 0;

  while (cursor < content.length) {
    const newline = content.indexOf(0x0a, cursor);
    if (newline === -1) {
      break;
    }
    const end = newline > cursor && content[newline - 1] === 0x0d ? newline - 1 : newline;
    const line = content.subarray(cursor, end);
    const lineOffset = baseOffset + cursor;
    confirmedBytes = newline + 1;
    cursor = newline + 1;
    if (line.length === 0) {
      continue;
    }
    if (line.length > MAX_LINE_BYTES) {
      warnings.push('Skipped an oversized JSONL line in ' + path.basename(sourceFile) + '.');
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
    } catch {
      warnings.push('Skipped invalid JSONL in ' + path.basename(sourceFile) + '.');
      continue;
    }

    const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
    const legacyIdentity = [record.session_id, record.sessionId, payload.id]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (legacyIdentity) state.fingerprintSessionId = legacyIdentity;
    if (record.type === 'session_meta') {
      const candidateSession = [payload.session_id, payload.id, record.session_id, record.sessionId]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (candidateSession) {
        state.canonicalSessionId = candidateSession;
        state.sessionId = candidateSession;
      }
      const parent = payload.forked_from_id ?? payload.parent_thread_id;
      if (typeof parent === 'string' && parent.trim()) state.parentSessionId = parent;
    }
    state.project = projectOf(record) ?? state.project;
    state.model = modelOf(record) ?? state.model;
    const totals = totalsOf(record);
    if (!totals) {
      continue;
    }
    if (!state.canonicalSessionId) {
      const explicitSession = [record.session_id, record.sessionId]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (explicitSession) state.sessionId = explicitSession;
    }
    const sourceTimestamp = timestampValue(record.timestamp ?? record.created_at ?? record.time);
    const timestamp = sourceTimestamp ?? Date.now();
    const currentSession = state.canonicalSessionId ?? state.sessionId ?? createHash('sha256').update(sourceFile).digest('hex').slice(0, 16);
    const last = lastUsageOf(record);
    const observationKey = createHash('sha256').update(JSON.stringify([currentSession, sourceTimestamp ?? `${sourceFile}:${lineOffset}`, totals, last])).digest('hex');
    const duplicate = known.hasKey(observationKey) || local.hasKey(observationKey);
    const sameCounter = known.hasTotal(currentSession, totals) || local.hasTotal(currentSession, totals);
    const inheritedFromParent = !!state.parentSessionId && (known.hasTotal(state.parentSessionId, totals) || local.hasTotal(state.parentSessionId, totals));
    const copiedParentObservation = !!state.parentSessionId && (known.hasTotalAt(state.parentSessionId, new Date(timestamp).toISOString(), totals) || local.hasTotalAt(state.parentSessionId, new Date(timestamp).toISOString(), totals));
    const existingThread = known.hasSession(currentSession) || local.hasSession(currentSession);
    let decision: CounterObservation['decision'] = 'counted';
    let delta = totals;
    if (state.lastTotals) {
      if (state.lastTimestamp !== undefined && timestamp < state.lastTimestamp) {
        warnings.push('Skipped out-of-order cumulative usage in ' + path.basename(sourceFile) + '.');
        continue;
      }
      const decreased = totals.input < state.lastTotals.input || totals.output < state.lastTotals.output || totals.cached < state.lastTotals.cached || totals.reasoning < state.lastTotals.reasoning;
      if (decreased && state.lastTimestamp !== undefined && timestamp <= state.lastTimestamp) {
        warnings.push('Skipped ambiguous cumulative counter decrease in ' + path.basename(sourceFile) + '.');
        continue;
      }
      delta = decreased
        ? last ?? totals
        : {
            input: totals.input - state.lastTotals.input,
            output: totals.output - state.lastTotals.output,
            cached: totals.cached - state.lastTotals.cached,
            reasoning: totals.reasoning - state.lastTotals.reasoning,
          };
    } else if (inheritedFromParent) {
      decision = copiedParentObservation ? 'inherited' : 'ambiguous';
      delta = { input: 0, output: 0, cached: 0, reasoning: 0 };
      if (!copiedParentObservation) warnings.push('Ambiguous fork baseline in ' + path.basename(sourceFile) + '; parent counters match but the observation time differs.');
    } else if (sameCounter || (existingThread && !last)) {
      decision = 'ambiguous';
      delta = { input: 0, output: 0, cached: 0, reasoning: 0 };
      warnings.push('Ambiguous inherited cumulative baseline in ' + path.basename(sourceFile) + '; no usage was inferred.');
    } else if ((existingThread || state.parentSessionId) && last) {
      if (last.input <= totals.input && last.output <= totals.output && last.cached <= totals.cached && last.reasoning <= totals.reasoning) {
        delta = last;
        const predecessor = { input: totals.input - last.input, output: totals.output - last.output, cached: totals.cached - last.cached, reasoning: totals.reasoning - last.reasoning };
        if (!known.hasTotal(currentSession, predecessor) && !local.hasTotal(currentSession, predecessor) &&
          !(state.parentSessionId && (known.hasTotal(state.parentSessionId, predecessor) || local.hasTotal(state.parentSessionId, predecessor)))) {
          decision = 'ambiguous';
          warnings.push('Unverified gap before first usage in ' + path.basename(sourceFile) + '; only last usage was counted.');
        }
      } else {
        decision = 'ambiguous';
        delta = { input: 0, output: 0, cached: 0, reasoning: 0 };
        warnings.push('Invalid last-usage counters in ' + path.basename(sourceFile) + '; no usage was inferred.');
      }
    } else if (state.parentSessionId) {
      decision = 'ambiguous';
      delta = { input: 0, output: 0, cached: 0, reasoning: 0 };
      warnings.push('Ambiguous fork baseline in ' + path.basename(sourceFile) + '; no usage was inferred.');
    } else if (!existingThread && last &&
      (last.input < totals.input || last.output < totals.output || last.cached < totals.cached || last.reasoning < totals.reasoning)) {
      // No prior source is available. Only the last call is demonstrably new;
      // the remainder of the cumulative baseline may have been inherited.
      decision = 'ambiguous';
      delta = last;
      warnings.push('Unverified initial cumulative baseline in ' + path.basename(sourceFile) + '; only last usage was counted.');
    }
    if (duplicate) {
      decision = 'duplicate';
      delta = { input: 0, output: 0, cached: 0, reasoning: 0 };
    } else if (state.lastTotals && known.hasTotalInOtherSource(currentSession, totals, sourceFile)) {
      // A rewritten rollout can retain all cumulative values while changing
      // timestamps and tool item IDs. Equal totals in another source with the
      // same canonical identity are ambiguous, not fresh spend. Distinct fork
      // identities remain independent and are still accounted separately.
      decision = 'ambiguous';
      delta = { input: 0, output: 0, cached: 0, reasoning: 0 };
      warnings.push('Ambiguous repeated cumulative observation in ' + path.basename(sourceFile) + '; no usage was inferred.');
    }
    const observation: CounterObservation = { id: stableEventId(sourceFile, lineOffset, record), key: observationKey, sourceFile, sessionId: currentSession, parentSessionId: state.parentSessionId, timestamp: new Date(timestamp).toISOString(), input: totals.input, output: totals.output, cached: totals.cached, reasoning: totals.reasoning, lastInput: last?.input, lastOutput: last?.output, lastCached: last?.cached, lastReasoning: last?.reasoning, decision };
    observations.push(observation);
    local.add(observation);
    state.lastTotals = totals;
    state.lastTimestamp = timestamp;
    if (delta.input === 0 && delta.output === 0 && delta.cached === 0 && delta.reasoning === 0) {
      continue;
    }
    events.push({
      id: stableEventId(sourceFile, lineOffset, record),
      sessionId: currentSession,
      sourceFile,
      timestamp: new Date(timestamp).toISOString(),
      model: state.model,
      project: state.project,
      inputTokens: delta.input,
      outputTokens: delta.output,
      cachedInputTokens: delta.cached,
      reasoningOutputTokens: delta.reasoning,
      fingerprint: fingerprint(record, state.fingerprintSessionId ?? currentSession),
    });
  }
  return { events, observations, state, confirmedBytes, partial: content.subarray(confirmedBytes), warnings };
}

export function parseSessionDetailed(content: string, sourceFile: string): { events: UsageEvent[]; warnings: string[] } {
  const complete = content.endsWith('\n') ? content : content + '\n';
  const parsed = parseSessionBuffer(Buffer.from(complete, 'utf8'), sourceFile, initialState(), 0);
  return { events: parsed.events, warnings: parsed.warnings };
}

export function parseSession(content: string, sourceFile: string): UsageEvent[] {
  return parseSessionDetailed(content, sourceFile).events;
}

async function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const output = Buffer.allocUnsafe(length);
    let position = 0;
    while (position < length) {
      const result = await handle.read(output, position, length - position, offset + position);
      if (result.bytesRead === 0) {
        break;
      }
      position += result.bytesRead;
    }
    return position === length ? output : output.subarray(0, position);
  } finally {
    await handle.close();
  }
}

async function readSessionMetadata(filePath: string, size: number): Promise<{ id?: string; bytesRead: number }> {
  const data = await readRange(filePath, 0, Math.min(size, MAX_LINE_BYTES + 1));
  let cursor = 0;
  while (cursor < data.length) {
    const newline = data.indexOf(0x0a, cursor);
    if (newline === -1) break;
    try {
      const record = JSON.parse(data.subarray(cursor, newline).toString('utf8')) as Record<string, unknown>;
      if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
        const payload = record.payload as Record<string, unknown>;
        const id = [payload.session_id, payload.id].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
        return { id, bytesRead: data.length };
      }
    } catch {
      // A malformed metadata line cannot establish a canonical identity.
    }
    cursor = newline + 1;
  }
  return { bytesRead: data.length };
}

interface FirstUsageResult { timestamp: number; bytesRead: number; data?: Buffer; offset: number; size: number; mtimeMs: number; identity?: string }

async function firstUsageTime(filePath: string, offset = 0): Promise<FirstUsageResult> {
  const stat = await fs.stat(filePath);
  const identity = identityOf(stat);
  if (stat.size > MAX_FILE_BYTES) return { timestamp: Number.MAX_SAFE_INTEGER, bytesRead: 0, offset, size: stat.size, mtimeMs: stat.mtimeMs, identity };
  let bytesRead = 0;
  for (const limit of [4096, 64 * 1024, MAX_FILE_BYTES]) {
    const data = await readRange(filePath, offset, Math.min(Math.max(0, stat.size - offset), limit));
    bytesRead += data.length;
    let cursor = 0;
    while (cursor < data.length) {
      const newline = data.indexOf(0x0a, cursor);
      if (newline < 0) break;
      try {
        const record = JSON.parse(data.subarray(cursor, newline).toString('utf8')) as Record<string, unknown>;
        const payload = record.payload as Record<string, unknown> | undefined;
        if (record.type === 'event_msg' && payload?.type === 'token_count') {
          return { timestamp: timestampValue(record.timestamp) ?? stat.birthtimeMs, bytesRead, data, offset, size: stat.size, mtimeMs: stat.mtimeMs, identity };
        }
      } catch { /* A malformed line cannot order this file. */ }
      cursor = newline + 1;
    }
    if (data.length === stat.size - offset) break;
  }
  return { timestamp: stat.birthtimeMs, bytesRead, offset, size: stat.size, mtimeMs: stat.mtimeMs, identity };
}

function identityOf(stat: import('node:fs').Stats): string | undefined {
  if (typeof stat.dev === 'number' && typeof stat.ino === 'number' && stat.dev !== 0 && stat.ino !== 0) {
    return String(stat.dev) + ':' + String(stat.ino);
  }
  return undefined;
}

function generationOf(data: Buffer): string {
  return createHash('sha256').update(data.subarray(0, SAMPLE_BYTES)).digest('hex').slice(0, 20);
}

function indexedFile(value: Partial<IndexedFile> & Pick<IndexedFile, 'size' | 'mtimeMs' | 'events'>): IndexedFile {
  return {
    size: value.size,
    mtimeMs: value.mtimeMs,
    offset: value.offset ?? 0,
    identity: value.identity ?? null,
    generation: value.generation ?? null,
    parserState: value.parserState ?? encodeState(initialState()),
    partial: value.partial ?? '',
    parserVersion: value.parserVersion ?? 1,
    lastReadAt: value.lastReadAt ?? null,
    events: value.events,
    observations: value.observations ?? [],
  };
}

function checkpoint(file: IndexedFile): FileCheckpoint {
  return {
    size: file.size,
    mtimeMs: file.mtimeMs,
    offset: file.offset,
    identity: file.identity,
    generation: file.generation,
    parserState: file.parserState,
    partial: file.partial,
    parserVersion: file.parserVersion,
    lastReadAt: file.lastReadAt,
  };
}

export function defaultSessionsPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

export class SessionIndex {
  private cache = new Map<string, IndexedFile>();
  private loaded = false;
  private loading?: Promise<void>;
  private scanning?: Promise<SessionScanResult>;
  private fallbackWritable = true;
  private readonly loadWarnings: string[] = [];
  private legacyCounters?: CounterObservation[];
  private qualitySummary?: { legacyUnverified: number; ambiguous: number };
  private readonly database: SessionDatabase;

  private readonly source: SessionSource;

  public constructor(stateFileOrSource: string | SessionSource = new DefaultSessionSource(), database?: SessionDatabase) {
    this.source = typeof stateFileOrSource === 'string'
      ? { root: defaultSessionsPath(), stateFile: stateFileOrSource, findSessionFiles: () => findSessionFiles(defaultSessionsPath()), maxFiles: 2000 }
      : stateFileOrSource;
    this.database = database ?? new SessionDatabase(path.dirname(this.source.stateFile));
  }

  public get storageMode(): string {
    return this.database.available ? 'sqlite + json fallback' : 'json';
  }

  public async scan(root?: string): Promise<SessionScanResult> {
    if (!this.scanning) {
      this.scanning = this.scanInternal(root).finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loaded = true;
      });
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.source.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed.flatMap((entry) => entry && typeof entry === 'object' && typeof (entry as { file?: unknown }).file === 'string'
          ? [[(entry as { file: string }).file, entry as Partial<IndexedFile>]] as [string, Partial<IndexedFile>][]
          : [])
        : parsed && typeof parsed === 'object' ? Object.entries(parsed as Record<string, Partial<IndexedFile>>) : [];
      for (const [file, entry] of entries) {
        if (entry && Array.isArray(entry.events) && typeof entry.size === 'number' && typeof entry.mtimeMs === 'number') {
          this.cache.set(file, indexedFile(entry as Partial<IndexedFile> & Pick<IndexedFile, 'size' | 'mtimeMs' | 'events'>));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.fallbackWritable = false;
        this.loadWarnings.push('The JSON session index is invalid. The original file was preserved and will not be overwritten.');
      }
    }
    try {
      await this.database.open();
      const databaseEntries = this.database.read();
      if (databaseEntries.size > 0) {
        this.cache = databaseEntries;
      } else if (this.cache.size > 0) {
        // A pre-SQLite JSON index must be imported before the first incremental
        // write; otherwise that write makes SQLite authoritative on restart.
        this.database.sync(this.cache);
      }
    } catch {
      // SQLite is optional. The JSON fallback remains available when it is valid.
    }
  }

  private async scanInternal(root?: string): Promise<SessionScanResult> {
    const started = performance.now();
    await this.ensureLoaded();
    const warnings: string[] = [...this.loadWarnings];
    const metrics: ScanMetrics = { filesInspected: 0, filesModified: 0, bytesRead: 0, eventsNew: 0, eventsDeduplicated: 0, parseErrors: 0, durationMs: 0 };
    let changed = false;
    let files: string[];
    try {
      if (root) {
        await fs.readdir(root);
        files = await findSessionFiles(root, this.source.maxFiles);
      } else {
        files = await this.source.findSessionFiles();
      }
    } catch {
      warnings.push('Codex session folder is unavailable; showing previously indexed data.');
      return this.result(warnings, metrics, started);
    }
    if (files.length >= this.source.maxFiles) {
      warnings.push('Session file scan limit (' + this.source.maxFiles + ') reached; additional files may not be indexed.');
    }
    const next = new Map(this.cache);
    if (!this.legacyCounters) {
      this.legacyCounters = [];
      for (const [file, entry] of next) {
        if ((entry.observations?.length ?? 0) > 0) continue;
        const state = decodeState(entry.parserState);
        if (!state.lastTotals) continue;
        let id = state.canonicalSessionId;
        if (!id) {
          try { id = (await readSessionMetadata(file, entry.size)).id; } catch { /* Archived bytes are unavailable. */ }
        }
        if (!id) continue;
        this.legacyCounters.push({ id: 'legacy:' + file, key: 'legacy:' + file, sourceFile: file, sessionId: id, timestamp: new Date(state.lastTimestamp ?? 0).toISOString(), input: state.lastTotals.input, output: state.lastTotals.output, cached: state.lastTotals.cached, reasoning: state.lastTotals.reasoning, decision: 'ambiguous' });
      }
    }
    const known = new CounterLookup([...this.legacyCounters, ...[...next.values()].flatMap((entry) => entry.observations ?? [])]);
    // Establish a deterministic chronology for changed files. The
    // inherited first counter must not become the starting point only because
    // a continuation filename sorts before its parent.
    const newTimes = new Map<string, number>();
    const prefetched = new Map<string, FirstUsageResult>();
    const changedFiles: string[] = [];
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        const prior = next.get(file);
        if (prior && stat.size === prior.size && stat.mtimeMs === prior.mtimeMs && (!prior.identity || !identityOf(stat) || prior.identity === identityOf(stat))) continue;
        changedFiles.push(file);
      } catch { /* The import loop reports the file error. */ }
    }
    for (const file of changedFiles.length > 1 ? changedFiles : []) {
      try {
        const stat = await fs.stat(file);
        const prior = next.get(file);
        const offset = prior && stat.size >= prior.offset && (!prior.identity || !identityOf(stat) || prior.identity === identityOf(stat)) ? prior.offset : 0;
        const first = await firstUsageTime(file, offset);
        newTimes.set(file, first.timestamp);
        prefetched.set(file, first);
        metrics.bytesRead += first.bytesRead;
      } catch { newTimes.set(file, Number.MAX_SAFE_INTEGER); }
    }
    files.sort((left, right) => (newTimes.get(left) ?? Number.MAX_SAFE_INTEGER) - (newTimes.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
    for (const file of files) {
      metrics.filesInspected += 1;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          if (stat.size > MAX_FILE_BYTES) {
            warnings.push('Skipped oversized session file ' + path.basename(file) + '.');
          }
          continue;
        }
        const prior = this.cache.get(file);
        const imported = await this.importFile(file, stat, prior, known, prefetched.get(file));
        if (!imported) {
          continue;
        }
        metrics.filesModified += 1;
        metrics.bytesRead += imported.metrics.bytesRead;
        metrics.eventsNew += imported.metrics.eventsNew;
        metrics.eventsDeduplicated += imported.metrics.eventsDeduplicated;
        metrics.parseErrors += imported.metrics.parseErrors;
        warnings.push(...imported.warnings);
        const candidate = new Map(next);
        if (imported.archiveFile && prior) {
          candidate.set(imported.archiveFile, { ...prior, events: prior.events.map((event) => ({ ...event, sourceFile: imported.archiveFile as string })), observations: (prior.observations ?? []).map((item) => ({ ...item, sourceFile: imported.archiveFile as string })) });
        }
        candidate.set(file, imported.file);
        this.commit(imported.update);
        for (const observation of imported.update.observations ?? []) known.add(observation);
        changed = true;
        next.clear();
        for (const [key, value] of candidate) {
          next.set(key, value);
        }
      } catch (error) {
        warnings.push('Could not index session file ' + path.basename(file) + ': ' + this.safeError(error));
      }
    }
    if (changed) {
      this.persistFallback(next);
    }
    this.cache = next;
    if (changed) this.qualitySummary = undefined;
    return this.result(warnings, metrics, started);
  }

  private async importFile(file: string, stat: import('node:fs').Stats, prior: IndexedFile | undefined, known: CounterLookup, prefetch?: FirstUsageResult): Promise<FileImportResult | undefined> {
    const identity = identityOf(stat);
    let reconcile = !prior || prior.parserVersion !== SESSION_PARSER_VERSION || stat.size < prior.offset;
    if (prior && identity && prior.identity && identity !== prior.identity) {
      reconcile = true;
    }
    if (prior && stat.size === prior.size && stat.mtimeMs !== prior.mtimeMs) {
      reconcile = true;
    }
    if (!reconcile && prior && !identity && prior.generation) {
      const sample = await readRange(file, 0, Math.min(stat.size, SAMPLE_BYTES));
      if (generationOf(sample) !== prior.generation) {
        reconcile = true;
      }
    }
    if (!reconcile && prior && stat.size === prior.size && stat.mtimeMs === prior.mtimeMs) {
      return undefined;
    }

    const start = reconcile ? 0 : prior?.offset ?? 0;
    const previousState = reconcile ? initialState() : decodeState(prior?.parserState);
    let metadataBytesRead = 0;
    const identityWarnings: string[] = [];
    if (prior && !reconcile && !previousState.metadataChecked && !previousState.canonicalSessionId) {
      previousState.fingerprintSessionId ??= previousState.sessionId;
      const metadata = await readSessionMetadata(file, stat.size);
      metadataBytesRead = metadata.bytesRead;
      previousState.metadataChecked = true;
      if (metadata.id) {
        previousState.canonicalSessionId = metadata.id;
        previousState.sessionId = metadata.id;
      } else {
        identityWarnings.push('Could not verify legacy session identity in ' + path.basename(file) + '; existing grouping was retained.');
      }
    }
    const reused = prefetch?.data && prefetch.offset === start && prefetch.size === stat.size && prefetch.mtimeMs === stat.mtimeMs && prefetch.identity === identity && prefetch.data.length === stat.size - start;
    const data = reused ? prefetch.data as Buffer : await readRange(file, start, stat.size - start);
    const generationData = !identity && !reconcile ? await readRange(file, 0, Math.min(stat.size, SAMPLE_BYTES)) : data;
    const afterRead = await fs.stat(file);
    if (afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || identityOf(afterRead) !== identity) {
      throw new Error('File changed during import; checkpoint was not advanced.');
    }
    const parser = parseSessionBuffer(data, file, previousState, start, known);
    const offset = start + parser.confirmedBytes;
    const sourceEvents = reconcile ? prior?.events ?? [] : prior?.events ?? [];
    const existingFingerprints = new Set(sourceEvents.map((event) => event.fingerprint));
    const accepted = parser.events.filter((event) => !existingFingerprints.has(event.fingerprint));
    const deduplicated = parser.events.length - accepted.length;
    const events = reconcile ? accepted : [...sourceEvents, ...accepted];
    const observations = reconcile ? parser.observations : [...(prior?.observations ?? []), ...parser.observations];
    const nextFile = indexedFile({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset,
      identity,
      generation: generationOf(generationData),
      parserState: encodeState(parser.state),
      partial: parser.partial.toString('base64'),
      parserVersion: SESSION_PARSER_VERSION,
      lastReadAt: Date.now(),
      events,
      observations,
    });
    const archiveFile = reconcile && prior && (prior.events.some((oldEvent) => !events.some((event) => event.fingerprint === oldEvent.fingerprint)) || (prior.observations ?? []).some((old) => !observations.some((item) => item.id === old.id)))
      ? file + '#archived:' + createHash('sha256').update(JSON.stringify([prior.generation, prior.identity, prior.size, prior.mtimeMs, prior.offset])).digest('hex').slice(0, 20)
      : undefined;
    const update: IncrementalFileUpdate = { file, checkpoint: checkpoint(nextFile), events: accepted, observations: parser.observations, archiveFile };
    return {
      file: nextFile,
      update,
      archiveFile,
      warnings: [...identityWarnings, ...parser.warnings],
      metrics: {
        bytesRead: (reused ? 0 : data.length) + (generationData === data ? 0 : generationData.length) + metadataBytesRead,
        eventsNew: accepted.length,
        eventsDeduplicated: deduplicated,
        parseErrors: parser.warnings.filter((warning) => warning.includes('invalid JSONL')).length,
      },
    };
  }

  private commit(update: IncrementalFileUpdate): void {
    if (this.database.available) {
      this.database.applyIncremental(update);
    }
  }

  private persistFallback(cache: Map<string, IndexedFile>): void {
    if (!this.fallbackWritable) {
      return;
    }
    const serializable = [...cache].map(([file, entry]) => ({ file, ...entry }));
    const directory = path.dirname(this.source.stateFile);
    const temporary = this.source.stateFile + '.tmp-' + process.pid + '-' + Date.now();
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, JSON.stringify(serializable), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.source.stateFile);
  }

  private result(warnings: string[], metrics: ScanMetrics, started: number): SessionScanResult {
    metrics.durationMs = performance.now() - started;
    const events: UsageEvent[] = [];
    if (!this.qualitySummary) {
      let legacyUnverified = 0;
      let ambiguous = 0;
      for (const entry of this.cache.values()) {
        const observed = new Set((entry.observations ?? []).map((item) => item.id));
        ambiguous += (entry.observations ?? []).filter((item) => item.decision === 'ambiguous').length;
        for (const event of entry.events) if (!observed.has(event.id)) legacyUnverified += 1;
      }
      this.qualitySummary = { legacyUnverified, ambiguous };
    }
    for (const entry of this.cache.values()) {
      for (const event of entry.events) {
        events.push(event);
      }
    }
    if (this.qualitySummary.legacyUnverified > 0) warnings.push('Legacy token history has not been reconciled; totals may include inherited cumulative counters.');
    if (this.qualitySummary.ambiguous > 0) warnings.push('Some cumulative token observations remain ambiguous; shown totals are conservative.');
    return { filesScanned: metrics.filesInspected, events: events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)), warnings: [...new Set(warnings)], metrics };
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\\r\\n]/g, ' ').slice(0, 180);
  }

  public dispose(): void {
    this.database.close();
  }

  public close(): void {
    this.dispose();
  }
}

export async function findSessionFiles(root: string, maxFiles = 2000): Promise<string[]> {
  const source = new DefaultSessionSource(root, '', maxFiles);
  return source.findSessionFiles();
}
