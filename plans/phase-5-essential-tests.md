# Phase 5: Essential Tests — Implementation Plan

**Goal:** Prove the architecture works end-to-end. These are NOT exhaustive test suites — they're targeted confidence tests that exercise the real system under realistic conditions: full pipeline E2E, power loss recovery, sustained operation, and buffer overflow handling.

**Estimated Duration:** 0.5–1 week
**PRD References:** §8 (Pipeline Lifecycle), §12 (Buffers & Delivery Guarantees), §14 (Error Handling & Resilience), §15 (Observability), §22 (MVP Acceptance Criteria — Scenarios 1–3)

---

## What Phase 5 Delivers

| Test Suite | Validates | Maps to MVP Acceptance Criteria |
|---|---|---|
| Full pipeline E2E | Config → startup → data flow → all stages → shutdown | Scenario 1 (basic data collection), Scenario 5 (first-run setup) |
| Power loss recovery | SIGKILL during writes → restart → ≤1s data loss, zero corruption | Scenario 2 (persistence survives power loss) |
| Sustained operation | 60-second run, memory check, zero data gaps, no errors | Scenario 3 (24-hour standalone — compressed) |
| Buffer overflow handling | Buffer limits enforced, overflow policy works, no data corruption | §12 overflow policies |
| Error resilience | Plugin errors don't crash pipeline, backoff on write failures | §14 error handling |

---

## What Phase 5 Does NOT Do

- **No CLI.** That's Phase 6.
- **No Sparkplug B.** That's Phase 7.
- **No Web UI.** That's Phase 9.
- **No 24-hour soak test.** We compress the 24h scenario into a 60s sustained-operation test with the same assertions scaled down. A real 24h soak is a manual QA gate, not an automated test.
- **No real OPC-UA/Modbus hardware.** Tests use mock or in-process servers.

---

## Module Dependency Order

```
5.0  Full pipeline E2E with real plugins     ← proves all 4 stages work together
5.1  SQLite recovery & power loss simulation  ← SIGKILL → restart → verify data
5.2  Sustained operation (compressed soak)    ← 60s continuous run, check memory + gaps
5.3  Buffer overflow & backpressure           ← limits, drop_oldest, write failures
5.4  Error resilience                         ← plugin errors, output failures, backoff
```

**Build order rationale:**
- E2E first — it's the foundation. If the pipeline doesn't work end-to-end with real plugins, nothing else matters.
- Power loss next — validates the most critical correctness property (data survives crashes).
- Sustained operation after power loss — now we know recovery works, test that it stays stable.
- Buffer overflow and error resilience last — edge cases that build on the working pipeline.

---

## 5.0 Full Pipeline E2E with Real Plugins

**PRD refs:** §4, §7, §8, §22 Scenarios 1 & 5
**Test file:** `test/e2e/full-pipeline.test.ts`

### What it proves

The existing `pipeline-e2e.test.ts` uses mock plugins (hand-rolled `ConfigDrivenInput`, `RenameProcessor`, `MockStoreOutput`). Phase 5 replaces mocks with the **real plugins built in Phases 2–4** to prove they actually work together.

### Test scenarios

**5.0.1 — Full four-stage pipeline with real plugins**

Config (TOML or programmatic):
- Input: `internal` metrics (self-metrics — always available, no external dependencies)
- Processor: `filter` (namepass: only `agent.*` metrics)
- Aggregator: `basicstats` (period: 200ms, stats: count/mean)
- Output: `local-store` (temp directory, daily rotation)

Assertions:
- Pipeline starts without errors
- Internal metrics flow through filter (non-matching names dropped)
- Aggregator produces summaries every 200ms
- Local store has rows in SQLite after ~1s of running
- Graceful shutdown: all plugins get close(), local store WAL checkpointed
- Query local store: rows exist, timestamps are valid BigInt, fields are decodable

**5.0.2 — Multi-input pipeline: polling + service input**

