# Controlled local token history reset

## Status

Codex Insights can generate a deterministic **dry-run plan** for a new local-token cutover. The extension does not reset data during activation or Refresh. Its read-only audit CLI still rejects `--apply`, `--repair`, and `--execute`.

A separate source-repository maintenance command implements preparation, explicit execution, and restoration. It is not packaged as an extension command and has no UI or automatic trigger. Execution requires Linux process verification, a persistent verified backup, an unchanged plan and source baseline, the exact confirmation phrase, and the complete plan ID.

Official ChatGPT quota samples, Codex authentication, and Codex JSONL conversations are outside this operation.

## Required extension build and installation order

The published v0.4.3 storage schema can read the post-reset SQLite database, observation ledger, checkpoints, and JSON fallback. A cross-version synthetic check also confirmed that it preserves an unchanged normal-size checkpoint and records only the later delta from an appended cumulative counter.

The published v0.4.3 extension must nevertheless **not** be used to perform or operate after this reset. It predates two required runtime safeguards:

- it does not honor the reset maintenance lock; and
- it skips session files larger than 25 MiB, even when a verified cutover checkpoint exists. The reset-capable collector recognizes that checkpoint and reads only bytes appended after the cutover.

Install the reset-compatible review VSIX before preparing the reset. Reload VS Code once to verify that build, then close every VS Code, VSCodium, Codex CLI, and Codex App Server process. Run `prepare` and any later authorized `execute` from a regular external terminal. Reopen VS Code only with the same reset-compatible or newer collector installed. Do not downgrade to the published v0.4.3 build after execution.

The review build intentionally retains manifest version 0.4.3, so the version string alone cannot distinguish it from the published build. After installation and reload, compare the installed Extension Host bundle with the reviewed VSIX:

```bash
VSIX="/absolute/path/to/codex-insights-0.4.3-reset-compatible.vsix"
EXPECTED="$(unzip -p "$VSIX" extension/dist/extension.js | sha256sum | cut -d' ' -f1)"
INSTALLED="$(code --locate-extension codex-insights-local.codex-insights)"
ACTUAL="$(sha256sum "$INSTALLED/dist/extension.js" | cut -d' ' -f1)"
test "$EXPECTED" = "$ACTUAL" && echo "reset-compatible collector verified"
```

If the comparison fails or `--locate-extension` resolves another profile, stop. Select the intended VS Code profile, reinstall the reviewed VSIX, reload, and repeat the comparison before preparation.

The maintenance scripts themselves remain source-repository commands and are not included as extension UI actions. Installing the VSIX does not reset anything.

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

## Prepare an execution package

Run this from a regular terminal after closing **all** VS Code, VSCodium, Codex CLI, and Codex App Server processes. Do not run it from a VS Code terminal or an active Codex task.

Run the command from the checked-out `fix/local-token-history-reset` source directory at the exact reviewed commit. `prepare` records the current storage and source digests; any subsequent JSONL or storage change invalidates the plan and requires a new backup and preparation.

For SQLite storage, the external terminal's Node runtime must provide `node:sqlite` (the CI exercises SQLite on Node 22). Verify this before stopping applications:

```bash
node -e "require('node:sqlite'); console.log('node:sqlite available')"
```

Node 20 does not provide this module in the supported CI environment and cannot run the SQLite maintenance operation. It remains supported by the extension through the JSON fallback.

Choose a new backup directory outside extension storage and `~/.codex`. The command refuses an existing directory and writes the backup, manifest, and plan with private permissions.

```bash
npm run reset:history:execute -- prepare \
  --storage-dir "$HOME/.config/Code/User/globalStorage/codex-insights-local.codex-insights" \
  --state-file "$HOME/.config/Code/User/globalStorage/codex-insights-local.codex-insights/sessions-index.json" \
  --sources "$HOME/.codex/sessions" \
  --backup-dir "$HOME/CodexInsightsBackups/before-local-reset-YYYYMMDD-HHMMSS" \
  --plan-output "$HOME/CodexInsightsBackups/local-reset-plan-YYYYMMDD-HHMMSS.json" \
  --storage sqlite
```

Preparation performs no token reset. It creates a SQLite backup through the SQLite backup API, copies fallback state, runs `PRAGMA integrity_check`, hashes every backup file, builds the cutover baseline, and prints the plan ID and current affected totals. Review those totals before authorizing execution.

## Explicit execution

Keep all writer processes stopped. Use the unchanged backup and plan from preparation. Replace `<FULL_PLAN_ID>` with the entire value printed by `prepare`.

```bash
npm run reset:history:execute -- \
  --plan "$HOME/CodexInsightsBackups/local-reset-plan-YYYYMMDD-HHMMSS.json" \
  --storage-dir "$HOME/.config/Code/User/globalStorage/codex-insights-local.codex-insights" \
  --state-file "$HOME/.config/Code/User/globalStorage/codex-insights-local.codex-insights/sessions-index.json" \
  --sources "$HOME/.codex/sessions" \
  --backup-dir "$HOME/CodexInsightsBackups/before-local-reset-YYYYMMDD-HHMMSS" \
  --confirm "RESET LOCAL TOKEN HISTORY" \
  --confirm-plan "<FULL_PLAN_ID>"
```

The command:

1. stop extension writes and close SQLite connections;
2. verifies that VS Code and Codex writer processes are absent;
3. acquires a private maintenance lock respected by session and quota writers;
4. verifies all backup hashes and SQLite integrity;
5. revalidates the complete plan against live storage and every current JSONL source;
6. stages the fallback state and replaces SQLite token tables in one transaction;
7. verifies zero token events, retained baseline observations/checkpoints, and an unchanged quota digest;
8. rescans sources before success; any detected change causes restoration from the verified backup.

SQLite and JSON cannot share one filesystem transaction. The staged fallback plus automatic restoration provides rollback across the two stores. A persistent backup remains after success.

## Restoration

Stop VS Code and Codex before restoration. If post-reset statistics matter, copy them separately first. Restoration intentionally discards local statistics written after the backup:

```bash
npm run reset:history:execute -- restore \
  --storage-dir "$HOME/.config/Code/User/globalStorage/codex-insights-local.codex-insights" \
  --state-file "$HOME/.config/Code/User/globalStorage/codex-insights-local.codex-insights/sessions-index.json" \
  --backup-dir "$HOME/CodexInsightsBackups/before-local-reset-YYYYMMDD-HHMMSS" \
  --confirm "RESTORE CODEX INSIGHTS BACKUP AND DISCARD NEWER LOCAL STATISTICS"
```

Restoration verifies the manifest, removes incompatible WAL/SHM files, restores SQLite and fallback state together, reruns `PRAGMA integrity_check`, and verifies the restored snapshot digest before releasing the maintenance lock.

Restoring an older backup discards local statistics written after that backup. It does not alter Codex conversations or official quota data.
