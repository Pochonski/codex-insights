# Codex Insights v0.4.4 upgrade and reset QA

This review build contains the reset-compatible collector and guarded maintenance infrastructure. Installing it does not reset local statistics. `prepare`, `execute`, and `restore` remain source-repository commands with no extension command or Webview control.

## Install and verify the reviewed build

Install `codex-insights-0.4.4.vsix` into the intended VS Code profile and reload once. Confirm version 0.4.4 in Extension details. Because a manually installed older VSIX can downgrade the same extension identifier, verify the installed bundle as well:

```bash
VSIX="/absolute/path/to/codex-insights-0.4.4.vsix"
code --install-extension "$VSIX" --force
EXPECTED="$(unzip -p "$VSIX" extension/dist/extension.js | sha256sum | cut -d' ' -f1)"
INSTALLED="$(code --locate-extension codex-insights-local.codex-insights)"
ACTUAL="$(sha256sum "$INSTALLED/dist/extension.js" | cut -d' ' -f1)"
test "$EXPECTED" = "$ACTUAL" && echo "v0.4.4 reset-compatible collector verified"
```

Stop if the version or hash differs. Check the selected VS Code profile and binary, reinstall the reviewed VSIX, reload, and repeat. Keep the reviewed VSIX and its published checksum until QA finishes. Do not install any v0.4.3 VSIX after a reset.

## Functional QA before any reset

1. Confirm existing history, filters, hover, quotas, Refresh, and Historical Data Integrity remain available.
2. Run two Refresh operations without new activity and confirm totals do not change.
3. Restart VS Code and repeat the bundle comparison.
4. Verify `npm run reset:history -- --repair` and `--apply` refuse to modify data.

## Controlled reset preparation

Follow [Controlled local token history reset](LOCAL_TOKEN_HISTORY_RESET.md). Close all VS Code, VSCodium, Codex CLI, and Codex App Server processes before running maintenance commands from an external terminal. SQLite maintenance requires a Node runtime that provides `node:sqlite`.

`prepare` creates a private verified backup and plan but does not reset statistics. Review its current event and token totals and the complete plan ID. Do not run `execute` without separate explicit authorization. A changed database, fallback, checkpoint, or JSONL source makes the plan stale and requires a fresh backup and plan.

After an authorized reset, reopen only with the verified v0.4.4 or newer collector. Confirm zero pre-cutover visible token events, two idempotent Refresh operations, the first new demonstrated delta, restart persistence, and continued official quota history. Retain the backup. Restoration discards statistics recorded after that backup and also requires explicit authorization.

## Scope limits

- Codex JSONL conversations, authentication, and official quota samples are not deleted.
- A JSONL absent during preparation cannot be included in the cutover baseline; restoring such an old source later requires review before Refresh.
- Writer-process detection is currently Linux-only.
- Node 20 CI validates the JSON fallback; Node 22 validates SQLite reset, rollback, and restore.