Config:
- Input 1: polling `internal` (interval: 100ms)
- Input 2: service input — use the `mqtt-consumer` with a local MQTT broker mock (OR write a minimal `TestServiceInput` that pushes metrics on a timer)
- Output: `stdout` (capture output) + `file` (JSON-lines, temp file)

Assertions:
- Both inputs produce metrics
- Output file contains metrics from BOTH inputs (check metric names)
- Metric count: inputs produced N, output received N (no loss)

**5.0.3 — Processor chain: rename → filter → aggregator → output**

Config:
- Input: simple polling input emitting `sensor_temperature` and `sensor_humidity`
- Processor 1: `rename` (field: `temp_c` → `temperature_celsius`)
- Processor 2: `filter` (namepass: `sensor_temperature` only)
- Aggregator: `basicstats` (period: 200ms)
- Output: `local-store` (temp dir)

Assertions:
- Rename applied before filter (field renamed in output)
- Filter dropped `sensor_humidity` (not in local store)
- Aggregator summaries exist with `_count`, `_mean` field suffixes
- Only `sensor_temperature` metrics in local store

**5.0.4 — Shutdown ordering verification**

Use the pipeline from 5.0.1. Instrument plugin close/stop calls with timestamps.

Assertions (PRD §8 shutdown sequence):
- Service inputs stop before input channel closes
- Aggregators push final summary before output channels close
- Outputs receive final flush before close()
- All close() calls complete (no hanging)
- Total shutdown time < 5 seconds

### Implementation notes

- Use `import { InternalInput } from "@plugins/inputs/internal"` — the real plugin
- Use `import { FilterProcessor } from "@plugins/processors/filter"` — the real plugin
- Use `import { BasicstatsAggregator } from "@plugins/aggregators/basicstats"` — the real plugin
- Use `import { LocalStore } from "@plugins/outputs/local-store"` — the real plugin
- Use `import { StdoutOutput } from "@plugins/outputs/stdout"` — the real plugin
- Use `import { FileOutput } from "@plugins/outputs/file"` — the real plugin
- Use `import { RenameProcessor } from "@plugins/processors/rename"` — the real plugin
- Temp dirs: use `import { mkdtempSync } from "node:fs"` + cleanup in `afterEach`
- SQLite assertions: open the daily file directly with `bun:sqlite` and query

---

## 5.1 SQLite Recovery & Power Loss Simulation

**PRD refs:** §8 (SQLite Recovery on Startup), §11 (Local Data Store), §12 (Buffers & Delivery Guarantees)
**Test file:** `test/e2e/power-loss-recovery.test.ts`

### What it proves

MVP Acceptance Criteria Scenario 2: "data loss is ≤1 second, the local store has zero corruption, and collection resumes automatically."

We can't literally SIGKILL the test process (it wouldn't resume). Instead, we simulate power loss by:
1. Running a pipeline that writes to local store + S&F buffer
2. **Abruptly closing the SQLite databases WITHOUT checkpointing** (simulates crash — WAL file left behind)
3. Re-opening the databases and running recovery (WAL checkpoint)
4. Verifying data integrity

### Test scenarios

**5.1.1 — Local store: WAL recovery after simulated crash**

1. Create a `LocalStore` output pointed at a temp dir
2. Write 1000 metrics in batches of 100
3. After the last batch, do NOT call `close()` — instead, forcibly discard the `Database` object (let GC handle it, or call `db.close()` without WAL checkpoint)
4. Re-open the same database file
5. Run `PRAGMA wal_checkpoint(TRUNCATE)` (the recovery step from PRD §8)
6. Count rows: should be 1000 (all data recovered)
7. Run `PRAGMA integrity_check` — should return "ok"

**5.1.2 — Store-and-forward buffer: recovery after simulated crash**

1. Create a `StoreForwardBuffer`, open it
2. Add 500 metrics
3. Begin a transaction (read 100 oldest)
4. Do NOT call acceptAll/keepAll — crash simulation (transaction uncommitted)
5. Close the DB without final checkpoint
6. Re-open buffer
7. `length` should be 500 (all metrics survived — unacknowledged transaction means all still buffered)
8. Begin new transaction: first 100 should be the same metrics (at-least-once)

