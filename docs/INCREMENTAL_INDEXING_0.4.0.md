# Incremental JSONL indexing

Codex Insights v0.4.0 imports appended JSONL bytes instead of rereading an unchanged file. The importer serializes scans, so filesystem refreshes and interval refreshes cannot import the same source concurrently. It accepts only complete newline-terminated records, limits a line to 1 MiB, and treats malformed input as an ingestion warning.

Each source checkpoint is stored in import_state migration 5. The checkpoint and its newly inserted token_events share an explicit SQLite transaction. If persistence fails, the in-memory checkpoint is not adopted; the next scan safely retries the same bytes. The JSON fallback is written atomically after a successful batch.

The importer retains historical observations if a source is truncated or replaced. It never assumes an inode is portable: where Node cannot provide a reliable identity, it compares a lightweight prefix signature and reconciles idempotently when uncertain. This preserves existing history and prioritizes avoiding duplicate token deltas.
