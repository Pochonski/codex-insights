# Codex Insights v0.4.3 — Historical Data Integrity (draft)

**Status:** Draft for QA. Do not publish or tag until the review PR is approved.

## Highlights

- Added an offline, read-only historical token auditor for isolated SQLite 6 and JSON fallback snapshots.
- Added evidence-linked, deterministic private review plans with snapshot/source digests and stale-plan validation.
- Added overlap **candidates** for repeated cumulative observations, possible inherited bases, rewritten sources, historical technical IDs, archived generations, and missing source evidence. Candidates never change recorded totals.
- Tightened proof rules for inherited counters so matching parent timestamps and totals alone cannot remove legitimate fork activity.
- Added an explicit, read-only **Historical Data Integrity** dashboard audit with counts for evidence-supported events, ambiguous observations, unverifiable legacy events and confirmed adjustments.
- Added complete, partial, loading, failed and out-of-date audit states. The dashboard keeps overlap candidates separate from evidence-backed adjustments and always states that no changes were applied.

## Safety and compatibility

- `audit`, `plan`, `inspect`, and `validate` are read-only. `--repair` and `--apply` remain blocked; no automatic historical repair exists.
- Existing token events, fingerprints, checkpoints, quota samples, and official ChatGPT quota logic are unchanged. No SQLite schema migration was added; session schema remains at version 6.
- Detailed plans are private local files created outside the repository with restricted permissions. Anonymous aggregate reports omit session IDs and source paths.
- Back up the complete extension `globalStorage` directory before upgrading, including SQLite WAL/SHM or JSON fallback files when present. See [Upgrade QA](UPGRADE_QA_0.4.3.md).

## Verification before publication

- Local review-branch verification: 137 automated tests, isolated VS Code Electron E2E including rendered synthetic integrity counts, TypeScript, build, package scan, and `npm audit --audit-level=moderate` with zero reported vulnerabilities.
- Re-run all checks on the preparation branch and update this section with its final commit, CI result and VSIX SHA-256 before publication.
- Manual QA remains required for history preservation, official quotas, hover, Refresh and restart persistence.

## Known limits

**v0.4.3 does not automatically correct historical figures.** Some archived JSONL generations and original execution identities are unavailable, so suspected overlaps cannot safely become adjustments. Candidate counts can overlap. `Usage groups` are not necessarily independent conversations. No live repair, rollback implementation, or historical total certification is included.
