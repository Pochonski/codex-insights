# E2E testing status

The automated suite includes a simulated VS Code lifecycle test. It activates the extension, registers the dashboard command, exchanges a typed snapshot through the Webview boundary, and releases timers and services on deactivation. App Server interactions use local mock processes; no ChatGPT account, prompts, or model usage is required.

Electron-driven interaction is intentionally not a required CI gate yet. Running a full VS Code desktop harness reliably needs display support and a pinned VS Code download cache, neither of which is guaranteed in all repository runners. The next step is to add a separate @vscode/test-electron job with a mocked provider and a virtual display, while keeping unit and integration tests as the deterministic merge gate.

Manual release smoke test:

1. Install the generated VSIX in an Extension Development Host.
2. Open Codex Insights and confirm the dashboard command opens once.
3. Use a temporary sessions path with synthetic JSONL data to validate custom dates and partial-line continuation.
4. Close the panel and VS Code; confirm no background process or timer prevents shutdown.
