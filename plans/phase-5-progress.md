# Phase 5 Progress

## Status: IN PROGRESS

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 5.pre | Phase 4 review cleanup (R4, F1, F4) | ✅ (already done in prior session, commit b12e712) |
| 5.0 | Full pipeline E2E with real plugins | ✅ |
| 5.1 | SQLite recovery & power loss simulation | ✅ |
| 5.2 | Sustained operation (60s compressed soak) | ✅ |
| 5.3 | Buffer overflow & backpressure | ✅ |
| 5.4 | Error resilience | ⬜ |

## Notes

### Task 5.0 — Full pipeline E2E with real plugins

**File:** `test/e2e/full-pipeline.test.ts` (4 tests, 687 expect() calls)

**What was built:**
- Created `test/e2e/` directory
- 5.0.1: Full four-stage pipeline — InternalInput → FilterProcessor (namepass `agent.*`) → BasicstatsAggregator (200ms, count+mean) → LocalStoreOutput (temp dir). Verified metrics in SQLite: agent.* metrics present, timestamps valid BigInt, fields decodable, aggregator summaries have `_count`/`_mean` suffixes with valid numeric values.
- 5.0.2: Multi-input pipeline — SimplePollingInput (polling) + TestServiceInput (service, timer-based push) → FileOutput (JSON-lines). Verified both inputs produce metrics, output file contains both `polling_metric` and `service_metric` entries, service input stopped during shutdown.
- 5.0.3: Processor chain — DualSensorInput (`sensor_temperature` + `sensor_humidity`) → RenameProcessor (temp_c → temperature_celsius) → FilterProcessor (namepass `sensor_temperature`) → BasicstatsAggregator (200ms) → LocalStoreOutput. Verified: rename applied before filter (field is `temperature_celsius`), filter dropped `sensor_humidity` (zero rows), aggregator summaries have `temperature_celsius_count`/`temperature_celsius_mean`.
- 5.0.4: Shutdown ordering — instrumented plugins record event timestamps. Verified: service inputs stop before output close, aggregator push fires, input close called, output received data before close, total shutdown < 5s, both polling and service metrics in output.

**Test count:** 430 pass, 0 fail (426 existing + 4 new)

### Task 5.1 — SQLite recovery & power loss simulation

**Test file:** `test/e2e/power-loss-recovery.test.ts` (4 tests, 19 expect() calls)

**Production code change:** `src/plugins/outputs/local-store.ts`
- Added `integrity_check: z.boolean().default(false)` to `LocalStoreConfigSchema`
- Added `renameSync` to node:fs imports
- Implemented corruption detection path in `getOrOpenDb()` (PRD §8 step 6):
  - Wraps DB initialization in try/catch when `integrity_check` is enabled
  - Runs `PRAGMA integrity_check` after schema setup
  - On failure (either integrity check result or SQLiteError from corrupt file):
    closes DB, moves corrupt file + WAL/SHM to `*.corrupt.<timestamp>`, recurses to create fresh DB
  - Without `integrity_check`, errors propagate normally (no behavior change)

**What was built:**
- 5.1.1: WAL recovery — wrote 1000 metrics via real LocalStoreOutput, skipped close() (simulated crash), re-opened daily file directly, ran `PRAGMA wal_checkpoint(TRUNCATE)`, verified all 1000 rows recovered, integrity_check = "ok", fields decodable via msgpackr.
- 5.1.2: S&F buffer recovery — added 500 metrics, began transaction (100), did NOT resolve, closed buffer, re-opened. Verified length = 500 (all survived), next transaction returns same first 100 metrics (at-least-once guarantee).
- 5.1.3: Data loss bound — wrote 50 batches of 10 metrics over 5s with synchronous=NORMAL, skipped close(), re-opened with WAL checkpoint. Verified: at most 1s of data lost (≤100 metrics). In practice all 500 survived (WAL commits are on-disk even without fsync).
- 5.1.4: Corruption detection — wrote 100 metrics, closed cleanly, corrupted 256 bytes in the middle of the DB file, re-opened with `integrity_check: true`. Verified: SQLiteError caught, corrupt file moved to `*.corrupt.<timestamp>`, fresh DB created and usable (wrote + read 50 new metrics).

