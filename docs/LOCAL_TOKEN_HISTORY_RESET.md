# Controlled local token history reset

## Status

Codex Insights can generate a deterministic **dry-run plan** for a new local-token cutover. Applying that plan to personal storage is deliberately disabled. The extension does not reset data during activation or Refresh, and the CLI rejects `--apply`, `--repair`, and `--execute`.

Official ChatGPT quota samples, Codex authentication, and Codex JSONL conversations are outside this operation.

## Why the safe strategy is a complete statistics reset

`Legacy unverified` is derived from the evidence that remains available; it is not a persistent row-level deletion marker. Older token events can share sessions, counter observations, fingerprints, and checkpoints with supported or ambiguous observations. Missing source generations prevent a complete proof of which legacy rows are duplicates.

Selective deletion would therefore risk removing legitimate usage or leaving internally inconsistent deltas. The proposed operation resets all locally aggregated token events and their derived session, model, and project rows. It preserves a technical cutover baseline for every current JSONL file:

- confirmed byte offset and partial trailing bytes;
- file identity and generation signature;
- parser state, including the last cumulative counters;
- counter observations and lineage needed by continuations and forks.

Ambiguous observations are retained as provenance. They are not reclassified as duplicates.

## Cutover accounting

An unchanged JSONL contributes no events after the cutover. When an existing file grows, parsing resumes at its confirmed byte offset and the first new cumulative counter is compared with the preserved parser state. A continuation or fork uses the retained observation ledger and explicit parent metadata when available. This makes repeated Refresh calls and restarts idempotent without modifying files under `~/.codex/sessions`.

New visible totals start at zero. The first post-cutover usage observation contributes only a demonstrated delta or a typed `last_token_usage`. Ambiguous lineage remains visible in the ledger and is handled conservatively by the v0.4.3 accounting rules.

Sources larger than the normal first-import safety limit are streamed during dry-run to build a no-event checkpoint. After authorization, the regular collector can resume from that checkpoint and reads only appended bytes. The cutover scanner accepts complete lines up to 16 MiB so that known Codex compaction and tool-output records do not hide later counters; a larger individual line makes the baseline incomplete and blocks the plan.

## Dry-run

First create a consistent isolated snapshot. Close VS Code or otherwise stop extension writes, then use SQLite's backup API rather than copying only the main database while WAL is active. A future authorized procedure must include `insights.sqlite`, any fallback JSON state, and a manifest with SHA-256 hashes. Backups and private plans must be stored outside the repository with directory mode `0700` and file mode `0600`.

```bash
npm run reset:history -- dry-run \
  --snapshot-db /private/isolated/insights.sqlite \
  --sources "$HOME/.codex/sessions"

npm run reset:history -- plan \
  --snapshot-db /private/isolated/insights.sqlite \
  --sources "$HOME/.codex/sessions" \
  --output /private/isolated/reset-plan.json

npm run reset:history -- validate \
  --snapshot-db /private/isolated/insights.sqlite \
  --sources "$HOME/.codex/sessions" \
  --plan /private/isolated/reset-plan.json
```

The CLI refuses live extension storage as its snapshot input. It reads JSONL sources, but builds its baseline in a temporary private directory. Output is aggregated; the private plan contains paths and checkpoint data and must never be committed or packaged.

## Future authorized application

Before an application path can be exposed, it must:

1. stop extension writes and close SQLite connections;
2. create and hash a consistent SQLite backup plus fallback state;
3. pass `PRAGMA integrity_check` on the backup;
4. regenerate and validate the plan against the unchanged storage snapshot and JSONL baseline;
5. replace events, observations, checkpoints, and fallback state as a coordinated operation with rollback;
6. reopen storage and verify zero visible token events, retained checkpoints, and unchanged quota history;
7. run two unchanged Refresh operations, then verify one synthetic or user-approved new event contributes exactly once.

No personal application implementation is enabled in v0.4.3.

## Restoration

Stop VS Code before restoration. Preserve the failed/reset storage separately, then restore the complete verified backup set, including SQLite state and fallback JSON. Do not mix a restored main database with newer WAL or SHM files. Run `PRAGMA integrity_check`, reopen the extension, and compare stored event and token totals with the backup manifest.

Restoring an older backup discards local statistics written after that backup. It does not alter Codex conversations or official quota data.
