# Security audit — Codex Insights 0.3.1

Date: 2026-10-15

## Scope and threat model

The review covered the VS Code Extension Host, the private `codex app-server --stdio` child process, JSON-RPC framing, quota and session persistence, JSONL ingestion, the React Webview, build dependencies, CI, and packaged VSIX contents. Considered threats include command injection, hostile or malformed subprocess output, leaked credentials, unsafe Webview messages, local data corruption, duplicate observations, abandoned processes, and accidental publication of private files.

Codex Insights remains local-first. It starts Codex with a fixed argument array and `shell: false`, does not read `auth.json`, does not log App Server stderr, does not send custom telemetry, and does not provide the Webview with credentials or arbitrary file access.

## Findings and mitigations

| Severity | Finding | Manifestation | Mitigation in 0.3.1 |
| --- | --- | --- | --- |
| High | A timed-out App Server request left the unresponsive process available for later calls. | Repeated requests could continue using a wedged child process and pending work had no coordinated recovery. | Timeouts now reject pending calls, terminate the child, serialize reconnection, and use bounded exponential backoff with jitter. Only `account/read` and `account/rateLimits/read` are retried. |
| High | An invalid JSON fallback could be treated as empty. | A later save could replace recoverable historical data with a new empty history. | Invalid fallback data now disables writes, preserves the original file, and surfaces a recoverable storage error. SQLite corruption follows the same fail-closed behavior. |
| Medium | Late RPC responses could update state after changing the configured executable. | An older provider could overwrite data from the replacement process. | Refreshes carry a generation guard; results from a superseded client are discarded. |
| Medium | Ambiguous out-of-order cumulative token records could be interpreted as counter resets. | This could add the lower total again and overcount usage. | Chronologically older observations and timestamp-less decreases are skipped with a warning. Ordered resets remain supported. |
| Medium | Duplicate observations could remain as separate SQLite rows. | Aggregate logic removed duplicates, but storage could grow unnecessarily. | Schema migration 4 removes duplicate fingerprints, adds a partial unique index, and inserts subsequent observations idempotently. |
| Low | The dashboard refresh button depended indefinitely on a response. | A skipped or interrupted refresh could leave the UI in a busy state. | A bounded UI timeout clears the indicator; incoming snapshots clear it immediately. |
| Low | Panel message subscriptions lived for the full extension lifetime. | Repeated panel creation retained inactive handlers until deactivation. | The message subscription is now disposed with its panel. |

No critical vulnerability was confirmed. `npm audit --audit-level=moderate` reported zero vulnerabilities during this audit.

The dependency review kept the tested major versions. `npm outdated` reported newer majors for Node type definitions, `concurrently`, `jsdom`, and TypeScript; none is a runtime dependency of the installed extension, and changing them was deferred to avoid an unrelated toolchain migration. React and React DOM remain on the maintained 19.x line and are bundled locally.

## Webview controls

- CSP denies all resources by default, permits only extension-hosted styles, fonts, images, and nonce-authorized scripts, and sets `connect-src`, `object-src`, `frame-src`, `base-uri`, and `form-action` to `none`.
- No remote scripts or `dangerouslySetInnerHTML` are used.
- Incoming commands are allowlisted and filter values are normalized.
- The React bundle validates snapshot shape before rendering it.
- Full project paths remain available inside the local Webview because they are current filter identifiers. They are never sent off-device; reducing them to opaque IDs is a future privacy-hardening option.

## Persistence and recovery

SQLite migrations run inside transactions with a busy timeout. Quota sample batches and retention cleanup are atomic. Failed migrations close the connection and preserve the original database. JSON fallbacks use a temporary file and atomic rename when writable. The extension never deletes or recreates a corrupt database automatically.

Recovery procedure:

1. Close VS Code and make a copy of the extension global-storage directory.
2. Preserve `insights.sqlite`, its WAL/SHM companions, and the JSON fallback files.
3. Run SQLite integrity checks against the copy, not the original: `sqlite3 insights.sqlite "PRAGMA integrity_check;"`.
4. Reopen VS Code after isolating the damaged copy or restoring a known-good backup. Do not delete authentication files; Codex authentication is unrelated to the analytics database.

## Verification evidence

- All 39 automated tests pass on Node.js 20 and on the local Node.js 26 runtime. They cover missing executables, JSON-RPC errors, invalid JSON, process exit, request timeout, reconnection, disposal with pending work, malformed JSONL, counter resets, out-of-order events, duplicate files, migrations, corrupt JSON and SQLite preservation, CSP, message validation, filters, countdowns, React rendering, and simulated Extension Host cleanup.
- CI installs with `npm ci`, runs type checking, tests, both builds, VSIX packaging, a sensitive-file/package scan, and `npm audit`.
- The VSIX inspection rejects databases, JSONL, credentials, logs, extracted older versions, and known token formats.
- A read-only smoke test against Codex CLI 0.163.0 returned a connected ChatGPT plan and the 300-minute and 10,080-minute quota windows. It did not execute a model or print account identifiers.

## Residual risks

- The current release still reparses a changed JSONL file in full. Offset-based indexing and stronger crash journaling remain planned for 0.4.0.
- App Server compatibility is contract-tested with local fixtures. A final manual check with real quotas is required for each materially new Codex CLI version.
- Local users with access to the VS Code profile can read analytics metadata stored by the extension; operating-system account isolation remains the security boundary.