**5.1.3 — Data loss bound: ≤1 second with synchronous=NORMAL**

1. Create local store with `synchronous=NORMAL` (default)
2. Write metric batches every 100ms for 5 seconds (50 batches)
3. After each write, record the batch number
4. Forcibly close without checkpoint (crash)
5. Re-open with recovery
6. Count recovered batches
7. At most 1 second of data should be missing (≤10 batches at 100ms interval)

**Note:** This test is probabilistic (depends on OS fsync timing). We can't guarantee EXACTLY which batches survive with synchronous=NORMAL. The assertion should be: `recovered >= total - (1000 / intervalMs)` batches, with some tolerance. If this proves flaky, document it as "validated manually" and skip in CI.

**5.1.4 — Integrity check on corrupted database**

1. Create a local store, write some data, close properly
2. Corrupt the database file (write random bytes at a known offset)
3. Try to re-open — the PRD §8 says: "Move corrupt file aside, create fresh"
4. Verify: corrupt file renamed to `*.corrupt.<timestamp>`, fresh DB created
5. Verify: fresh DB is usable (can write/read)

**Note:** This requires implementing the corruption-detection path in local-store's open/connect. If that path doesn't exist yet, this test should be written as a failing test with a TODO, and the detection path should be added. Check the current code first.

### Implementation notes

