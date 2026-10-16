# VS Code Electron E2E testing

Codex Insights v0.4.1 runs a real Extension Development Host through the official @vscode/test-electron package. The runner downloads VS Code 1.90.0, which satisfies the extension engine requirement, and creates temporary user-data, extensions, and workspace directories. It removes those temporary directories when the process finishes.

Run the suite on Linux:

```bash
npm run test:e2e
```

For a headless desktop, use:

```bash
xvfb-run -a npm run test:e2e
```

CI runs the same command through Xvfb. The first execution downloads the VS Code test binary into the ignored `.vscode-test/` cache. Set a breakpoint in `test/e2e/suite.ts` and run the command from VS Code to debug the Extension Development Host.

The test fixture is active only when VS Code supplies ExtensionMode.Test. It never runs in a normal extension installation. It provides synthetic session and quota observations and never starts Codex App Server, reads a Codex session directory, reads auth.json, or sends a model request.

## What the real Electron test verifies

- The extension activates in an isolated VS Code process.
- The dashboard command and E2E-only Test-mode probe are registered.
- The dashboard creates a Webview panel.
- The React app sends its ready message after mounting; this is the Webview-to-host evidence that the bundled frontend loaded and executed.
- The host sends dashboard snapshots containing synthetic data and a connected quota state.
- A simulated quota update produces another host snapshot.
- Closing and reopening the real dashboard panel updates the lifecycle state.

## Scope limits

The test does not use browser automation to click controls inside the Webview DOM. Filter selection, charts, custom range input, countdown rendering, and accessibility are covered by unit/integration tests and manual QA, not by pixel or DOM-level Electron automation. A future visual suite may use a maintained VS Code UI driver, but it must remain separate from this deterministic Extension Host gate.

The initial local environment did not provide xvfb-run. The test also runs against the available display server after sanitizing inherited Extension Host variables; CI uses Xvfb for a consistent headless display.
