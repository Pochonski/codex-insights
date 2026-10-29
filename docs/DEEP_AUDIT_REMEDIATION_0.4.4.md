# Deep audit remediation for 0.4.4

This branch contains reliability fixes for review. It does not run a local-history reset, change the package version, or migrate personal storage. All destructive reset tests use synthetic temporary storage.

## Priority and changes

| Priority | Finding | Change |
| --- | --- | --- |
| Critical | A JSON-mode reset could be planned against storage that also contained SQLite; restore could then remove the SQLite file. | Reject mixed storage modes. Validate backup manifest filenames, modes, hashes, regular files and paths before restore. Keep the maintenance lock if rollback fails. |
| Critical | A crash between the SQLite reset commit and JSON sidecar replacement could revive discarded events when no source files survived. | Stage the sidecar first, then commit the SQLite reset. Verify JSON/SQLite agreement before execution; retain the maintenance lock on failed recovery. |
| High | Out-of-order cumulative observations could be skipped, and malformed fractional or unsafe token counts could enter accounting. | Keep ambiguous observations without inventing usage; accept only nonnegative safe integer counters; check typed last-use values on counter resets. |
| High | A rewrite with unchanged size and mtime could be missed. | Compare a bounded 4 KiB source prefix and file change time in addition to stat identity; recheck change time after reading before checkpointing. |
| High | A rewritten cutover source could reimport a former cumulative head. | Replay the previous counter boundary conservatively. If the old head is absent, count only a valid typed last-use increment; otherwise retain an ambiguous observation with zero inferred usage. |
| Medium | Quota history could be hidden by corrupt JSON despite healthy SQLite, and the oldest 30,000 samples were selected. | Keep SQLite authoritative, select recent history, validate reset timestamps, and expose all distinct quota buckets in the dashboard. |
| Medium | A refresh requested during an active scan was dropped; filters were lost on reopening the dashboard. | Queue one follow-up scan and persist normalized filters in VS Code global state. |
| Medium | The dashboard had inaccessible row selection, weak custom-date feedback and an E2E render acknowledgement that did not check the rendered values. | Use keyboard-accessible buttons, validate UTC dates and inspect rendered category values before acknowledgement. |
| Medium | The package scanner could miss private plan and backup paths. | Expand tracked and VSIX path checks and exclude private artifacts from packaging. |
| Low | The installed VS Code type declarations drifted beyond the declared engine. | Pin `@types/vscode` to 1.90.0. |

No quota percentages are inferred from local token data. The accounting changes do not rewrite historical events or repair old totals.

## Verification

On 2026-10-29, `npm ci`, `npm run typecheck`, `npm test` (177/177 on Node 26), `npm run build`, `npm run test:e2e` (isolated VS Code 1.90.0), `npm audit --audit-level=moderate` (zero reported), `npm run package`, and `npm run scan:package` passed. A Node 20 run passed 160 tests and skipped 17 SQLite-dependent tests because that runtime lacks `node:sqlite`; those tests run on supported newer runtimes. Electron E2E verifies the extension-host and webview protocol with synthetic fixtures; it is not a visual hover test or a test against the user's ChatGPT account. Re-run these commands after any subsequent code change.

The synthetic benchmark ran one process for each data size. At 1,000 files and 100,000 events (23,664,079 bytes), first import took 4,594.02 ms, unchanged refresh 36.72 ms with 4,096,000 bytes read, changed refresh 512.45 ms with 4,119,689 bytes read, and dashboard query 98.38 ms. The process ended at 609.45 MiB RSS. At 2,000 files and 200,000 events (47,440,379 bytes), first import took 10,114.92 ms, unchanged refresh 81.28 ms with 8,192,000 bytes read, changed refresh 1,165.23 ms with 8,239,489 bytes read, and process RSS was 1,358.98 MiB. These are synthetic single-run process measurements, not extension-only memory or universal latency guarantees.

The earlier audit measured roughly 253 ms for an unchanged 100,000-event refresh with zero bytes read. The faster unchanged refresh here comes from deferring lookup and aggregation work and caching sorted events. The 4 KiB prefix check per file increases disk reads, while the large changed refresh and memory usage still need profiling. A rewrite confined to the middle of a large file can remain undetected if its size, mtime, change time, identity and sampled prefix all appear unchanged. Filesystems differ in change-time behavior. Full-file hashing on every refresh would remove the bounded-read property; this remains a documented integrity limit.

## Review and rollout

Review the reset ordering and maintenance-lock behavior before merging. Do not run `prepare`, `execute`, or `restore` on personal storage as part of this branch's verification. The generated VSIX is a review artifact and has not been installed in the user's regular VS Code profile. Manual visual review of light, dark and high-contrast themes, and an independent quota comparison with Codex App Server, remain separate QA steps.
