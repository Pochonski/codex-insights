# Performance baseline — Codex Insights 0.3.1

Measured on 2026-10-15 with synthetic data. These figures are observations, not CI pass/fail thresholds.

## Environment and method

- Node.js v26.2.0, Linux x64
- Intel Core i7-12650H, 16 logical CPUs, 15.3 GiB RAM
- 100 cumulative token observations per session
- Deterministic fictitious sessions, models, projects, and token counters
- One measured run after fixture generation; wall-clock time in milliseconds
- RSS values are approximate and include runtime reuse between scenarios

Run the benchmark with `npm run benchmark`. It creates all data under temporary directories and removes them afterward.

| Sessions | Events | Data | Discover | Read | Process | Deduplicate | Persist | First import | Unchanged refresh | Changed refresh | Dashboard query | Final RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1,000 | 0.22 MiB | 0.21 | 0.39 | 6.87 | 0.88 | 5.36 | 13.78 | 0.50 | 2.66 | 2.71 | 88.61 MiB |
| 100 | 10,000 | 2.25 MiB | 0.24 | 10.91 | 46.08 | 6.05 | 61.29 | 123.69 | 1.60 | 23.12 | 12.59 | 151.19 MiB |
| 500 | 50,000 | 11.28 MiB | 0.70 | 33.64 | 196.06 | 19.18 | 441.97 | 710.87 | 8.38 | 152.06 | 54.68 | 297.92 MiB |
| 1,000 | 100,000 | 22.57 MiB | 0.96 | 20.80 | 407.85 | 41.56 | 1,097.01 | 1,591.43 | 11.07 | 334.89 | 99.43 | 311.65 MiB |

“Changed refresh” appends one observation to every tenth session. It still reparses each changed file from the beginning. “Unchanged refresh” uses the persisted file metadata and avoids parsing unchanged files. “Dashboard query” includes aggregation and construction of the filtered analytics view.

## Interpretation and 0.4.0 targets

The unchanged path is inexpensive at 1,000 sessions. Initial import and persistence scale roughly with event count; changed refresh scales with the number and size of changed files. Peak memory and SQLite write time become the clearest optimization targets around 100,000 observations.

For 0.4.0, preserve the current mathematical semantics while adding byte-offset checkpoints, file identity/rotation metadata, and batched persistence. Compare future measurements with this exact generator. Targets on comparable hardware are: unchanged refresh below 50 ms at 1,000 sessions, changed refresh proportional to appended records, first import below the current 1.6-second baseline, and lower peak RSS through streaming rather than whole-file arrays.