- SQLite WAL behaviour: after `db.close()` without explicit checkpoint, the WAL file persists. On re-open, SQLite automatically replays the WAL. We're testing that this actually works with `bun:sqlite`.
- For the forced-crash simulation, we can call `db.close()` directly (bypasses the plugin's clean shutdown) — this is sufficient to test WAL recovery.
- The 1-second bound test relies on SQLite's `synchronous=NORMAL` behaviour: WAL pages are flushed at checkpoint, and between checkpoints, at most ~1s of data can be lost.

---

## 5.2 Sustained Operation (Compressed Soak Test)

**PRD refs:** §22 Scenario 3 (24-hour standalone operation, compressed to 60s)
**Test file:** `test/e2e/sustained-operation.test.ts`

### What it proves

The system runs continuously without memory leaks, data gaps, errors, or crashes. The 24-hour acceptance scenario is compressed to 60 seconds with proportionally tighter thresholds.

### Test scenarios

**5.2.1 — Continuous operation: 60 seconds, zero gaps**

Config:
- Input: polling input emitting metrics with sequential counter (1, 2, 3, ...)
- Interval: 50ms (produces ~1200 metrics in 60s)
- Processor: `filter` (namepass all — passthrough)
- Aggregator: `basicstats` (period: 5s)
- Output: `local-store` (temp dir)

Run for 60 seconds.

Assertions:
- Zero errors logged (capture stderr)
- Local store row count ≥ expected * 0.95 (allow 5% for timing jitter, no systematic loss)
- Timestamps are monotonically non-decreasing
- No duplicate metrics (same timestamp + name + tags + fields)
- Aggregator produced ~12 summary pushes (60s / 5s)
- All summary stats are valid (no NaN, no Infinity)

**5.2.2 — Memory stability**

Same config as 5.2.1. Measure RSS at t=5s and t=55s.

Assertion:
- RSS at t=55s ≤ RSS at t=5s * 1.5 (allow 50% growth for GC timing, but no unbounded leak)
- **Note:** Bun's `process.memoryUsage().rss` should work. If it doesn't, use `Bun.nanoseconds()` as a proxy for "process is still responsive" and skip RSS measurement.

**5.2.3 — Local store daily rotation (time-warp)**

This tests the daily file rotation without waiting 24 hours. We can't easily mock `Date.now()` in a running pipeline, so instead:
1. Create local store with a temp dir
2. Write metrics with timestamps spanning 3 different UTC days (manually constructed BigInt timestamps)
3. Verify: 3 daily files created (`data_YYYY_MM_DD.db`)
4. Verify: each file contains only metrics for its day
5. Verify: retention policy (if days=2) deletes the oldest file

### Implementation notes

- The sequential counter input is a test helper — don't build a full plugin. A simple class implementing `Input` that increments a counter field each gather.
- For memory measurement: `process.memoryUsage().rss` returns bytes. Take snapshots at intervals.
- For capturing stderr: redirect via Bun's test infrastructure or capture `console.error` calls.
- 60 seconds is long for a test. Mark with a comment: `// Long-running test (~60s)`
- The daily rotation test (5.2.3) is a unit/integration test of LocalStore, not a full pipeline test. It belongs in this phase because it validates a key operational scenario.

---

## 5.3 Buffer Overflow & Backpressure

**PRD refs:** §12 (Buffers & Delivery Guarantees — overflow policies, sizing)
**Test file:** `test/e2e/buffer-overflow.test.ts`

### What it proves

Buffer limits are enforced. The `drop_oldest` overflow policy works correctly. Write failures trigger retry. The buffer doesn't grow unbounded.

### Test scenarios

**5.3.1 — drop_oldest overflow: buffer limit enforced**

1. Create `StoreForwardBuffer` with `metric_buffer_limit = 100`
2. Add 200 metrics
3. `length` should be 100 (oldest 100 dropped)
4. Begin transaction: metrics should be the NEWEST 100 (check timestamps)

**5.3.2 — Buffer with failing output: metrics accumulate then drain**

Full pipeline:
- Input: polling at 50ms
- Output: a mock output that **fails write() for the first 5 attempts**, then succeeds
- Buffer: `metric_buffer_limit = 500`, `metric_batch_size = 50`

Run for 2 seconds.

Assertions:
- First 5 write attempts failed (output error count = 5)
- After 5 failures, output starts receiving batches
- No metrics lost (all eventually delivered — at-least-once)
- Buffer drains after output recovers

**Note:** This requires wiring the `StoreForwardBuffer` into the `PipelineRuntime`'s output flush loop. Currently the runtime does NOT use the S&F buffer — it writes directly to output plugins. This integration is a **new piece of work** for Phase 5.

**Assessment:** If integrating S&F buffer into the runtime is too large for Phase 5 (it touches the core flush loop), then this test should validate the buffer in isolation (which is already done in Phase 3 unit tests) and document the runtime integration as a Phase 6/7 prerequisite. **Check the runtime code and make a call.**

**If the runtime already supports buffered output** (it doesn't — I checked), write the full pipeline test. **If not**, write:
- 5.3.2a: Buffer isolation test (add metrics → fail transaction → keep → retry → succeed)
- 5.3.2b: Document TODO for runtime/buffer integration

**5.3.3 — Buffer transaction: partial write handling**

1. Create buffer, add 100 metrics
2. Begin transaction (batch=50)
3. Simulate partial write: accept indices [0-29], reject indices [30-39], keep rest [40-49]
4. Buffer length should be 100 - 30 (accepted) - 10 (rejected) = 60
5. Next transaction: first 10 metrics are the "kept" ones from previous batch (indices 40-49)

**5.3.4 — Buffer recovery: unacknowledged transaction survives restart**

1. Add 100 metrics, begin transaction (50), call acceptAll (50 removed)
2. Add 50 more, begin transaction (50), do NOT resolve (crash simulation)
3. Close and re-open buffer
4. Length should be 100 (50 remaining + 50 from unresolved tx + 50 new — the unresolved tx's metrics are still there)

Wait — let me re-think. After acceptAll on the first 50, length = 50. Then add 50 more = length 100. Begin transaction on 50 but don't resolve. Close. Re-open. The 50 that were in the unresolved tx are NOT deleted (no acceptAll was called). So length = 100. Correct.

---

## 5.4 Error Resilience

**PRD refs:** §14 (Error Handling & Resilience)
**Test file:** `test/e2e/error-resilience.test.ts`

### What it proves

Plugin errors are isolated. One broken plugin doesn't crash the pipeline. Output write failures trigger retry, not data loss. Gather timeouts are handled gracefully.

### Test scenarios

**5.4.1 — Input gather error: pipeline continues**

Config:
- Input 1: healthy polling input (emits metrics every 50ms)
- Input 2: `FailingInput` — throws on every gather()
- Output: mock collector

Run for 500ms.

Assertions:
- Pipeline did NOT crash
- Output received metrics from Input 1
- Errors from Input 2 were logged (captured)
- Input 1's metric count is unaffected by Input 2's failures

**5.4.2 — Processor error: metric is dropped, pipeline continues**

Config:
- Input: emits metrics with alternating names (`good_metric`, `bad_metric`)
- Processor: throws on `bad_metric`, passes `good_metric` through
- Output: mock collector

Run for 500ms.

Assertions:
- Output received only `good_metric` metrics
- `bad_metric` errors were logged
- Pipeline did not crash
- Metric count in output ≈ half of input count (bad ones dropped)

**5.4.3 — Output write failure: retry behaviour**

Config:
- Input: polling at 50ms
- Output: mock that fails on first 3 calls, then succeeds

Run for 1 second.

Assertions:
- Output eventually received metrics (after recovery)
- Early metrics were retried (not lost)
- Pipeline did not crash

**Note:** This test depends on how the runtime handles write failures. Currently `runOutputFlushLoop` catches write errors and re-adds metrics to the batch buffer. This IS existing behaviour — test it.

**5.4.4 — Gather timeout: slow input doesn't block pipeline**

Config:
- Input 1: normal polling (50ms interval)
- Input 2: `SlowInput` — gather takes 5 seconds (simulates hung PLC)
- Gather timeout: 200ms
- Output: mock collector

Run for 1 second.

Assertions:
- Output received metrics from Input 1
- Input 2's slow gathers were killed by timeout
- Timeout errors logged
- Pipeline stayed responsive (Input 1 metrics have regular timestamps)

---

## Acceptance Criteria for Phase 5

Phase 5 is complete when:

1. **All E2E tests pass** — full pipeline with real plugins, power loss, sustained operation, buffer overflow, error resilience
2. **All existing tests still pass** — zero regressions (currently 426 tests)
3. **No new `// TODO` items without issue references** — any deferred work is documented in the plan
4. **Test count:** ≥ 15 new E2E tests across the 5 test files
5. **Long test suite runs in < 120 seconds** — the 60s soak test dominates; everything else should be fast

---

## Risks

| Risk | Mitigation |
|---|---|
| 60s soak test is flaky in CI | Use generous thresholds (95% metric count, 1.5x RSS). Mark as `// Long-running` |
| Power loss test is non-deterministic (sync=NORMAL) | Test the WAL recovery path deterministically; the 1-second bound test is advisory |
| S&F buffer not wired into runtime | Test buffer in isolation (already done in Phase 3); document integration as prerequisite for Phase 7 |
| Memory measurement varies by platform/GC | Use relative growth ratio, not absolute values. Skip RSS check if `process.memoryUsage()` is unreliable |
| Real plugin imports pull heavy deps (node-opcua) | E2E tests use `internal` input (lightweight) + local-store. OPC-UA and Modbus are tested in their own integration tests |

---

## Phase 4 Cleanup (Pre-Phase-5)

Before starting Phase 5 implementation, address these minor items from the Phase 4 review:

1. **🟡 R4:** Add comment to `BasicstatsAggregator` explaining that `period` is parsed by the config layer, not the aggregator (~1 line)
2. **🟡 F1:** Update Phase 4 plan doc re: summary metric naming convention (plan says `{name}_basicstats`, code uses `{name}` with field-suffixed stats — code is correct, plan needs update)
3. **🟡 F4:** Add comment in `runtime.ts` documenting the potential double-push at shutdown as known behaviour (~3 lines)

These are 5-minute fixes. Do them first, commit as `phase-4: address review findings (R4, F1, F4)`, then start Phase 5.
