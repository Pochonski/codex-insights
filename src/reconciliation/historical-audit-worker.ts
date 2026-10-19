import { parentPort, workerData } from 'node:worker_threads';
import { summarizeHistoricalIntegrity } from './dashboard-summary';
import type { HistoricalSnapshot, SourceEvidence } from './historical';

type AuditInput = { snapshot: HistoricalSnapshot; evidence: SourceEvidence[] };

if (!parentPort) throw new Error('Historical audit worker requires a parent port.');
const input = workerData as AuditInput;
if (!input || !input.snapshot || !Array.isArray(input.snapshot.events) || !Array.isArray(input.evidence)) {
  throw new Error('Invalid historical audit input.');
}
parentPort.postMessage(summarizeHistoricalIntegrity(input.snapshot, input.evidence));
