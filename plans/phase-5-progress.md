# Phase 5 Progress

## Status: IN PROGRESS

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 5.pre | Phase 4 review cleanup (R4, F1, F4) | ✅ (already done in prior session, commit b12e712) |
| 5.0 | Full pipeline E2E with real plugins | ✅ |
| 5.1 | SQLite recovery & power loss simulation | ⬜ |
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

**Test helpers created (local to test file):**
- `DualSensorInput` — emits two metric types (sensor_temperature, sensor_humidity)
- `TestServiceInput` — ServiceInput that pushes on a timer
- `SimplePollingInput` — emits a single metric type with incrementing counter
- `CollectorOutput` — captures written metrics
- `InstrumentedOutput` — records close timestamp
- `queryDailyDb()` — opens SQLite daily file directly for assertions

**Decisions:**
- Used test-local helper classes rather than shared test utilities (per YAGNI — extract to shared when needed by 5.1+)
- Queried SQLite directly after pipeline.stop() rather than using LocalStoreOutput.query() (the store's DBs are closed after shutdown, and direct query proves data actually persisted)
- Used 100ms gather/flush intervals and 200ms aggregator period for fast tests (~1-3s each)
- Aggregator summaries confirmed to bypass the processor chain (emitted directly to output broadcaster, not re-processed) — this matches PRD §4 architecture

**Test count:** 430 pass, 0 fail (426 existing + 4 new)
