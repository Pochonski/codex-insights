// Read-only, metadata-only diagnosis. Never prints paths, IDs, prompts, or responses.
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const storage = option('--storage', path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'codex-insights-local.codex-insights'));
const sessions = option('--sessions', path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'));
if (!storage || !sessions) throw new Error('Supply a directory after each option.');

async function filesUnder(root) {
  const found = [];
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  await visit(root);
  return found;
}

const metadata = { jsonlFiles: 0, userOriginRollouts: 0, otherOrUnknownOriginRollouts: 0, customToolOutputIds: 0, tokenCountRecords: 0, invalidLines: 0 };
const verifiedUserIds = new Set();
for (const file of await filesUnder(sessions)) {
  metadata.jsonlFiles++;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { metadata.invalidLines++; continue; }
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    if (record.type === 'session_meta') {
      if (payload.thread_source === 'user' && typeof (payload.session_id || payload.id) === 'string') {
        metadata.userOriginRollouts++;
        verifiedUserIds.add(payload.session_id || payload.id);
      } else metadata.otherOrUnknownOriginRollouts++;
    }
    if (record.type === 'response_item' && payload.type === 'custom_tool_call_output' && typeof payload.id === 'string' && payload.id.startsWith('ctco_')) metadata.customToolOutputIds++;
    if (record.type === 'event_msg' && payload.type === 'token_count') metadata.tokenCountRecords++;
  }
}

const dbPath = path.join(storage, 'insights.sqlite');
let database = null;
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT session_id, COUNT(*) AS events, SUM(input_tokens) AS input,
      SUM(output_tokens) AS output, SUM(cached_input_tokens) AS cached,
      SUM(reasoning_output_tokens) AS reasoning FROM token_events GROUP BY session_id`).all();
    const kinds = {
      verifiedCurrentUserRollout: { groups: 0, events: 0, input: 0, output: 0, cached: 0, reasoning: 0 },
      customToolOutputId: { groups: 0, events: 0, input: 0, output: 0, cached: 0, reasoning: 0 },
      otherUnverifiedId: { groups: 0, events: 0, input: 0, output: 0, cached: 0, reasoning: 0 },
    };
    let oneEventGroups = 0;
    for (const row of rows) {
      const key = verifiedUserIds.has(row.session_id) ? 'verifiedCurrentUserRollout'
        : row.session_id.startsWith('ctco_') ? 'customToolOutputId' : 'otherUnverifiedId';
      const group = kinds[key];
      group.groups++;
      for (const field of ['events', 'input', 'output', 'cached', 'reasoning']) group[field] += Number(row[field] || 0);
      if (row.events === 1) oneEventGroups++;
    }
    database = {
      usageGroups: rows.length,
      oneEventGroups,
      multipleEventGroups: rows.length - oneEventGroups,
      storedEvents: Number(db.prepare('SELECT COUNT(*) AS n FROM token_events').get().n),
      duplicateFingerprints: Number(db.prepare('SELECT COUNT(*) AS n FROM (SELECT fingerprint FROM token_events WHERE fingerprint IS NOT NULL GROUP BY fingerprint HAVING COUNT(*) > 1)').get().n),
      categories: kinds,
    };
  } finally { db.close(); }
}
console.log(JSON.stringify({ metadata, database, note: 'Counts are a read-only snapshot; the files may change while Codex is running. IDs and paths are intentionally omitted.' }, null, 2));
