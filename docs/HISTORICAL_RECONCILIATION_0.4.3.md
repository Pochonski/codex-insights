# Historical token reconciliation: review-only design (v0.4.3 work)

## Status and evidence boundary

**Implemented:** a deterministic, read-only reconciler, isolated SQLite/JSON snapshot readers, an anonymous aggregate CLI, a private plan writer, and plan validation. **Not implemented or authorized:** applying a plan, historical data migration, automatic repair, or a repaired-history claim in the product. The package and VSIX version remain 0.4.2 during this review branch.

The published v0.4.2 collector prevents several future duplicate counts. Earlier versions could count a continuation's inherited cumulative base as new usage, misattribute `ctco_` response-item IDs as sessions, or retain overlapping archived generations. Prior private aggregate estimates are forensic leads, **not** approved corrections. A live database can change while Codex is active, so later snapshots need not reproduce earlier totals.

## Provenance and accounting invariants

The reconciler reads `token_events`, `counter_observations`, and `import_state` from a **copied** SQLite database, or events, observations and checkpoints from a copied JSON fallback. Optional surviving JSONL is indexed into a disposable private directory. The source matcher uses the collector's event ID (hash of source path, byte offset and record) or its compatible exact-record fingerprint. A fingerprint match can link an older recorded ID to surviving bytes without declaring the old ID a conversation. Original prompts and responses are not persisted by the audit.

Each event is classified as:

| Class | Meaning | Effect on proposed total |
| --- | --- | --- |
| Confirmed duplicate | Exact stored fingerprint and four deltas repeat, or an explicit parent proves an inherited baseline. | Propose removing only the proven repeated amount. A typed new increment is retained. |
| Confirmed unique | The stored delta matches typed last usage or a chronological difference in available source evidence, without an evidenced overlap. | Keep it. This is relative to inspected evidence, not a certificate that all missing generations were unique. |
| Ambiguous | Matching numbers without lineage, a changed timestamp, old technical ID versus canonical ID, an unresolved counter reset, or contradictory evidence. | Keep the stored amount unchanged. |
| Unverifiable legacy | The source bytes or a trustworthy event-to-observation link are missing. | Keep the stored amount unchanged. |

These classes are intentionally conservative. Equality of amounts or a common canonical session ID **does not** prove duplication. Even identical timestamps and cumulative tuples across rewritten files remain ambiguous without exact record identity or explicit lineage: two forks could otherwise be collapsed. Distinct explicit forks can retain independent increments. `cached` is a subset of `input`, and `reasoning` is a subset of `output`; neither is added again to the parent total. ChatGPT account quotas are outside this engine.

For an explicit parent with cumulative base **B**, typed last increment **L**, and stored old amount **B + L**, the proposed amount is **L**, with a difference of **B**, only when surviving provenance establishes the parent tuple and chronology. A copied parent observation with an exact matching timestamp and total can propose zero for the copied child baseline. Without that evidence the record remains ambiguous; no global maximum by thread is used.

## Dry-run workflow

1. Close VS Code or use SQLite's consistent backup mechanism to create a **private isolated copy**. Include relevant WAL transactions in the backup; a plain copy of a live `.sqlite` file is not sufficient. Keep the original extension `globalStorage` untouched. Check the copy using `PRAGMA integrity_check`.
2. Run the tool on that copy. Direct `node` invocation avoids npm echoing private argument paths:

   ```bash
   node scripts/audit-history.mjs audit --snapshot-db /private/snapshot.sqlite
   node scripts/audit-history.mjs audit --snapshot-db /private/snapshot.sqlite --sources /private/copied-sessions
   node scripts/audit-history.mjs plan --snapshot-db /private/snapshot.sqlite --sources /private/copied-sessions --output /private/review-plan.json
   node scripts/audit-history.mjs inspect --plan /private/review-plan.json
   node scripts/audit-history.mjs validate --snapshot-db /private/snapshot.sqlite --sources /private/copied-sessions --plan /private/review-plan.json
   ```

   Substitute `--snapshot-json /private/sessions-index.json` for the SQLite argument to audit a copied JSON fallback. The `--sources` directory is optional; more surviving source bytes can improve attribution, but missing generations remain unresolved. The tool refuses snapshot files under paths containing `globalStorage` or `.codex`. It does not open `auth.json`.
3. Keep `review-plan.json` **outside the repository**. It is created with mode `0600`, without overwriting an existing file. It contains internal IDs and proof references; do not attach it to a public issue or PR. Only the aggregate stdout JSON is suitable for sharing after review. The CLI prints no source paths, event IDs, prompts, or responses. `--repair` and `--apply` fail immediately.

The aggregate report separates current stored totals, demonstrable proposed adjustment, provisional resulting totals, and an **unquantified** uncertain remainder. Its provenance percentage is the fraction of stored events linked to surviving observations, not a confidence score. The detailed plan records per-counter originals, proposed values, differences, reason, evidence, conflicts, dependencies, and a reversible flag. SHA-256 digests of sorted stored events, observations, checkpoints and source evidence make repeated plans stable and reject a plan after relevant snapshot content changes. Validation recomputes the whole plan to detect tampering. It does not enable application.

The old `npm run audit:tokens` script compares independently re-parsed available JSONL; it is useful for diagnosis but cannot prove a whole-history correction when archived generations are gone. Do not subtract its difference from stored totals automatically.

