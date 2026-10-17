# Codex Insights

**Professional analytics and usage monitoring for OpenAI Codex in Visual Studio Code.** Codex Insights is an independent, local-first VS Code extension. It is **not an official OpenAI extension** and sends no custom telemetry.

Version **0.4.0** adds byte-offset JSONL indexing, transactional source checkpoints, partial-line recovery, custom date ranges, and optional local import diagnostics. The interface is built with React 19.

## Features

- Read real ChatGPT plan quota percentages and reset timestamps through the local Codex App Server, including the 5-hour and 7-day windows when available.
- Show live countdowns without polling every second, and record real quota samples for historical charts.
- Index local Codex JSONL sessions and analyze input, output, cached input, and reasoning output tokens.
- Explore timestamped token charts, sessions, models, and projects with combined period, custom date range, session, model, and project filters.
- Persist quota samples and normalized session entities in SQLite, with local JSON fallback for runtimes without `node:sqlite`.
- Deduplicate repeated observations, retain indexed history across restarts, and keep credentials under Codex CLI's control.

![Codex Insights dashboard showing synthetic quota and token data](docs/assets/dashboard-demo.png)

*Demo dashboard with synthetic data.*

## Requirements and installation

- Visual Studio Code **1.90+**.
- Codex CLI with `codex app-server --stdio` (real-account baseline verified with CLI **0.162.1**; account and quota reads also verified locally with **0.163.0**).
- A ChatGPT login in Codex CLI to display ChatGPT plan quotas. API-key accounts do not expose those plan quotas.

Install the latest reviewed VSIX using **Extensions → … → Install from VSIX…**, reload VS Code, then run **Codex Insights: Open Dashboard** from the Command Palette. The extension identifier remains `codex-insights-local.codex-insights`, so 0.3.1 upgrades 0.3.0 without changing its storage location.

To sign in, run `codex login` and complete the browser flow, or use **Codex Insights: Sign in with ChatGPT**. Check CLI login state with `codex login status`. Codex Insights delegates authentication to Codex App Server; it does not read `auth.json` or store access tokens.

## Development

Use **Node.js 22** and npm. From this repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run package
npm run benchmark
```

`build` writes the Extension Host bundle to `dist/extension.js` and the React bundle to `media/dashboard.js`. `package` creates `codex-insights-0.4.1.vsix`. These generated files are excluded from Git. Open the folder in VS Code and press **F5** to start an Extension Development Host. `npm run watch` rebuilds both bundles during development. The benchmark is synthetic, creates only temporary data, and is documented in [the v0.4.0 comparison](docs/PERFORMANCE_COMPARISON_0.4.0.md). The package excludes the E2E test bundle.

Run the isolated VS Code Electron suite with `npm run test:e2e`; Linux CI uses `xvfb-run -a npm run test:e2e`. The suite downloads VS Code 1.90.0 on first run, uses synthetic data, and does not use Codex credentials or App Server. See [the E2E guide](docs/E2E_TESTING_0.4.1.md).

## Architecture and data sources

| Directory | Responsibility |
| --- | --- |
| `src/extension` | Activation, commands, Status Bar, timers, Webview lifecycle, and cleanup. |
| `src/providers` | Private `codex app-server --stdio` subprocess, JSON-RPC, login handoff, and quota normalization. |
| `src/collectors` | Local JSONL discovery and persistent session index. |
| `src/storage` | SQLite migrations and tables for quota samples, projects, models, sessions, token events, and import state. |
| `src/analytics` | Aggregations, historical series, and combined filters. |
| `src/webview` | React dashboard, countdowns, styles, and Content Security Policy. |
| `src/protocol/generated` | TypeScript contracts generated from Codex App Server. |

Quota percentages are **official account-level values** reported by App Server. Token counters are **locally observed** in Codex session files; they are not API billing and cannot be used to infer ChatGPT quotas. `cached_input_tokens` is already part of `input_tokens`. Reasoning output is displayed separately and is not added again to output totals. Token filters never change global quota percentages.

All history is stored under VS Code's extension `globalStorageUri`, outside the source tree. SQLite records a SHA-256 account identifier rather than the raw account ID. JSON fallbacks are written atomically. Session records store metadata and token counts, not conversation content. The Webview receives no credentials, cannot access local files directly, and has a restrictive CSP. There is no project-owned server, external telemetry, or Marketplace publishing workflow.

## Configuration

| Setting | Purpose |
| --- | --- |
| `codexInsights.sessionsPath` | Override `CODEX_HOME/sessions` or `~/.codex/sessions`. |
| `codexInsights.refreshSeconds` | Local session scan interval, minimum 15 seconds. |
| `codexInsights.codexExecutable` | Codex CLI executable; default `codex`. |
| `codexInsights.quotaRefreshSeconds` | Quota polling interval, minimum 60 seconds. |

## Testing and troubleshooting

`npm test` runs simulated JSON-RPC recovery, timeout, malformed protocol, SQLite migration and corruption, session-index, deduplication, filter, countdown, message-boundary, lifecycle, and React rendering tests. These tests do not generate model usage. The v0.3.0 dashboard baseline was manually validated in VS Code for real quotas, countdowns, charts, all four filters, and persistence; 0.3.1 still requires a final manual real-account smoke test before release.

The dashboard's **Usage groups** count is the number of distinct IDs attached to local token events, not a verified count of independent conversations. Older indexes can contain response-item IDs such as `ctco_` because of a previous attribution error. The collector now keeps new usage with the verified `session_meta` identity, while preserving old token amounts for a separately reviewed repair. See the [session classification audit](docs/SESSION_CLASSIFICATION_AUDIT.md). Run `npm run audit:sessions` for anonymous, read-only local counts; it prints no paths, IDs, prompts, or responses.

If quotas are unavailable, check `codex --version`, `codex app-server --help`, `codex login status`, and the executable setting, then run **Codex Insights: Refresh**. If sessions are missing, check the session path and selected period. Quota history begins when the extension starts sampling; it cannot be reconstructed from token events.

## Known limitations and roadmap

- A continuation reads only new bytes. Ambiguous replacement or truncation reconciles the affected file safely.
- The dashboard limits each view to 250 session rows and 500 time points for responsiveness.
- Alerts, predictions, exports, and DOM-level visual Webview automation remain planned.

New observability providers should emit typed, timestamped observations with explicit provenance. Keep official quotas separate from observed and estimated metrics, add a schema migration for persisted fields, and expose only calculated views to the Webview.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull requests. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); do not publish credentials or sensitive records in Issues. The detailed 0.3.1 review is in [docs/SECURITY_AUDIT_0.3.1.md](docs/SECURITY_AUDIT_0.3.1.md).

## License

[MIT](LICENSE). Third-party notices for the bundled React runtime are in `media/licenses/`.
