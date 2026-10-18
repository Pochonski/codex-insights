import { createHash } from 'node:crypto';

/** This module produces evidence-linked proposals. It has no storage writes. */
export type Classification = 'confirmed_duplicate' | 'confirmed_unique' | 'ambiguous' | 'unverifiable_legacy';
export type Counters = { input: number; cached: number; output: number; reasoning: number };
export type HistoricalEvent = { id: string; fingerprint?: string; sourceFile: string; sessionId: string; timestamp: string; counters: Counters };
export type HistoricalObservation = { id: string; key: string; sourceFile: string; sessionId: string; parentSessionId?: string; timestamp: string; total: Counters; last?: Counters; decision: string };
export type HistoricalCheckpoint = { sourceFile: string; size: number; offset: number; generation?: string | null; parserVersion: number; parserState?: string | null };
export type HistoricalSnapshot = { storage: 'sqlite' | 'json'; schemaVersion: number; events: HistoricalEvent[]; observations: HistoricalObservation[]; checkpoints: HistoricalCheckpoint[] };
/** Produced from surviving JSONL in a disposable index. Its ID hashes file path, byte offset and record. */
export type SourceEvidence = HistoricalObservation & { eventFingerprint?: string };
export type Finding = { eventId: string; classification: Classification; reason: string; evidence: string[]; conflicts: string[] };
export type Adjustment = { eventId: string; canonicalSessionId?: string; sourceRef: string; reason: string; evidence: string[]; original: Counters; proposed: Counters; difference: Counters; certainty: 'confirmed_duplicate'; dependencies: string[]; conflicts: string[]; reversible: true };
export type PlanSummary = { eventsAnalyzed: number; observationsAnalyzed: number; sourceObservations: number; classifications: Record<Classification, number>; current: Counters; demonstrableAdjustment: Counters; proposed: Counters; provenanceMatchedEvents: number; provenanceCoveragePercent: number; uncertainAdditionalAdjustment: 'not quantified'; changesApplied: false };
export type RepairPlan = { format: 1; snapshotDigest: string; evidenceDigest: string; planId: string; summary: PlanSummary; findings: Finding[]; adjustments: Adjustment[]; applicationEnabled: false };

const zero = (): Counters => ({ input: 0, cached: 0, output: 0, reasoning: 0 });
const fields = ['input', 'cached', 'output', 'reasoning'] as const;
const sum = (a: Counters, b: Counters): Counters => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });
const subtract = (a: Counters, b: Counters): Counters => ({ input: a.input - b.input, cached: a.cached - b.cached, output: a.output - b.output, reasoning: a.reasoning - b.reasoning });
const same = (a: Counters, b: Counters): boolean => fields.every(key => a[key] === b[key]);
const valid = (v: Counters): boolean => fields.every(key => Number.isSafeInteger(v[key]) && v[key] >= 0) && v.cached <= v.input && v.reasoning <= v.output;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
const bySource = <T extends { sourceFile: string }>(a: T, b: T) => a.sourceFile.localeCompare(b.sourceFile);
const tuple = (o: HistoricalObservation) => JSON.stringify([o.sessionId, o.total]);
const sourceRef = (sourceFile: string) => digest(sourceFile).slice(0, 20);

export function snapshotDigest(snapshot: HistoricalSnapshot): string {
  return digest({ storage: snapshot.storage, schemaVersion: snapshot.schemaVersion,
    events: [...snapshot.events].sort(byId), observations: [...snapshot.observations].sort(byId),
    checkpoints: [...snapshot.checkpoints].sort(bySource) });
}

export function evidenceDigest(evidence: SourceEvidence[]): string { return digest([...evidence].sort(byId)); }

