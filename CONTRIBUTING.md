# Contributing to Codex Insights

Thanks for helping improve the extension. Use Node.js 22, VS Code 1.90 or newer, and a Codex CLI that supports `app-server --stdio`.

1. Fork the repository and create a focused branch such as `feature/quota-chart` or `fix/session-index`.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run package` before opening a pull request.
3. Describe the behavior changed, tests run, and any migration or privacy impact in the pull request.
4. Keep ChatGPT plan quotas separate from local token metrics. Do not add external telemetry or commit credentials, account data, JSONL sessions, SQLite databases, or unredacted logs.
5. Do not include generated `dist/`, `media/dashboard.js`, `node_modules/`, or VSIX files in pull requests.

Use Issues for ordinary bugs and enhancements. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.