## Aggregate local observation and limits

The maintainer's current investigation used a read-only SQLite connection to create a private consistent snapshot, then indexed surviving JSONL into a temporary directory. No personal storage was migrated or repaired. The aggregate numbers are reported privately to the project owner rather than committed to this public document. The available files did **not** establish a safe adjustment for the previously estimated historical overcount. A zero demonstrable adjustment means **insufficient proof under these rules**, not proof that the historic totals are accurate. The live source changed between two read-only snapshots.

Archived source generations and older `ctco_` attributions lack a guaranteed original observation link. Source fingerprints can recover some links; numerical similarity cannot. A repaired lifetime total cannot yet be certified from this evidence.

## Future repair design: intentionally blocked

No SQLite migration 7 is justified by the read-only work alone. A later, separately reviewed repair would require:

1. Freeze import/Refresh and take a consistent SQLite backup (SQLite backup API or `VACUUM INTO` where supported), including committed WAL contents. Back up the JSON fallback separately. Restrict backup permissions, record checksums, verify `PRAGMA integrity_check` on the backup, and test restoration on a copy.
2. Re-read the database and evidence under a lock, reject a stale plan, and require a second explicit authorization naming the plan ID and backup. Never apply an ambiguous or unverifiable adjustment.
3. In one transaction, record every original and proposed four-counter tuple, proof, plan ID, execution time, and row version in a repair ledger. Apply event changes and any derived metadata together; leave observations and checkpoints compatible with subsequent imports. A repeated plan ID must be a no-op. Roll back on any failed validation.
4. For JSON fallback, stage a complete new file privately, fsync it and its directory, then rename atomically while preserving a verified original copy. Define how SQLite and JSON modes switch before authorizing writes.
5. Reopen and verify event counts, fingerprints, checkpoints, ledger entries, four totals and integrity. To reverse a repair, prefer a compensating transaction using preserved original values. Restoring an old whole-directory backup after new imports would discard those later imports; it is only safe after stopping writes and deliberately accounting for them.

The tests in this PR prove dry-run immutability, stable plans and stale-plan rejection. They **do not** claim to test or authorize a repair transaction or reversal implementation. Those are future gates, with separate synthetic transaction/rollback and post-repair-import tests required before any personal data is touched.

## Dashboard and conversation inventory

The dashboard's existing quality warning is now labeled **Historical Data Integrity** and explicitly says **No changes applied**. It shows no fabricated verified count or global confidence percentage. The offline private plan is not sent to React, and there is no repair button. Hover, mini panel, filters, quota history and App Server remain unchanged.

A separate `Conversations` inventory is feasible only from persistent `session_meta` provenance. It should store canonical ID, source generation, first/last metadata timestamp, explicit parent link and confidence, including metadata-only conversations with no token event. The existing `Usage groups` metric must continue to mean distinct recorded event IDs, and `Usage events` individual accounting rows. Continuations can share a canonical ID; forks need explicit metadata. A new schema and JSON fallback representation would be needed. This is a v0.5.0 design, not a v0.4.3 restructuring.

## Reproducible performance baseline

Run each size in a fresh process with `npm run benchmark:history -- --size 1000` (or 10000, 100000, 200000). The script uses synthetic counter metadata only, measures memory after fixture events, ledger, reconciliation and plan serialization, and does not touch Codex sessions. Node `--expose-gc` is used between phases. Reported RSS is the **whole benchmark process**, not additional VS Code Extension Host memory or peak RSS. One run per size is illustrative rather than a stable performance guarantee.

| Events | Reconcile | Plan serialize | RSS after plan | Plan JSON |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 13.91 ms | 0.12 ms | 108.33 MiB | 0.18 MiB |
| 10,000 | 68.84 ms | 1.07 ms | 149.95 MiB | 1.82 MiB |
| 100,000 | 613.83 ms | 13.60 ms | 379.28 MiB | 18.22 MiB |
| 200,000 | 1,296.50 ms | 30.30 ms | 529.20 MiB | 36.43 MiB |

Environment: Linux x64, Node 26.2.0, Intel Core i7-12650H, 15.32 GiB physical RAM. These are generated event objects, not 200,000 parsed conversations. The full plan retains one finding per event and therefore grows linearly. A later streaming/batched implementation would need stable event ordering, externalized evidence indexes and a single digest across all batches; it must not decide forks from partial context.

At 200,000 events, whole-process RSS was 83.00 MiB after startup, 207.07 MiB after creating events, 268.62 MiB after creating the synthetic ledger, 521.04 MiB after reconciliation, and 529.20 MiB after serializing the plan. These stages are measured after optional garbage collection, not peak memory. The 100,000-event run measured 83.10, 149.84, 153.28, 360.16 and 379.28 MiB at the same stages. Plans with many adjustments may use more memory than this zero-adjustment fixture.

## Remaining verification

Automated fixtures cover exact duplicates, inherited bases, independent and ambiguous forks, `ctco_` attribution, missing and archived sources, SQLite 5/6 snapshots, JSON fallback, stale plans and read-only CLI behavior. Existing v0.4.2 tests protect App Server, incremental indexing, checkpoints, hover and dashboard. Electron E2E remains synthetic. A future authorized repair phase needs explicit transaction, backup, rollback, idempotence and post-repair-import tests; none are claimed to pass in this audit-only version.
