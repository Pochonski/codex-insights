# Codex Insights v0.4.3 upgrade QA

This is a review build. Historical repair is disabled. The audit CLI only reads an **isolated copy** of storage; do not point it at a live VS Code database. The VSIX uses the existing extension identifier, so installing it over v0.4.2 preserves the extension's storage location. No new SQLite migration is introduced by v0.4.3; the session schema remains at version 6.

## Back up before installing

1. Close **all** VS Code windows and extension hosts that use this profile. Locate the Codex Insights directory under the profile's `User/globalStorage` (typically named `codex-insights-local.codex-insights`). Profiles, Insiders, and remote hosts can use different roots. Do not assume the example path is your active profile.
2. Copy the **entire directory** to a private location outside the repository, including `insights.sqlite`, any `insights.sqlite-wal`/`insights.sqlite-shm`, quota storage, and JSON fallback files when present. Restrict the backup directory to your user (`0700`) and keep the original untouched. Do not post the backup or its filenames in an issue.
3. Verify the copy is readable and its size/file count match the stopped source. On a copied SQLite database, run `PRAGMA integrity_check` and expect `ok`; use a read-only connection. A plain copy taken while VS Code is writing is not a consistent backup. If VS Code must remain open, use SQLite's backup API to produce a consistent snapshot rather than copying only the `.sqlite` file.
4. Keep the backup until QA and at least one restart have passed. Restoring an older whole-directory backup would discard later imports, so stop VS Code and review any newer data before restoration.

Do **not** modify, remove, or recreate the original SQLite, WAL, SHM, JSON fallback or Codex JSONL files for this QA.

## Install and check

Install the review VSIX through **Extensions → … → Install from VSIX…**, or run `code --install-extension /path/to/codex-insights-0.4.3-qa.vsix --force` against the intended VS Code installation. Reload VS Code. Do not install this build into a different profile unintentionally.

1. Confirm Codex Insights reports **0.4.3** in the installed extension details and the dashboard footer.
2. Compare recorded token totals and historical charts with the pre-upgrade notes. The audit must not silently reduce old totals. Restart VS Code and confirm persistence.
3. Hover over the status-bar item without clicking. Check the native quota summary, reset times, stale state when relevant, and Dashboard/Refresh/Copy links. Open the dashboard. In **Historical Data Integrity**, select **Run read-only audit** and verify that Events analyzed, Supported by available evidence, Ambiguous observations, Unverifiable legacy, Confirmed adjustments, generation time, and **No changes applied** are visible. Candidate counts are leads and must not appear as confirmed adjustments.
4. Confirm official 5-hour and 7-day quota values against Codex's own view when available. They are independent of token totals. Verify countdowns and Refresh; do not run model prompts solely for QA.
5. Create or observe a normal new Codex usage event if one occurs during ordinary work. Refresh twice and confirm the second refresh does not duplicate the event. Check combined filters and history after another restart.
6. For the audit CLI, create a separate consistent **private snapshot**, then use `node scripts/audit-history.mjs audit --snapshot-db /private/snapshot.sqlite`. Optional surviving JSONL can be supplied with `--sources`. Check that the output distinguishes current, demonstrable adjustment, proposed, ambiguous, and unverifiable data. Use `plan` only with a private output path outside the repo; `inspect` and `validate` must accept that plan against its unchanged snapshot.
7. Verify `node scripts/audit-history.mjs audit --repair` and `--apply` both refuse to run. Do not run any third-party repair tool on personal data.

## Dashboard audit states

- Before an audit, the dashboard says that no valid result is available. It never substitutes zeros for unavailable classifications.
- During an explicit audit it shows a loading state. Concurrent requests share the same run. Ordinary Refresh does not start a historical audit.
- A complete or partial result is built from an isolated in-memory copy of the committed session index. Only anonymous category counts, a short snapshot digest, timing and missing-source flags cross the Webview boundary.
- If a later scan indexes changed files, the prior result is marked **Out of date** until the user runs the audit again.
- Failed audits preserve stored totals and provide a retry. No dashboard control can apply a repair.

The audit's `confirmed_unique` code label is scoped to surviving evidence. Candidate counts may overlap and are **not** token amounts to subtract. A zero demonstrable adjustment is not proof that old totals are accurate. Report unexpected changes with anonymized counts only; retain private snapshots and plans locally.
