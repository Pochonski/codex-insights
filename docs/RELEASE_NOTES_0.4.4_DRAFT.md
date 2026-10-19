# Codex Insights v0.4.4 — Guarded Local History Reset (draft)

**Status:** Draft for QA. Do not publish or tag until the preparation PR and manual QA are approved.

## Highlights

- Adds an explicit full reset workflow for locally aggregated token statistics.
- Preserves verified cutover checkpoints, cumulative counter state, partial lines, file identity, and observation lineage required for new deltas.
- Supports normal, rewritten, truncated, rotated, continued, forked, and oversized current JSONL sources without modifying Codex conversations.
- Adds verified private backup, deterministic plan validation, maintenance locking, transactional SQLite replacement, staged JSON fallback, automatic rollback, and explicit restoration.

## Safety

- No reset runs during extension activation, ordinary Refresh, audit, or dashboard use.
- `prepare`, `execute`, and `restore` are source-repository maintenance commands and are excluded from the VSIX UI.
- Execution requires stopped writer processes, a matching verified backup, unchanged sources, the full plan ID, and the exact confirmation phrase.
- Official ChatGPT quotas and Codex authentication are outside the reset operation.
- Historical repair remains separate; candidates and ambiguous observations are never silently converted into deletions.

## Compatibility and upgrade guidance

Install and verify v0.4.4 before preparing or executing a reset. The published v0.4.3 collector can read the schema but lacks maintenance-lock enforcement and cannot resume oversized cutover sources. Do not downgrade to v0.4.3 after a reset. See [v0.4.4 upgrade and reset QA](UPGRADE_QA_0.4.4.md).

## Known limitations

- Writer-process verification is currently Linux-only.
- SQLite maintenance requires an external Node runtime that provides `node:sqlite`.
- Sources absent during preparation are not represented in the cutover baseline.
- Restoring a backup discards local statistics recorded after that backup.
- No reset has been executed on personal storage as part of development or CI.
