# Quick monitoring surfaces (v0.4.2)

The right-aligned Status Bar item keeps its existing priority and opens the full dashboard on click by default. Its tooltip is a `vscode.MarkdownString` with embedded vector progress bars; no Webview or editor tab is created on hover. The pure formatter in `src/extension/status-summary.ts` consumes the latest in-memory quota and local session aggregate. Hovering performs no I/O.

## Data and presentation

- Quota percentages are official **used** percentages from Codex App Server. The 5-hour and 7-day windows are shown only when present. The remaining percentage is `100 - used` after bounding anomalous values to 0–100.
- Reset times come from absolute App Server timestamps. Once a reset timestamp passes, the tooltip says that confirmation is pending; it does not assume a new quota sample exists.
- Token counts cover all recorded local history, independent of the dashboard filters. Cached input is a subset of input and is not added to the total. The model label is the last model observed in a timestamped local usage event.
- Warning begins at 80% used, critical at 95%, and exhausted at 100%. A quota sample older than 10 minutes is labeled stale even if a provider has not yet reported a disconnect. Explicit stale and offline states take precedence over numeric severity.
- The status text updates when new data arrives. One presentation timer refreshes relative timestamps every minute. No quota request occurs on that timer. VS Code controls the native tooltip lifecycle, so text in an already open tooltip may require re-hovering to refresh.
- Each bar is an SVG generated from bounded numeric percentages and fixed color palettes, then embedded as a `data:image/svg+xml;base64` Markdown image. No temporary image file or remote URL is needed. The visible Markdown text and image alt text keep percentages accessible if images are disabled. Theme changes regenerate the image from the current in-memory snapshot. Dark, light, and high contrast palettes are supported.
- VS Code semantic `warningBackground` and `errorBackground` are used only for critical and exhausted states. Text and icons carry the meaning without relying on color.

Example Markdown produced from synthetic data:

```markdown
### $(pulse) Codex Insights

**Connected** · ChatGPT Plus
Updated 12s ago

**5-HOUR LIMIT · 44% used**
56% available · Resets in 4h 19m
![5-hour limit, 44% used](data:image/svg+xml;base64,...)

**7-DAY LIMIT · 41% used**
59% available · Resets in 5d 19h
![7-day limit, 41% used](data:image/svg+xml;base64,...)

**Local activity** · all recorded history
Input 146.6M · Output 716K
Recorded usage groups 149 · Cached input 142.8M

[Dashboard](command:codexInsights.openDashboard) · [Refresh](command:codexInsights.refresh) · [Copy](command:codexInsights.copySummary)
```

The sample is illustrative and contains no user data. The precise relative reset text changes with the clock.

## Commands and settings

The Status Bar click runs `codexInsights.openDashboard` by default. Set `codexInsights.statusBar.clickAction` to `miniPanel` only to opt into the editor panel. The Markdown links run only `codexInsights.openDashboard`, `codexInsights.refresh`, and `codexInsights.copySummary`; `MarkdownString.isTrusted` allowlists exactly those command IDs. The command URIs contain no arguments or session-derived content. The commands are also available in the Command Palette. Copy Summary generates plain text with a timestamp and an explicit stale label where needed. It omits account identifiers, email, prompts, and responses.

`codexInsights.statusBar.compact` defaults to `false` and shortens the item text when enabled. `codexInsights.statusBar.showWeeklyQuota` defaults to `true` and controls whether the 7-day window appears in the item and tooltip. The dashboard's global quotas and the mini panel's available windows are unaffected by these presentation settings.

## Mini panel

The optional mini panel uses an official `vscode.WebviewPanel` in the editor area. It is available through **Codex Insights: Open Mini Panel** or the explicit click preference, but it does not replace the automatic hover. One controller reuses and reveals the existing panel on repeated opens. The panel receives a normalized summary derived from the same in-memory quota and analytics data as the hover and full dashboard. Opening it starts no extra App Server process or polling loop.

React shows each available quota window with an accessible progress bar, reset time and absolute date tooltip, plus all-history input, output, recorded usage groups, cached input share, and last observed model. A recorded usage group is a distinct stored ID, not necessarily an independent conversation. Dashboard, Refresh, and Copy buttons send fixed typed messages to the host. Only `mini/ready`, `mini/refresh`, `mini/openDashboard`, and `mini/copySummary` are accepted; extra payloads are rejected. The Webview receives no account ID, credentials, prompts, or conversation content. It has local `media/` resource roots, nonce-based scripts, and a restrictive CSP. A local 15-second timer updates relative labels and is removed on unmount.

The demo screenshots are rendered from the real built React bundle and CSS using synthetic data in Chromium: [dark normal](assets/mini-dark-normal.png), [light normal](assets/mini-light-normal.png), [critical](assets/mini-dark-critical.png), and [stale](assets/mini-dark-stale.png). They are previews of Webview content, not screenshots of the VS Code workbench.

## API constraints and verification

VS Code's [StatusBarItem API](https://code.visualstudio.com/api/references/vscode-api#StatusBarItem) supports text, a `MarkdownString` tooltip, click command, accessibility information, and semantic status colors. The [command URI guide](https://code.visualstudio.com/api/extension-guides/command#command-uris) documents links in hover Markdown. The [icon reference](https://code.visualstudio.com/api/references/icons-in-labels) documents codicons in status text and Markdown. Arbitrary CSS, interactive HTML cards, custom layouts, and a live second-by-second countdown inside the native tooltip are unsupported. A complete card could be flattened into an image, but its text and actions would lose native accessibility and interaction; this implementation uses Markdown text plus vector bars.

## Actual hover image experiment

Using an isolated VS Code 1.90.0 Extension Development Host with synthetic quotas, we moved the pointer onto the real Status Bar item and captured the native tooltip. Three Markdown image sources rendered in that tooltip: `data:image/png;base64`, `data:image/svg+xml;base64`, and a relative PNG resolved through `MarkdownString.baseUri` to a local file. The SVG data URI was selected because it stays crisp at display scaling and avoids filesystem writes or remote-resource handling. The [dark](assets/status-hover-dark.png), [light](assets/status-hover-light.png), and [high contrast](assets/status-hover-high-contrast.png) captures prove image rendering in the native hover; they predate the session-label correction and still show the old wording. The current formatter says **Recorded usage groups**, as covered by regression tests. A fresh visual hover check remains part of manual PR #4 QA. No account data or real Codex sessions were used.

Unit tests cover formatting, SVG output, themes, states, safety, time math, normalized data, protocol validation, actual React DOM rendering, progress attributes, and button messages. Electron E2E verifies the real Status Bar item's Markdown image URIs, default dashboard click, optional mini click, snapshot updates, and dashboard lifecycle. The screenshot experiment verified actual hover pixels separately; it is not a CI gate because it depends on a graphical Hyprland session. Before merging, compare real-account percentages and reset times against the dashboard and check hover actions and stale/critical wording in a normal installation.
