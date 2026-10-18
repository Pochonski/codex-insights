# v0.4.2 upgrade QA and storage backup

Codex Insights v0.4.2 combines the premium status hover with cumulative-token reconciliation. On activation, the storage layer may migrate a v0.4.1 SQLite database from schema 5 to schema 6. The migration adds a counter-observation ledger; it does not rewrite historical token events or automatically repair legacy totals.

## Back up before installing the review VSIX

1. Close every VS Code window using the profile that contains Codex Insights. For remote extension hosts, back up storage on the host where the extension runs.
2. Locate the extension's `globalStorageUri` directory for publisher `codex-insights-local` and package `codex-insights`. In a standard local Linux profile it is normally under `~/.config/Code/User/globalStorage/codex-insights-local.codex-insights`; Insiders, portable, custom and remote profiles differ.
3. Copy the **entire directory** to a separate private location. Include `insights.sqlite`, any `insights.sqlite-wal` and `insights.sqlite-shm`, `sessions-index.json`, and quota-history files if present. Do not select only the `.sqlite` file.
4. Verify the copied file list and SHA-256 checksums. If SQLite is available, open the **copy** read-only and run `PRAGMA integrity_check`. Keep the original and backup private; do not attach either to a public issue.
5. Install the review VSIX only after the copy is verified. Do not run a migration test or repair tool on the original database.

If an upgrade fails, close VS Code before restoring the complete verified directory. Avoid replacing a live SQLite file while its WAL is active. No automatic historical repair is part of v0.4.2.

## Manual checks after installation

1. Record the pre-upgrade event count and input, cached input, output and reasoning totals. After opening v0.4.2, confirm legacy values remain numerically unchanged; the quality warning may identify unverified history.
2. Confirm live ChatGPT quotas, reset timers and the native SVG status hover. These are global account quotas and are separate from local token totals.
3. Open the dashboard and optional mini panel; verify recent usage groups, filters and the historical-quality notice.
4. Trigger Refresh twice without new JSONL data. Confirm no duplicate tokens. Then create a normal new Codex interaction, refresh, and confirm only new usage appears.
5. Restart VS Code and repeat the count, quota, hover and Refresh checks. Report discrepancies with anonymized metrics and diagnostic logs only, never with prompts, JSONL, credentials or database files.

The synthetic migration, rollback and fallback tests run in temporary directories. Manual QA is still needed on a backed-up installation because these tests do not open personal storage or authenticate with a real ChatGPT account.
