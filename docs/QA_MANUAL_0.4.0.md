# v0.4.0 manual upgrade QA

This procedure preserves the existing v0.3.1 storage before installing the review VSIX. Do not copy account credentials, auth files, or Codex session logs into an issue or chat.

## Back up local extension storage

1. Close all VS Code windows that use Codex Insights.
2. Find the extension storage directory from the VS Code Developer Tools or the extension log. On a normal Linux Code installation it is under the user-data directory at User/globalStorage/codex-insights-local.codex-insights. VS Code Insiders, portable installs, and other platforms use their own user-data directory.
3. Copy that directory to a dated backup location outside the repository. Keep the original in place.
4. Do not copy the Codex CLI auth directory. Codex Insights does not need it for this test.

## Install and validate

Install codex-insights-0.4.0.vsix with Extensions: Install from VSIX, then reload VS Code. Confirm:

1. Existing history is visible after the upgrade.
2. ChatGPT quotas and countdowns still display real values.
3. Quota and token charts retain their history.
4. Session, model, project, and period filters combine correctly.
5. A custom one-day range, equal start/end date, empty range, and invalid inverted range behave correctly.
6. Close and reopen the dashboard, then restart VS Code; history and filter selection remain coherent.
7. Add or wait for new local JSONL activity, refresh, and confirm totals advance once only.
8. Temporarily set an invalid Codex executable, observe a stale-data indication, restore the executable, and confirm recovery.

If migration fails, stop the test, preserve the original storage and backup, and attach only sanitized diagnostic details to the issue.
