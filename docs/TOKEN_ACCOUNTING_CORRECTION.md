# Cumulative token accounting and historical reconciliation

## Confirmed defect and source semantics

The old collector treated the first `info.total_token_usage` in every JSONL file as a new delta. Codex defines `total_token_usage` as the cumulative thread snapshot and `last_token_usage` as the increment that produced it. A continuation can therefore begin at an inherited total. For example, a parent ending at 150 and a continuation reporting 150, then 170, must contribute 0 then 20, producing 170 overall, not 320. Cached input remains part of input; reasoning output remains part of output.

This interpretation is supported by [Codex's token accounting documentation in the OpenAI Symphony repository](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md). The local collector parses only `event_msg` / `token_count`; a generic `turn.completed.usage` is not another cumulative observation.

For `event_msg/token_count`, the parser now reads the typed `info.total_token_usage` (or typed payload fallback) before considering any other usage fields. A generic top-level `usage` is not accepted as this event's cumulative total. `last_token_usage` remains a separate recent increment; it is never added on top of the same cumulative difference. A fixture with contradictory generic and typed values protects this precedence.

## New observation ledger (SQLite migration 6)

`counter_observations` records a hash of canonical session ID, source timestamp, cumulative tuple and last-usage tuple, as well as file provenance and a decision: `counted`, `duplicate`, `inherited`, or `ambiguous`. The ledger contains counter metadata only; it stores no prompts or responses. Events, observations and byte checkpoints commit in one SQLite transaction. The JSON fallback writes the corresponding arrays and checkpoints by atomic rename.

Within one chronological file, a monotonic cumulative counter contributes its componentwise difference. A later genuine decrease is treated as a reset by the existing parser. Across files, an exact observation key is a duplicate. An explicit `forked_from_id` or `parent_thread_id` **plus the same counter and source timestamp** establishes a copied parent observation. Matching parent counters with a different timestamp are marked ambiguous. Different child IDs retain their independent subsequent increments: parent 150, left 150→170, right 150→180 yields 150+20+30=200; if the baseline timestamps differ, the two baselines remain flagged for review. An equal baseline in the same canonical thread at a different timestamp is likewise **ambiguous**; the observation is retained, zero is inferred for that baseline, and a warning is shown. For a new file in an existing thread, `last_token_usage` can establish its newest increment if the tuple is valid. Missing or contradictory evidence is recorded as ambiguous. Numeric equality alone is never used to prove that two different thread IDs are the same call.

The repeated-counter check applies to *every* observation in a rewritten source, not just its first baseline. Thus a second file reporting the same canonical sequence 100→150 with changed timestamps and item IDs does not add another 50. If it subsequently reaches 170, only the new 20 is added. This source-aware check does not impose a global maximum: distinct explicit child identities can still contribute independently. An indistinguishable same-ID branch is retained as ambiguous and is not claimed as a verified duplicate or verified new spend.

The first scan after upgrading seeds continuity from v0.4.1 file checkpoints when their canonical session metadata and prior cumulative totals are available. Legacy event amounts and fingerprints are not rewritten. The dashboard receives a warning that unreconciled history may be inflated. Checkpoint seeding cannot reconstruct an older fork point that is absent from the available files.

When no prior file survives and the first cumulative total exceeds `last_token_usage`, only the last increment is counted and the unresolved baseline is marked ambiguous. The same warning applies when `total_token_usage - last_token_usage` cannot be matched to a prior observation in that thread or its explicit parent. This is a conservative lower bound for new observations, not a verified lifetime total. Changed files are ordered by their first new `token_count` timestamp, independently of filename; preflight reads are included in byte metrics and reused when they contain the whole new range. If timestamps are missing, file creation time is only a fallback and the result remains uncertain.

## Dry-run

Run `npm run audit:tokens -- --sessions <directory> [--baseline-db <database>]`. The script indexes supplied JSONL into a disposable temporary directory and opens an optional existing SQLite database **read-only**. It outputs only counts, totals, decisions and sanitized warnings. It does not output session IDs, paths, prompts or responses. `proposedFromAvailableFiles` covers only supplied files; archived or missing generations prevent a whole-history comparison. An ambiguous observation must be reviewed, never silently treated as a proven duplicate.

Synthetic dry-run example: two files with parent counters 100→150 and a continuation 150→170 returned 170 input, 143 cached, 17 output and 6 reasoning, with one ambiguous inherited baseline and zero source writes. Independent per-file accounting yielded 320 input, 268 cached, 32 output and 11 reasoning, so the difference was 150, 125, 15 and 5 respectively. These are fixture numbers, not personal data; the ambiguous baseline requires review before any historical adjustment.

## Historical repair gate

`--repair` is deliberately locked in this PR. Existing v0.4.1 rows lack the observation provenance required to prove every suspected duplicate; enabling automatic repair would risk discarding legitimate fork consumption. A future reviewed repair plan must:

1. Inventory all active and archived source generations and map each stored event to its original `token_count` record; classify unmatched rows as uncertain.
2. Produce an anonymous dry-run diff for input, cached input, output and reasoning, with explicit proof for every adjusted row. Similar counts or nearby timestamps alone are insufficient.
3. Create and verify a consistent SQLite backup (`VACUUM INTO` or the SQLite backup API) and a separate copy of the JSON fallback. Record SHA-256 checksums before modifying either.
4. Apply an approved, immutable per-event plan in one SQLite transaction, preserving original values and proof in a repair ledger. The JSON variant must write to a temporary file, fsync, then rename; preserve its original backup. Retrying the same plan ID must be a no-op.
5. Reopen and verify row counts, fingerprints, checkpoints, four token totals, `PRAGMA integrity_check`, and a restart/import. Restore from the verified backup if any check fails.

No repair is run at extension activation. User approval is required before running any repair on personal storage. The aggregate values are intentionally unchanged for legacy rows in this PR.

## Residual risks

- A missing source generation cannot be reconciled from aggregate rows alone.
- Two distinct branches with the same canonical ID and indistinguishable counters cannot be resolved without explicit lineage. Their baselines remain ambiguous.
- New observations add storage and CPU cost. The benchmark comparison is reported in the PR; integrity takes precedence over an arbitrary time target.
- The current dashboard displays a general ingestion warning. A dedicated per-metric quality badge could be added after the repair workflow is reviewed.

## Performance comparison

One synthetic run per variant on Linux x64, Node 26.2.0, Intel i7-12650H, 16 logical CPUs, 15.3 GiB RAM. Dataset: 1,000 sessions, 100,000 usage events, 23,664,079 source bytes. The baseline is `origin/main` at `12b0a59`. Times vary with filesystem cache and machine load.

| Operation | Baseline | Correction |
| --- | ---: | ---: |
| First import | 2,595.89 ms | 4,735.51 ms |
| Unchanged refresh | 139.77 ms | 223.81 ms |
| Appended-event refresh | 245.74 ms | 433.22 ms |
| Appended-event bytes read | 23,689 | 23,689 |
| Dashboard query | 80.22 ms | 77.55 ms |
| End-of-scenario process RSS | 363.66 MiB | 482.84 MiB |

The first import includes an extra bounded preflight read to order new rollouts by their first token observation; that read is included in the metric (27,736,390 bytes on the correction run). Normal appended-event reads remain incremental. The observation ledger increases storage and startup cost. Further indexing of ledger lookups and targeted database reads should be considered after correctness review.

After the rewritten-sequence correction, another single 100,000-event run on the same machine measured 5,143.56 ms first import, 268.23 ms unchanged refresh, 504.35 ms appended refresh (23,689 bytes read), 897.92 ms standalone persistence, 83.30 ms dashboard query and 562.77 MiB end RSS. The differing times and memory reflect separate runs with different cache/GC conditions; they are not an isolated causal measurement of the additional lookup.

## Interpreting memory measurements

The integration benchmark reported about 610 MiB RSS at 100,000 events and 1.41 GiB at 200,000 events. These are **whole Node benchmark-process** readings, not the extension's incremental memory cost and not measured peaks. That process retains all JSONL strings in `reading.value`, one parsed event array in `processing.value`, a second set of event objects in the benchmark's `cache`, aggregate arrays/maps, and the `SessionIndex`'s event and observation arrays. Its lookup keeps hashed keys, cumulative tuple strings and source sets. SQLite native memory, the esbuild-loaded runtime, the V8 heap, temporary buffers and memory awaiting garbage collection also contribute. The benchmark executes scenarios sequentially in one process, so prior allocations can affect later RSS readings. The 200,000-event run used the integration branch's extended benchmark; the PR #6 script itself currently stops at 100,000 events.

For a later version, run each size in a fresh process with fixed Node/OS/hardware, record RSS, `heapUsed`, `external` and `arrayBuffers` after fixture creation, read, parse, aggregate, persistence, import and close, and optionally force GC between phases with `--expose-gc`. Repeat several times and report median and spread. Run a separate isolated VS Code Extension Host measurement to estimate product memory rather than treating benchmark RSS as that estimate. No optimization or CI memory threshold is introduced here.