/** Only exact provenance or an explicitly linked parent baseline proves a duplicate. */
export function reconcileHistory(snapshot: HistoricalSnapshot, evidence: SourceEvidence[] = []): RepairPlan {
  const events = [...snapshot.events].sort(byId);
  const sources = [...evidence].sort(byId);
  const sourceById = new Map(sources.map(item => [item.id, item]));
  const sourceByFingerprint = new Map<string, SourceEvidence[]>();
  const storedObservationById = new Map(snapshot.observations.map(item => [item.id, item]));
  const eventById = new Map(events.map(item => [item.id, item]));
  const sourceByTuple = new Map<string, SourceEvidence[]>();
  const sourceBySessionTimeTotal = new Map<string, SourceEvidence>();
  const sourceSeries = new Map<string, SourceEvidence[]>();
  for (const item of sources) {
    if (item.eventFingerprint) {
      if (!sourceByFingerprint.has(item.eventFingerprint)) sourceByFingerprint.set(item.eventFingerprint, []);
      sourceByFingerprint.get(item.eventFingerprint)?.push(item);
    }
    const total = tuple(item); if (!sourceByTuple.has(total)) sourceByTuple.set(total, []); sourceByTuple.get(total)?.push(item);
    sourceBySessionTimeTotal.set(JSON.stringify([item.sessionId, item.timestamp, item.total]), item);
    const seriesKey = JSON.stringify([item.sourceFile, item.sessionId]);
    if (!sourceSeries.has(seriesKey)) sourceSeries.set(seriesKey, []);
    sourceSeries.get(seriesKey)?.push(item);
  }
  const previousById = new Map<string, SourceEvidence>();
  for (const series of sourceSeries.values()) {
    series.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    for (let i = 1; i < series.length; i++) if (series[i - 1].timestamp < series[i].timestamp) previousById.set(series[i].id, series[i - 1]);
  }
  const storedByFingerprint = new Map<string, HistoricalEvent[]>();
  for (const event of events) if (event.fingerprint) {
    if (!storedByFingerprint.has(event.fingerprint)) storedByFingerprint.set(event.fingerprint, []);
    storedByFingerprint.get(event.fingerprint)?.push(event);
  }
  const hasStoredSource = (item: SourceEvidence) => eventById.get(item.id)?.sourceFile === item.sourceFile || !!item.eventFingerprint && (storedByFingerprint.get(item.eventFingerprint)?.length ?? 0) > 0;
  const findings: Finding[] = [];
  const adjustments: Adjustment[] = [];
  const classifications: Record<Classification, number> = { confirmed_duplicate: 0, confirmed_unique: 0, ambiguous: 0, unverifiable_legacy: 0 };
  let current = zero(), demonstrableAdjustment = zero(), provenanceMatchedEvents = 0;
  for (const event of events) {
    current = sum(current, event.counters);
    if (!fields.every(key => Number.isSafeInteger(current[key]))) throw new RangeError('Stored token totals exceed safe integer precision.');
    const direct = sourceById.get(event.id);
    const fingerprintEvidence = event.fingerprint ? sourceByFingerprint.get(event.fingerprint) ?? [] : [];
    const source = direct?.sourceFile === event.sourceFile ? direct : fingerprintEvidence.length === 1 ? fingerprintEvidence[0] : undefined;
    const stored = storedObservationById.get(event.id);
    if (source) provenanceMatchedEvents++;
    let classification: Classification = 'unverifiable_legacy';
    let reason = 'Original JSONL observation is unavailable or cannot be linked to this stored event.';
    let proof: string[] = [];
    let proposedCounters = zero();
    const conflicts: string[] = [];
    if (!valid(event.counters)) {
      classification = 'ambiguous'; reason = 'Stored counters violate nonnegative/subset invariants; no adjustment is safe.';
    } else {
      const fingerprintPeers = event.fingerprint ? storedByFingerprint.get(event.fingerprint) ?? [] : [];
      const equivalentPeers = fingerprintPeers.filter(peer => same(peer.counters, event.counters));
      const differentPeers = fingerprintPeers.filter(peer => !same(peer.counters, event.counters));
      if (differentPeers.length) conflicts.push('Same fingerprint has conflicting stored counter deltas.');
      if (equivalentPeers.length > 1 && equivalentPeers[0].id !== event.id && !differentPeers.length) {
        classification = 'confirmed_duplicate'; reason = 'Exact stored fingerprint and four counters repeat; the lowest stable event ID is retained.';
        proof = [equivalentPeers[0].id, event.fingerprint as string];
      } else if (source && valid(source.total)) {
        if (source.parentSessionId) {
          const parent = sourceBySessionTimeTotal.get(JSON.stringify([source.parentSessionId, source.timestamp, source.total]));
          if (parent && hasStoredSource(parent) && !differentPeers.length) {
            classification = 'confirmed_duplicate'; reason = 'Explicit parent identity and matching source timestamp/cumulative tuple prove an inherited baseline.';
            proof = [parent.id, source.key];
          } else if (source.last && valid(source.last) && fields.every(key => source.total[key] >= source.last![key]) && same(event.counters, source.total)) {
            const predecessorTotal = subtract(source.total, source.last);
            const candidates = sourceByTuple.get(JSON.stringify([source.parentSessionId, predecessorTotal])) ?? [];
            const predecessor = candidates.find(item => item.timestamp <= source.timestamp && hasStoredSource(item));
            if (predecessor) {
              classification = 'confirmed_duplicate'; reason = 'Explicit parent and typed last usage prove an inherited cumulative base; the new last increment is retained.';
              proposedCounters = source.last;
              proof = [predecessor.id, source.key];
            }
          }
        }
        if (classification !== 'confirmed_duplicate') {
          const repeatedCounter = (sourceByTuple.get(tuple(source)) ?? []).some(item => item.id !== source.id && item.sourceFile !== source.sourceFile);
          const mismatch = stored && (stored.key !== source.key || stored.sessionId !== source.sessionId || !same(stored.total, source.total));
          if (mismatch || repeatedCounter || source.decision === 'ambiguous' || event.sessionId !== source.sessionId || conflicts.length) {
            classification = 'ambiguous';
            reason = mismatch ? 'Stored ledger conflicts with surviving source observation.' : event.sessionId !== source.sessionId ? 'Historical recorded ID differs from canonical source identity; numeric overlap is unproven.' : 'Counter overlap or provenance remains ambiguous.';
            if (repeatedCounter) conflicts.push('Equal cumulative tuple in another source is not sufficient proof of the same execution.');
          } else {
            const recent = source.last && same(source.last, event.counters);
            const chronological = previousById.get(source.id);
            const localDelta = chronological && valid(chronological.total) && fields.every(key => source.total[key] >= chronological.total[key]) && same(subtract(source.total, chronological.total), event.counters);
            if (recent || localDelta) {
              classification = 'confirmed_unique'; reason = recent ? 'Stored delta equals typed last usage in surviving source; no evidenced overlap.' : 'Stored delta equals the chronological cumulative difference in surviving source; no evidenced overlap.';
              proof = [source.id];
            } else {
              classification = 'ambiguous'; reason = 'Source is present, but this stored delta lacks a verified predecessor or typed last-usage match.';
            }
          }
        }
      } else if (stored?.decision === 'ambiguous' || conflicts.length) {
        classification = 'ambiguous'; reason = 'Ledger marks this observation ambiguous or stored provenance conflicts.';
      }
    }
    classifications[classification]++;
    findings.push({ eventId: event.id, classification, reason, evidence: proof, conflicts });
    if (classification === 'confirmed_duplicate') {
      const difference = subtract(event.counters, proposedCounters);
      demonstrableAdjustment = sum(demonstrableAdjustment, difference);
      if (!fields.every(key => Number.isSafeInteger(demonstrableAdjustment[key]))) throw new RangeError('Proposed token adjustment exceeds safe integer precision.');
      adjustments.push({ eventId: event.id, canonicalSessionId: source?.sessionId, sourceRef: sourceRef(event.sourceFile), reason,
        evidence: proof, original: event.counters, proposed: proposedCounters, difference, certainty: 'confirmed_duplicate', dependencies: proof.slice(0, 1), conflicts, reversible: true });
    }
  }
  const summary: PlanSummary = { eventsAnalyzed: events.length, observationsAnalyzed: snapshot.observations.length,
    sourceObservations: sources.length, classifications, current, demonstrableAdjustment,
    proposed: subtract(current, demonstrableAdjustment), provenanceMatchedEvents,
    provenanceCoveragePercent: events.length ? Math.round(provenanceMatchedEvents / events.length * 10_000) / 100 : 0,
    uncertainAdditionalAdjustment: 'not quantified', changesApplied: false };
  const snapshotHash = snapshotDigest(snapshot), evidenceHash = evidenceDigest(sources);
  const planId = digest({ snapshotHash, evidenceHash, adjustments });
  return { format: 1, snapshotDigest: snapshotHash, evidenceDigest: evidenceHash, planId, summary, findings, adjustments, applicationEnabled: false };
}

export function validatePlan(plan: RepairPlan, snapshot: HistoricalSnapshot, evidence: SourceEvidence[] = []): { valid: boolean; reason: string } {
  if (plan.format !== 1 || plan.applicationEnabled !== false) return { valid: false, reason: 'Unsupported or executable plan.' };
  if (snapshotDigest(snapshot) !== plan.snapshotDigest || evidenceDigest(evidence) !== plan.evidenceDigest) return { valid: false, reason: 'Stale snapshot or source evidence.' };
  const expected = reconcileHistory(snapshot, evidence);
  return expected.planId === plan.planId && digest(expected) === digest(plan)
    ? { valid: true, reason: 'Plan and snapshot match; application remains disabled.' }
    : { valid: false, reason: 'Plan contents differ from deterministic reconciliation.' };
}

/** Never expose identifiers, source paths, or evidence hashes in aggregate reports. */
export function publicSummary(plan: RepairPlan): PlanSummary { return plan.summary; }
