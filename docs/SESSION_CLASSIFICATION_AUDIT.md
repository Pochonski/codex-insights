# Session identity and token accounting audit

This audit is based on Codex Insights v0.4.1 source, synthetic regression tests, a **read-only** inspection of local JSONL metadata, and read-only SQLite queries. It does not include prompts, responses, credentials, full paths, or real identifiers. The session files were active during inspection, so counts are timestamped snapshots rather than a stable inventory. Run `npm run audit:sessions` to obtain a fresh anonymous report. Optional `--sessions` and `--storage` arguments select alternate directories without printing their paths.

## Verified facts

### What the product called a session

The collector assigns `UsageEvent.sessionId`; `aggregate()` groups by its distinct value. `buildAnalyticsView()` then reports `sessionCount = number of distinct event.sessionId values` after filters and displays up to 250 groups. The SQLite `sessions` table is populated from these values, not directly from `session_meta`. Therefore **“Showing 250 of 329 matching sessions” meant 329 distinct recorded IDs with token events**, not 329 verified conversations.

The old parser replaced the current `sessionId` with any `payload.id`, regardless of record type. In the inspected JSONL, `ctco_` appeared in `response_item/custom_tool_call_output.payload.id`. It identifies a tool-output item. `fco_` and `msg_` appeared on other response items. A later `event_msg/token_count` usually has no such item ID, so it inherited the most recent response item's ID. The extension did **not** generate the `ctco_` prefix; it generated the mistaken association between that item ID and a usage event. The file's `session_meta.payload.session_id` / `id` is the observed thread identity. All four current `session_meta` records reported `thread_source: user` and `source: vscode`.

The current collector reads cumulative `event_msg/token_count.payload.info.total_token_usage`, computes per-file deltas, and ignores `token_usage_record`. Cached input remains a subset of input; reasoning output is reported separately and not added to output. The parser's mistaken `sessionId` changes grouping and filters, **not the numeric delta itself**. Different filenames with identical records are deduplicated by a fingerprint; SQLite has a unique fingerprint index. A token amount matching another amount does not prove a duplicate.

### Anonymous snapshot behind the 329 screenshot

The following counts came from a read-only query of the extension's SQLite database during the audit. The database contained 995 token events across four stored source generations, one of which was archived after a source replacement. No duplicate non-null fingerprints were found.

| Recorded ID shape | Distinct IDs | Events | Input tokens | Output tokens | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| `ctco_` item IDs | 310 | 310 | 71,941,785 | 296,643 | Tool-output IDs misused as session IDs. |
| UUID-form IDs | 2 | 668 | 98,175,017 | 481,536 | Both match current user-origin `session_meta`; one also occurs in an archived source generation whose original JSONL is unavailable. |
| Other item-shaped IDs | 17 | 17 | 1,717,304 | 9,009 | Consistent with response message/function-output IDs; not verified conversations. |
| **Total** | **329** | **995** | **171,834,106** | **787,188** | Distinct recorded IDs, not conversation count. |

Thus the screenshot's 329 entries included **327 item-shaped technical IDs**. Two stored UUID IDs were directly verified against current user-origin `session_meta`. Four current JSONL files contained user-origin metadata, but one had no recorded token event at that snapshot and an archived generation cannot be fully reconstructed from the database. The exact lifetime count of independent conversations is therefore **not provable from these rows alone**. No auxiliary/subagent relationship was found in the inspected metadata; `ctco_` must not be labeled a subagent.

A later run of the anonymous script, while Codex was active, observed 358 recorded IDs and 1,024 stored events. That increase is expected for a live source with the old attribution bug. It does not revise what the earlier 329 screenshot represented.

### SQLite and historical data

`token_events` stores ID, fingerprint, source generation, `session_id`, timestamp, model/project, and token deltas. `import_state` stores offsets and parser state. The `sessions` table stores the derived IDs. There is no parent-child relation or original JSONL payload in SQLite. Some events are retained under archived source generations after replacement. Because the original archived bytes are absent, blindly reassigning those events or deleting them would be unsafe. No personal database was modified during this audit.

The fallback JSON index contains the same derived events. A separate defect was confirmed with a synthetic test: when a valid legacy JSON index existed but SQLite was empty, the first incremental SQLite write could make SQLite authoritative on restart without importing the old JSON events. The fix imports that JSON index into empty SQLite in one transaction before accepting new events. The original JSON remains available.

## Corrections in the independent audit branch

- Only `session_meta` can establish the parser's canonical session identity; an explicit top-level `session_id` on a usage record remains a fallback when metadata is absent. Item IDs no longer replace the canonical ID. For a pre-fix checkpoint, the next changed-file import reads early metadata once to recover it before processing appended bytes. It does not rewrite old token amounts or silently reclassify archived rows. The SHA-256 fingerprint retains the previous item-ID sequence **solely for deduplication compatibility** with existing rows and copied files; grouping uses the canonical session ID.
- The dashboard calls the current distinct-ID metric **Usage groups** and explains that it is not a conversation count. The existing session filter still operates on the underlying recorded ID; no filter semantics or quota values changed.
- The read-only diagnostic script reports only aggregate counts. Tests use synthetic `ctco_`, function-output, and message IDs; they cover cumulative deltas, restart behavior, duplicate copies, and the JSON-to-SQLite handoff.

This is an intentionally conservative repair. Historical rows attributed to item IDs remain stored and their totals remain unchanged. On a live extension, new events after the fix use the verified session metadata where available. A future historical repair must first back up storage, prove an event-to-thread mapping from surviving source material or explicit provenance, update SQLite and fallback consistently, and validate totals and fingerprints before and after. An archived generation without evidence must remain `unknown`.

## Open risks and hypotheses

| Item | Status | Reason |
| --- | --- | --- |
| Repeated event rows in SQLite | Not observed in the 329 snapshot | Zero duplicate non-null fingerprints; this does not rule out semantically overlapping archived generations. |
| Archived-generation overlap | Unresolved | Earlier JSONL bytes are absent; current and archived rows may be distinct observations or may overlap after replacement. Do not subtract either set from totals based on equal values or proximity. |
| `token_usage_record` vs `token_count` | Different observed representations | This collector uses only `token_count` cumulative totals. The per-response record must not be added on top without a protocol-specific reconciliation. |
| Subagents and parent-child links | Not established | Neither an item ID prefix nor a one-event row proves auxiliary execution. |
| Full historical session repair | Pending | Current storage lacks a trustworthy parent ID on every archived event. |

## Product model for a later version

Persist provenance separately from a displayed grouping, for example `{recordId, sourceFile, eventKind, threadId?, parentThreadId?, classification: 'main'|'auxiliary'|'technical'|'unknown', evidence: 'session_meta'|'explicit_parent'|'item_id'|'none'}`. Only explicit metadata should establish a main or auxiliary thread. Keep the raw observed event and its accounting fingerprint stable. Show verified conversation counts separately from technical/unknown records, and offer a classification filter only once it can be computed reliably. The v0.4.2 premium hover's current session count needs the same terminology change after this independent branch is integrated; this audit does not modify PR #4.

## Verification and privacy

The diagnostic script opens SQLite read-only and streams JSONL, emitting aggregate metadata and counters only. Tests and migration checks use synthetic files in temporary directories. No real account, authentication file, prompt, response, or session identifier was copied into the repository. Results from a currently running Codex process may change between reads.
