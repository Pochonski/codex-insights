# Native Status Summary (v0.4.2)

The right-aligned Status Bar item keeps its existing priority and opens the dashboard on click. Its tooltip is a `vscode.MarkdownString`; no Webview or browser layer is created on hover. The pure formatter in `src/extension/status-summary.ts` consumes the latest in-memory quota and local session aggregate. Hovering does not perform I/O.

## Data and presentation

- Quota percentages are official **used** percentages from Codex App Server. The 5-hour and 7-day windows are shown only when present. The remaining percentage is `100 - used` after bounding anomalous values to 0–100.
- Reset times come from absolute App Server timestamps. Once a reset timestamp passes, the tooltip says that confirmation is pending; it does not assume a new quota sample exists.
- Token counts cover all recorded local history, independent of the dashboard filters. Cached input is a subset of input and is not added to the total. The model label is the last model observed in a timestamped local usage event.
- Warning begins at 80% used, critical at 95%, and exhausted at 100%. A quota sample older than 10 minutes is labeled stale even if a provider has not yet reported a disconnect. Explicit stale and offline states take precedence over numeric severity.
- The status text updates when new data arrives. One presentation timer refreshes relative timestamps every minute. No quota request occurs on that timer. VS Code controls the native tooltip lifecycle, so text in an already open tooltip may require re-hovering to refresh.
- VS Code semantic `warningBackground` and `errorBackground` are used only for critical and exhausted states. Text and icons carry the meaning without relying on color.

Example Markdown produced from synthetic data:

```markdown
### $(pulse) Codex Insights

**Connected** · ChatGPT Plus

Updated 12s ago

---

**5-hour limit**

68% used · 32% remaining

Resets in 1h 24m

**7-day limit**

16% used · 84% remaining

Resets in 6d 19h

---

**Local tokens · all recorded history**

Input 1.2M · Output 24.5K

Cached input 1.1M · Sessions 1

Last observed model: gpt\-6\-sol

---

[Open Dashboard](command:codexInsights.openDashboard) · [Refresh](command:codexInsights.refresh) · [Copy Summary](command:codexInsights.copySummary)
```

The sample is illustrative and contains no user data. The precise relative reset text changes with the clock.

## Commands and settings

The Status Bar click runs `codexInsights.openDashboard`. The Markdown links run only `codexInsights.openDashboard`, `codexInsights.refresh`, and `codexInsights.copySummary`; `MarkdownString.isTrusted` allowlists exactly those command IDs. The command URIs contain no arguments or session-derived content. The commands are also available in the Command Palette. Copy Summary generates plain text with a timestamp and an explicit stale label where needed. It omits account identifiers, email, prompts, and responses.

`codexInsights.statusBar.compact` defaults to `false` and shortens the item text when enabled. `codexInsights.statusBar.showWeeklyQuota` defaults to `true` and controls whether the 7-day window appears in the item and tooltip. The dashboard's global quotas are unaffected by these presentation settings.

## API constraints and verification

VS Code's [StatusBarItem API](https://code.visualstudio.com/api/references/vscode-api#StatusBarItem) supports text, a `MarkdownString` tooltip, click command, accessibility information, and semantic status colors. The [command URI guide](https://code.visualstudio.com/api/extension-guides/command#command-uris) documents links in hover Markdown. The [icon reference](https://code.visualstudio.com/api/references/icons-in-labels) documents codicons in status text and Markdown. Arbitrary CSS, custom HTML layouts, and a live second-by-second countdown inside the native tooltip are unsupported here.

Unit tests cover formatting, states, safety, and time math. Electron E2E verifies the real Status Bar item's values through a Test-mode probe, its command, quota updates, clipboard command, and dashboard lifecycle. It does **not** automate a mouse hover or verify native tooltip pixels. Before merging, manually hover over the item in both dark and light themes, use each quick action, and confirm that stale and critical wording remains legible.
