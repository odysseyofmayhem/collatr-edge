# Phase 5 Progress

## Status: IN PROGRESS

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 5.pre | Phase 4 review cleanup (R4, F1, F4) | ✅ (already done in prior session, commit b12e712) |
| 5.0 | Full pipeline E2E with real plugins | ✅ |
| 5.1 | SQLite recovery & power loss simulation | ✅ |
| 5.2 | Sustained operation (60s compressed soak) | ⬜ |
| 5.3 | Buffer overflow & backpressure | ⬜ |
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
