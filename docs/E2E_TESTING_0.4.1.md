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
- In v0.4.2, a Test-mode probe reads the real StatusBarItem's text, native Markdown value, trusted command allowlist, and click command. Synthetic quota updates change the item. Refresh and Copy Summary commands execute; the clipboard is restored after the assertion.
- The v0.4.2 hover assertion checks two generated SVG `data:` images and confirms the default click opens the dashboard; the mini panel click remains an optional setting.
- The v0.4.2 mini panel opens a real WebviewPanel. Its React bundle sends a ready handshake; synthetic quota updates reach that panel. Repeated opens reveal the same instance, and close/reopen creates one new instance. The dashboard still opens independently.

## Scope limits

The automated Electron CI test does not move the mouse or click controls inside the Webview DOM. A separate jsdom test executes the compiled mini React bundle, verifies quota progress attributes, and clicks Dashboard, Refresh, and Copy controls. An isolated graphical VS Code 1.90 instance was also used for one-off manual hover capture in dark, light, and high contrast themes; those real hover screenshots are in `docs/assets/status-hover-*.png`. This pixel check is not a CI gate because it depends on a graphical Hyprland session. Filter selection, charts, custom range input, and real-account accuracy still require their existing tests and manual QA.

The initial local environment did not provide xvfb-run. The test also runs against the available display server after sanitizing inherited Extension Host variables; CI uses Xvfb for a consistent headless display.
