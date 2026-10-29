# Codex Insights v0.4.5 — Reliability Maintenance (draft)

**Status:** Review draft. Do not publish or tag until the preparation PR and manual QA are approved.

## Highlights

- Hardened the explicit local token-history reset against mixed SQLite/JSON storage, sidecar divergence, invalid backup manifests, and crash boundaries. A separate `recover` source command can restore a verified backup while an interrupted reset's maintenance lock remains in place.
- Made cumulative-token ingestion more conservative for out-of-order observations, rewritten cutover files, invalid counters, and ambiguous lineage. Existing stored totals are not silently changed.
- Added a bounded source-prefix and file change-time check to detect more JSONL rewrites while keeping normal updates incremental.
- Kept healthy SQLite quota history available if an old JSON sidecar is malformed, selected recent quota samples, and distinguished quota buckets in the dashboard.
- Queued Refresh requests made during a scan, retained normalized filters, improved custom UTC date feedback and keyboard access to usage groups.
- Expanded package scanning and pinned VS Code API types to the supported engine.

## Safety and compatibility

- Installing v0.4.5 does **not** reset local token history or run historical repair. Audit remains read-only; `--repair` and `--apply` stay disabled.
- The App Server still supplies official account quotas. Local token data never determines quota percentages.
- SQLite schema remains at migration 6. JSON fallback and existing checkpoints remain compatible; no new migration is introduced.
- Reset `prepare`, `execute`, `restore`, and `recover` are source-repository maintenance commands, excluded from the VSIX and never invoked by ordinary Refresh.
- Before upgrading a regular profile, back up its entire extension globalStorage directory, including SQLite WAL/SHM and JSON sidecars. See [v0.4.5 upgrade QA](UPGRADE_QA_0.4.5.md).

## Validation before release

- Local preparation build: `npm ci`, typecheck, **181/181** unit and integration tests, build, isolated VS Code 1.90 Electron E2E, packaging and sensitive-file scan passed.
- `npm audit --audit-level=moderate` reported **0 vulnerabilities**. The 0.4.5 VSIX has 14 archive entries, includes the compiled Extension Host and both React bundles, and excludes maintenance scripts, E2E fixtures and private data.
- Historical audit `--repair` and `--apply`, and read-only reset CLI `--repair` and `--apply`, each exited with the expected blocked status in a no-input check.
- Node 20/22 and Electron CI on the preparation PR: pending.
- Manual regular-profile hover, quota, history and restart QA: pending user review. The preparation task did not install the VSIX into a personal profile.

## Known limits

- Historical observations are not repaired by this update. Ambiguous and unverifiable legacy rows remain visible as recorded.
- A middle-only JSONL rewrite can escape the bounded check if identity, size, timestamps and sampled prefix all appear unchanged. A later phase will investigate scheduled deeper verification and its I/O cost.
- The 250-row usage-group display limit and absence of a separate metadata-only conversation inventory remain unchanged.
