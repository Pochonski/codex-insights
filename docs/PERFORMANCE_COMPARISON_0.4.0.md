# Performance comparison: v0.4.0

The v0.4.0 collector stores a checkpoint for every JSONL source: byte offset, observed size and modification time, optional platform file identity, lightweight generation signature, parser state, parser version, and read timestamp. A checkpoint advances only through a newline. The event rows and the SQLite checkpoint commit in the same transaction.

The benchmark uses synthetic JSONL records only. It ran once on Linux x64, Node v26.2.0, Intel i7-12650H, 16 logical CPUs, and 15.3 GiB RAM on 2026-10-15. Run npm run benchmark to reproduce; timings are informational and are not CI limits.

| Sessions / events | Dataset | First import | Unchanged update | Changed update | Changed bytes read | Dashboard query |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 / 1,000 | 234,725 B | 19.61 ms | 1.75 ms | 2.80 ms | 235 B | 2.73 ms |
| 100 / 10,000 | 2,356,399 B | 198.04 ms | 16.43 ms | 23.72 ms | 2,359 B | 11.06 ms |
| 500 / 50,000 | 11,826,479 B | 1,289.69 ms | 80.55 ms | 139.54 ms | 11,839 B | 53.64 ms |
| 1,000 / 100,000 | 23,664,079 B | 2,531.10 ms | 150.18 ms | 256.78 ms | 23,689 B | 123.18 ms |

The v0.3.1 comparable reference read the full 23.66 MB dataset during a changed refresh and took 341.85 ms. v0.4.0 read 23,689 B for the append workload, about 99.9% fewer bytes. Its changed refresh was 256.78 ms on this run; it did not reach the aspirational 100 ms target because discovery and in-memory historical aggregation still visit the known source set. Indexing remains correctness-first.

## Semantics and recovery

- Offsets are UTF-8 byte offsets. A partial final JSON line remains unconfirmed and is read again with its completed suffix.
- A smaller file, changed identity, parser-version change, or same-size modification triggers a safe full reconciliation. Existing unmatched observations move to an archived generation instead of being deleted.
- POSIX dev:ino is used when available. On platforms without a reliable inode, a prefix signature is checked before treating a file as a continuation. A copied or moved file is deduplicated by the stable event fingerprint.
- JSON fallback writes use a temporary file and rename. SQLite keeps the previous database if opening or migration fails; no database is automatically recreated.

The remaining v0.4.0 work for a later performance pass is batching SQLite file updates into a single bounded transaction and introducing indexed aggregate queries for very large historical dashboards.
