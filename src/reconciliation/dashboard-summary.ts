import { performance } from 'node:perf_hooks';
import { publicSummary, reconcileHistory, type HistoricalSnapshot, type SourceEvidence } from './historical';

export type HistoricalIntegrityStatus = 'unavailable' | 'loading' | 'complete' | 'partial' | 'failed' | 'stale';

export interface HistoricalIntegritySummary {
  status: HistoricalIntegrityStatus;
  generatedAt?: string;
  snapshotRef?: string;
  durationMs?: number;
  eventsAnalyzed?: number;
  supportedByEvidence?: number;
  ambiguousObservations?: number;
  unverifiableLegacy?: number;
  confirmedAdjustments?: number;
  overlapCandidates?: number;
  missingHistoricalSources?: boolean;
  changesApplied: false;
  message?: string;
}

export const emptyHistoricalIntegrity = (): HistoricalIntegritySummary => ({
  status: 'unavailable',
  changesApplied: false,
  message: 'No read-only historical audit has been run in this session.',
});

export function summarizeHistoricalIntegrity(
  snapshot: HistoricalSnapshot,
  evidence: SourceEvidence[],
  generatedAt = new Date().toISOString(),
): HistoricalIntegritySummary {
  const started = performance.now();
  const plan = reconcileHistory(snapshot, evidence);
  const summary = publicSummary(plan);
  const ambiguous = summary.classifications.ambiguous;
  const legacy = summary.classifications.unverifiable_legacy;
  const adjustments = summary.classifications.confirmed_duplicate;
  const candidates = Object.values(summary.candidateCounts).reduce((total, value) => total + value, 0);
  const missingSources = legacy > 0 || summary.candidateCounts.archived_generation > 0 || summary.candidateCounts.missing_source > 0;
  return {
    status: ambiguous > 0 || legacy > 0 ? 'partial' : 'complete',
    generatedAt,
    snapshotRef: plan.snapshotDigest.slice(0, 12),
    durationMs: performance.now() - started,
    eventsAnalyzed: summary.eventsAnalyzed,
    supportedByEvidence: summary.classifications.confirmed_unique,
    ambiguousObservations: ambiguous,
    unverifiableLegacy: legacy,
    confirmedAdjustments: adjustments,
    overlapCandidates: candidates,
    missingHistoricalSources: missingSources,
    changesApplied: false,
    message: summary.classificationScope,
  };
}

export function staleHistoricalIntegrity(value: HistoricalIntegritySummary): HistoricalIntegritySummary {
  if (!['complete', 'partial'].includes(value.status)) return value;
  return { ...value, status: 'stale', message: 'New usage data was indexed after this audit. Run it again to refresh the classification.' };
}
