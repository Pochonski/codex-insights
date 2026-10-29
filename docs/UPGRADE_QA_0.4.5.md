# Codex Insights v0.4.5 maintenance upgrade QA

This is a review checklist for the v0.4.5 VSIX built from the preparation PR. Installing it must not run a token-history reset, historical repair, or storage migration. The extension identifier remains `codex-insights-local.codex-insights`.

## Before installing in a regular profile

First review the PR and run the isolated automated suite. An isolated E2E profile uses synthetic quotas and sessions; it does not check the user's account. To preserve a rollback point for manual QA, close all VS Code windows that use the profile, identify its actual `globalStorage/codex-insights-local.codex-insights` directory, and make a private copy of the **entire** directory. Include `insights.sqlite`, any `insights.sqlite-wal` and `insights.sqlite-shm`, `sessions-index.json`, `quota-history.json`, and other files present. Keep the copy outside this repository and the VSIX, restrict it to the owner, verify file hashes and SQLite `PRAGMA integrity_check`, then reopen VS Code. A custom VS Code profile or portable installation can use a different path. Never delete or edit the original files to prepare the upgrade.

Use the exact reviewed VSIX and compare its bundled Extension Host code with the installed extension after reloading:

```bash
VSIX="/absolute/path/to/codex-insights-0.4.5.vsix"
code --install-extension "$VSIX" --force
EXPECTED="$(unzip -p "$VSIX" extension/dist/extension.js | sha256sum | cut -d' ' -f1)"
INSTALLED="$(code --locate-extension codex-insights-local.codex-insights)"
ACTUAL="$(sha256sum "$INSTALLED/dist/extension.js" | cut -d' ' -f1)"
test "$EXPECTED" = "$ACTUAL" && echo "v0.4.5 bundle verified"
```

Confirm version 0.4.5 in the Extensions view. Do not reinstall v0.4.3 after a controlled reset; it lacks the compatible collector. The review build has not been installed in any personal profile by CI or by the preparation task.

## Manual checks

1. Confirm existing token history, quota history, and Historical Data Integrity remain visible with no unexplained changes. Auditing must still say **No changes applied**.
2. Run Refresh twice without new Codex activity. Token event count and totals must remain unchanged. With a new interaction, confirm only the demonstrated new delta appears; a short reply can legitimately include a large cached input context.
3. Hover over the Status Bar indicator in dark, light, and high contrast themes. Confirm quota percentages are **used**, reset times and stale labels are readable, and Dashboard, Refresh, and Copy actions work. Compare official quotas independently with Codex App Server if a real-account QA run is approved.
4. Exercise period, session, model, project, and custom UTC date filters. Changing local filters must not change official account quota percentages.
5. Restart VS Code and confirm history, filters, quota samples, and hover state persist or refresh correctly.
6. Check that the reset and recovery scripts are absent from the VSIX. They remain explicit source-repository operations. Do not run `prepare`, `execute`, `restore`, or `recover` on personal storage as part of ordinary upgrade QA.

The automated suite covers hard process exits at both reset commit boundaries, verified backup restoration, cutover replay, SQLite/JSON divergence, and synthetic React/Electron behavior. It cannot prove that an unchanged-metadata rewrite in the middle of every possible JSONL is detectable without rereading that file. See [deep audit remediation](DEEP_AUDIT_REMEDIATION_0.4.4.md).

## If a check fails

Stop using the review build and record the version, VSIX checksum, exact failing check, and nonprivate diagnostics. Do not attempt a manual SQLite edit or delete session files. A backup made before the upgrade is a rollback point only while no newer local statistics need to be preserved; restoring it would discard later writes and must be planned separately.