**Decisions:**
- Corruption detection wraps the entire DB open/init in try/catch (not just the integrity_check PRAGMA), because severe corruption causes SQLiteError during page reads even before the explicit check
- Used `integrity_check: false` as default to avoid performance overhead on normal startups (full table scan on every open would be slow for large daily files)
- Buffer recovery test uses normal close() (not crash simulation) — the key assertion is that unresolved transactions don't cause data loss, which holds regardless of shutdown type

**Test count:** 434 pass, 0 fail (430 existing + 4 new)

### Task 5.2 — Sustained operation (compressed soak test)

**Test file:** `test/e2e/sustained-operation.test.ts` (3 tests)

**What was built:**
- Created `SequentialCounterInput` test helper (implements Input, emits `soak_metric` with incrementing `counter` field each gather)
- 5.2.1: 60-second continuous run — SequentialCounterInput (50ms interval) → FilterProcessor (namepass `*`, passthrough) → BasicstatsAggregator (5s, count+mean) → LocalStoreOutput (temp dir). Verified: zero errors logged, ≥95% of expected 1200 raw metrics present, timestamps monotonically non-decreasing, no duplicate counter values, 8–20 aggregator summary pushes (expected ~12), all summary stats valid (finite numbers, no NaN).
- 5.2.2: Memory stability — same pipeline as 5.2.1, measured `process.memoryUsage().rss` at t=5s and t=55s. Verified: RSS growth ≤50% (no unbounded memory leak).
- 5.2.3: Daily rotation (time-warp) — wrote 50 metrics each to 3 UTC days (10 days ago, 1 day ago, today) via LocalStoreOutput. Verified: 3 daily files created (`data_YYYY_MM_DD.db`), each file contains exactly 50 metrics all with matching date, `timestampToDateString()` confirms correct partitioning. Re-opened with `retention_days: 5` — oldest file (10 days ago) evicted by `retentionByTime()`, 2 remaining files still have 50 rows each.

**Decisions:**
- Used `namepass: ["*"]` for the passthrough filter (matches all metric names) rather than omitting the processor, to exercise the full 4-stage pipeline
- 60s tests marked with `// Long-running test (~60s)` comments and given 90s timeout
- Memory test measures RSS after 5s warmup (GC, JIT settled) to avoid false positives from startup allocation
- Daily rotation uses generous day spacing (10 days ago vs 5-day retention) to avoid boundary timing issues near UTC midnight

**Test count:** 437 pass, 0 fail (434 existing + 3 new)

### Task 5.3 — Buffer overflow & backpressure

**Test file:** `test/e2e/buffer-overflow.test.ts` (4 tests, 193 expect() calls)

**What was built:**
- 5.3.1: drop_oldest overflow — created buffer with `metric_buffer_limit=100`, added 200 metrics, verified length=100, `beginTransaction(100)` returns the newest 100 (counters 101-200 in ascending id order).
- 5.3.2: Failing output isolation — added 100 metrics, ran 3 `beginTransaction(50)` + `keepAll()` cycles (simulating repeated write failures), verified same first 50 metrics returned each time (at-least-once). Then `acceptAll()` → length 50, next transaction returns remaining counters 51-100.
- 5.3.3: Partial write — added 100 metrics, `beginTransaction(50)`, accepted indices [0-29] (30 removed), rejected indices [30-39] (10 removed), kept [40-49] implicitly. Verified: length=60, next transaction returns 10 kept metrics (counters 41-50) followed by 40 untouched (counters 51-90). Drained remaining 10 (counters 91-100).
- 5.3.4: Unacknowledged transaction survives restart — added 100, accepted first 50, added 50 more (length=100), began transaction but didn't resolve, closed+reopened. Verified: length=100, all metrics recoverable in correct order (counters 51-100 then 101-150).

**Decisions:**
- S&F buffer is NOT wired into PipelineRuntime's output flush loop — tests validate buffer in isolation. Runtime/buffer integration documented as Phase 7 prerequisite.
- Test 5.3.2 follows plan guidance (isolation variant 5.3.2a) since runtime integration is too large for Phase 5.

**Test count:** 441 pass, 0 fail (437 existing + 4 new)
