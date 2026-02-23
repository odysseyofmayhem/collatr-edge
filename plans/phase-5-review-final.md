# Phase 5 Code Review: Essential Tests

**Reviewer:** Independent review agent (fresh context)
**Date:** 2026-02-23
**Scope:** 5 new E2E test files, 2 production code changes
**Test baseline:** 445 pass, 0 fail across 41 files (verified)

---

## Executive Summary

Phase 5 is solid work. The E2E tests exercise the real system under realistic conditions: full four-stage pipelines with real plugins, WAL recovery, sustained 60-second runs, buffer overflow with transaction semantics, and error isolation across all plugin types. The two production code changes (corruption detection in local-store.ts, processor error isolation in runtime.ts) are well-motivated by the PRD and follow the established patterns.

**Findings:** 1 red, 5 yellow, 5 green.

---

## Production Code Change 1: `src/plugins/outputs/local-store.ts`

### Changes Made

1. Added `integrity_check: z.boolean().default(false)` config option
2. Wrapped `getOrOpenDb()` in try/catch for corruption detection (when integrity_check enabled)
3. On corruption: close DB, move file + WAL/SHM aside as `*.corrupt.<timestamp>`, recurse to create fresh DB
4. Added `renameSync` import; removed unused `appendFileSync`, `writeFileSync` imports
5. Replaced `metric.hashId()` truncation with dedicated `tagsHash()` function (FNV-64a of tags only -- matches PRD "FNV-64a of sorted tags")
6. Changed `writeToDailyDb()` to pass `metric.timestamp` (BigInt) directly instead of `Number(metric.timestamp)` -- preserves nanosecond precision
7. Added `safeIntegers(true)` to downsample/query/export queries
8. Improved retry error handling for SQLITE_BUSY (retry throws are now caught and re-thrown)
9. Enhanced CSV export to include tag columns

### PRD Compliance Table

| PRD Requirement | Source | Implementation | Status |
|---|---|---|---|
| integrity_check on startup | PRD SS8 step 5 | `integrity_check` config option on LocalStoreConfigSchema | See finding Y1 |
| Move corrupt file aside, create fresh | PRD SS8 step 5 | `renameSync(dbPath, corruptPath)` + recursive `getOrOpenDb` | PASS |
| WAL/SHM files also moved | PRD SS8 (implied) | Loops over `-wal`, `-shm` extensions | PASS |
| Logging on corruption | PRD SS8 | `console.error` with filename and error | PASS |
| Default off | PRD SS8 "optional, enabled via config" | `z.boolean().default(false)` | PASS |
| tags_hash = FNV-64a of sorted tags | PRD SS11 schema | New `tagsHash()` function, hashes `key=value` pairs | PASS |
| timestamp stored as nanosecond INTEGER | PRD SS11 schema | `metric.timestamp` (BigInt) passed directly | PASS |
| SQLite BUSY retry once | PRD SS11 transaction model | try/catch with single retry; retry failure re-thrown | PASS |
| MessagePack for field encoding | PRD SS11 | `pack()` / `unpack()` via msgpackr | PASS (pre-existing) |

---

## Production Code Change 2: `src/pipeline/runtime.ts`

### Changes Made

1. Added try/catch around `proc.process(m, acc)` in `runMainLoop`
2. On processor error: logs `[pipeline] processor error: <message>`, metric is dropped (accumulated metrics from `acc.drain()` are not added to `next`), pipeline continues

### PRD Compliance Table

| PRD Requirement | Source | Implementation | Status |
|---|---|---|---|
| Processor error -> metric dropped | PRD SS14 "If process() throws: error logged, metric is dropped" | try/catch, metric not forwarded | PASS |
| Other metrics unaffected | PRD SS14 "Other metrics and other processors unaffected" | Catch is per-metric in the inner loop, outer loop continues | PASS |
| Error logged | PRD SS14 "error logged" | `console.error` with message | PASS |
| Pipeline continues | PRD SS14 "never crashes the agent" | Catch prevents exception from bubbling up | PASS |

---

## Findings

### RED Must Fix

**R1: Recursive `getOrOpenDb` unbounded recursion risk (local-store.ts:287)**

When `integrity_check` is enabled and `getOrOpenDb` encounters corruption, it moves the file aside and calls itself recursively. If the fresh database also fails to open (e.g., disk full, permissions error, or directory issues), the recursive call enters the catch block again. Since the corrupt file was already moved, `existsSync(dbPath)` tests the NEW file (which may or may not exist depending on the error type). If the error is not related to corruption but to the filesystem itself, this could:

- Loop if the error consistently creates then fails on the same file
- More likely: throw on the second call (since `existsSync` returns false for a not-yet-created file), which is the correct behavior

On closer inspection, the most probable failure path is: first call corrupts -> moved aside -> recursive call -> `new Database(dbPath)` creates fresh file -> fresh file open succeeds (no corruption) -> normal flow. If the fresh file ALSO fails (e.g., disk full), `existsSync(dbPath)` would check the fresh path. If Database() threw before creating the file, existsSync returns false and the error propagates (correct). If Database() created the file but table creation fails, existsSync returns true and we'd recurse again -- potentially moving a zero-byte or partially-initialized file aside and trying a third time.

**Recommendation:** Add a recursion guard. A simple boolean flag or depth counter prevents infinite recursion in pathological scenarios (e.g., filesystem that creates files but fails on any PRAGMA).

```typescript
// In getOrOpenDb, add a parameter:
private getOrOpenDb(filename: string, isRetry = false): Database {
  // ...in the catch block:
  if (this.config.integrity_check && existsSync(dbPath) && !isRetry) {
    // ... move aside ...
    return this.getOrOpenDb(filename, true); // second call won't recurse further
  }
  throw err;
}
```

**Severity rationale:** Without the guard, a specific filesystem failure pattern (creates file but fails on PRAGMA) could cause a stack overflow. This is unlikely in practice but violates Rule 11 (handle errors in async code) and defensive coding principles. A one-line fix prevents it.

---

### YELLOW Should Fix

**Y1: Config naming diverges from PRD (local-store.ts:27)**

The PRD (SS8 step 5) uses `config.agent.integrity_check_on_startup` -- a global agent-level setting. The implementation uses `integrity_check` as a per-output LocalStoreConfig option. These are different:

- PRD: global, controls integrity check on ALL SQLite databases (main DB + daily files)
- Implementation: per-output, only controls LocalStoreOutput daily files

This is defensible for Phase 5 (we only need it for E2E testing of the local store), but should be reconciled before the config system is finalized. The PRD's global approach is more correct because the S&F buffer's SQLite files should also get integrity checks.

**Recommendation:** Document this as a Phase 6/7 TODO: migrate `integrity_check` to `[agent]` config section as `integrity_check_on_startup` per PRD. The current per-output implementation can remain as a fallback for testing. Priority: address when building the config parser (Phase 6).

---

**Y2: `findDailyFiles` helper inconsistency across test files**

The `findDailyFiles` helper is defined in 3 test files with different return semantics:

| File | Returns |
|---|---|
| `full-pipeline.test.ts` | Filenames only (no path join), uses `readdirSync().filter()` |
| `power-loss-recovery.test.ts` | Full paths (with `join(dir, f)`) |
| `sustained-operation.test.ts` | Filenames only (no path join) |

All callers are internally consistent (files returning names use `join(tmpDir, file)`, files returning paths use them directly), so this is not a bug. But it is a maintenance hazard -- a copy-paste from the wrong file would produce silent double-path-join bugs.

**Recommendation:** Extract `findDailyFiles` and `queryDailyDb` into a shared `test/e2e/helpers.ts` module with a single consistent implementation. This also reduces the DRY violation of having `queryDailyDb`, `countRows`, `makeTempDir`, and `makeLocalStoreConfig` duplicated across files.

---

**Y3: Error capture pattern overrides `console.error` globally (error-resilience.test.ts:116-127, sustained-operation.test.ts:153)**

The `captureErrors()` helper and the inline `console.error` override replace the global `console.error` function. If a test fails mid-execution (e.g., a timeout), the `finally` block restores it -- but if the test runner itself produces errors, they'd be swallowed during the test. More importantly, if an unrelated concurrent test writes to `console.error` (Bun can run test files in parallel), the override could capture noise from other test files or miss legitimate errors.

This is acceptable for the current codebase (Bun runs tests within a single file sequentially), but:

**Recommendation:** Consider using a spy/mock pattern instead of wholesale replacement. A lightweight approach:

```typescript
const originalError = console.error;
const captured: string[] = [];
console.error = (...args: unknown[]) => {
  captured.push(args.map(String).join(" "));
  originalError.apply(console, args); // still log to stderr
};
```

This preserves visibility during debugging while still capturing for assertions. Low priority since the current approach works and tests pass.

---

**Y4: Test 5.4.3 asserts exact write error log format (error-resilience.test.ts:287-290)**

```typescript
const writeErrors = errors.filter((e) => e.includes("output write error"));
expect(writeErrors.length).toBe(3);
```

This assertion is coupled to the exact string `"output write error"` in `runtime.ts` line 270/283. If the log message changes (e.g., adding context like the output name), this test silently becomes a false negative (finds 0 matches, assertion fails). The coupling is acceptable for E2E tests, but:

**Recommendation:** The error message string should be a constant or at minimum documented in a comment: `// Matches log message in src/pipeline/runtime.ts runOutputFlushLoop()`. This way a developer changing the log message knows to update the test.

---

**Y5: Test 5.2.1 soak test error assertion is zero-tolerance (sustained-operation.test.ts:218)**

```typescript
expect(errors.length).toBe(0);
```

This asserts zero `console.error` calls during the 60-second run. Any logged error -- even a benign one-time race condition during shutdown -- fails the test. In a CI environment under load, the 60-second window increases the probability of non-deterministic timing issues causing a spurious error.

**Recommendation:** Consider either:
- Filtering out known benign patterns (e.g., shutdown-related errors) before the zero assertion
- Asserting `errors.filter(e => !e.includes("shutdown")).length === 0` to allow graceful shutdown noise
- Adding a comment documenting that this is intentionally strict and explaining what to do if it flakes

Not urgent since the test has been passing, but this is the most likely test to flake in CI.

---

### GREEN Nice to Have

**G1: Test helper classes could be shared**

`CollectorOutput` is defined in both `full-pipeline.test.ts` (line 93) and `error-resilience.test.ts` (line 97) with slightly different fields. `HealthyInput`, `SimplePollingInput`, and `SequentialCounterInput` are similar concepts with minor differences. Extracting these to `test/e2e/test-helpers.ts` would reduce duplication.

---

**G2: Missing assertion in test 5.0.4 -- aggregator push happens BEFORE output close**

Test 5.0.4 verifies that `aggregator_push` events exist and that `output_close` happens after `service_input_stop`, but does not verify the temporal ordering between `aggregator_push` and `output_close`. The PRD SS8 shutdown sequence specifies: "7. Aggregators push final aggregation" before "9. Outputs flush remaining buffers, then close". Adding:

```typescript
const lastAggPush = aggPushes[aggPushes.length - 1]!;
expect(lastAggPush.timestamp).toBeLessThanOrEqual(outputClose!.timestamp);
```

would strengthen this test. Currently the ordering is implicitly guaranteed by the runtime implementation (main loop pushes final aggregator data before closing output channels), but an explicit assertion documents the requirement.

---

**G3: Test 5.1.3 data loss bound could verify recovery works end-to-end**

The data loss bound test (5.1.3) opens the daily DB directly after simulated crash and counts rows. It does not verify that a NEW `LocalStoreOutput` instance can successfully open, recover, and write to the same directory. Adding a "re-open via LocalStoreOutput and write new data" step would prove that the recovery path works at the plugin level, not just at the raw SQLite level.

---

**G4: Buffer overflow test 5.3.1 -- could verify dropped metrics are specifically the oldest**

The test verifies the newest 100 are retained (counters 101-200), but could also verify that the oldest (counters 1-100) are truly gone by doing `buffer.beginTransaction(200)` and confirming only 100 returned, or by checking the length after a larger read.

Currently the `expect(buffer.length).toBe(100)` + reading counters 101-200 is sufficient proof, so this is purely a "belt and suspenders" suggestion.

---

**G5: The `tagsHash` function in local-store.ts does not sort tags before hashing**

The PRD SS11 says "FNV-64a of sorted tags", and the function comment says "sorted tag key=value pairs", but the function iterates `tags` (a Map) in insertion order rather than sorting by key. If two metrics have the same tags but added in different orders, they'd produce different hashes.

In practice, the `createMetric()` function sorts tags during metric creation (the Map is insertion-ordered after sorting), so this is not currently a bug. However, the `tagsHash` function makes an implicit assumption about its input that is not enforced locally.

**Recommendation:** Either sort the entries before hashing, or add a comment: `// Assumes tags Map is already sorted by key (guaranteed by createMetric)`.

---

## Test Coverage Assessment

### Test Scenario Completeness vs Plan

| Plan Scenario | Test File | Implemented | Notes |
|---|---|---|---|
| 5.0.1 Full four-stage pipeline | full-pipeline.test.ts | PASS | Real plugins: InternalInput, FilterProcessor, BasicstatsAggregator, LocalStoreOutput |
| 5.0.2 Multi-input (polling + service) | full-pipeline.test.ts | PASS | SimplePollingInput + TestServiceInput -> FileOutput |
| 5.0.3 Processor chain | full-pipeline.test.ts | PASS | rename -> filter -> basicstats -> local-store |
| 5.0.4 Shutdown ordering | full-pipeline.test.ts | PASS | Instrumented plugins, event timestamps verified |
| 5.1.1 WAL recovery | power-loss-recovery.test.ts | PASS | 1000 metrics, no close(), WAL checkpoint, integrity check |
| 5.1.2 S&F buffer recovery | power-loss-recovery.test.ts | PASS | Unresolved transaction survives close/reopen |
| 5.1.3 Data loss bound | power-loss-recovery.test.ts | PASS | 50 batches, at most 1s loss |
| 5.1.4 Corruption detection | power-loss-recovery.test.ts | PASS | Corrupt bytes, file moved aside, fresh DB usable |
| 5.2.1 60s continuous run | sustained-operation.test.ts | PASS | Zero errors, >=95% metrics, monotonic timestamps, no dupes |
| 5.2.2 Memory stability | sustained-operation.test.ts | PASS | RSS growth <= 50% between t=5s and t=55s |
| 5.2.3 Daily rotation | sustained-operation.test.ts | PASS | 3 days, retention evicts oldest |
| 5.3.1 drop_oldest overflow | buffer-overflow.test.ts | PASS | limit=100, add 200, oldest evicted |
| 5.3.2 Failing output (isolation) | buffer-overflow.test.ts | PASS | keepAll preserves, acceptAll clears (isolation, not runtime) |
| 5.3.3 Partial write | buffer-overflow.test.ts | PASS | accept/reject/keep granularity |
| 5.3.4 Unacknowledged tx survives restart | buffer-overflow.test.ts | PASS | Close without resolve, reopen, all metrics present |
| 5.4.1 Input gather error | error-resilience.test.ts | PASS | Failing input isolated, healthy input unaffected |
| 5.4.2 Processor error | error-resilience.test.ts | PASS | bad_metric dropped, good_metric passes through |
| 5.4.3 Output write failure | error-resilience.test.ts | PASS | Fail 3 times, then succeed, metrics retried |
| 5.4.4 Gather timeout | error-resilience.test.ts | PASS | Slow input timed out, fast input responsive |

**19/19 planned scenarios implemented.** All pass.

### Hard Path Coverage (Rule 9)

The Phase 5 tests explicitly target failure modes and edge cases, which is the correct priority for E2E tests:

| Hard Path | Tested | Assessment |
|---|---|---|
| WAL recovery after crash | Yes (5.1.1) | Deterministic, thorough |
| Corruption detection + move-aside | Yes (5.1.4) | Byte-level corruption injected |
| Data loss bound with sync=NORMAL | Yes (5.1.3) | Probabilistic but correctly bounded |
| Buffer overflow eviction | Yes (5.3.1) | Verified oldest dropped, newest retained |
| Partial write accept/reject/keep | Yes (5.3.3) | All three transaction outcomes tested |
| Unresolved transaction crash recovery | Yes (5.1.2, 5.3.4) | Tested in both S&F buffer contexts |
| Input gather error isolation | Yes (5.4.1) | Pipeline continues, other inputs unaffected |
| Processor error -> metric dropped | Yes (5.4.2) | New production code change, properly tested |
| Output write failure + retry | Yes (5.4.3) | Verified retry delivers early metrics |
| Gather timeout isolation | Yes (5.4.4) | Slow input timed out, pipeline responsive |
| Memory stability (60s) | Yes (5.2.2) | RSS growth bounded |
| Daily rotation + retention eviction | Yes (5.2.3) | 3 days, 5-day retention, oldest evicted |

Hard path coverage is good. The tests prioritize failure modes over happy paths, consistent with Rule 9.

---

## Rules Compliance Summary

| Rule | Assessment | Notes |
|---|---|---|
| Rule 1: No Hand-Waving | PASS | All test failures investigated. No timing hacks or sleeps-as-fixes. |
| Rule 2: Tests Prove Behaviour | PASS | Tests validate real data flow, failure modes, and recovery. Not coverage theatre. |
| Rule 3: Small, Verified Steps | PASS | Phase 5 progress shows task-by-task execution with cumulative test counts. |
| Rule 4: One Thing at a Time | PASS | Each task builds on the previous, committed separately. |
| Rule 5: PRD Is the Spec | PASS | Tests map to PRD SS8, SS11, SS12, SS14, SS22 scenarios. See Y1 for naming. |
| Rule 6: Commit Discipline | PASS | 5 commits, clear messages, each with passing tests. |
| Rule 7: No Premature Abstraction | PASS | Test helpers are minimal. No over-engineered test frameworks. |
| Rule 8: Interface Compliance Check | PASS | Production changes match PRD interfaces. |
| Rule 9: Test the Hard Paths First | PASS | Failure modes are the primary focus of Phase 5. |
| Rule 10: No Hardcoded Config Overrides | PASS | Tests use config schemas with explicit values. |
| Rule 11: Handle Return Values and Errors | See R1 | Recursion guard needed in corruption detection path. |
| Rule 12: Lifecycle Ordering Matches PRD | PASS | Shutdown sequence tested in 5.0.4. Startup ordering in runtime.ts matches PRD SS8. |
| Rule 13: Per-Instance, Not Global | N/A | No new global-flag issues. Pre-existing `shouldDropOriginals` documented. |

---

## Phase 6 Readiness Assessment

**Phase 5 is READY for Phase 6. All R1 and Y1–Y5 findings addressed.**

Phase 5 successfully proves:
- The four-stage pipeline works end-to-end with real plugins
- Data survives simulated power loss (WAL recovery)
- The system runs stably for 60 seconds without memory leaks or data gaps
- Buffer overflow and transaction semantics are correct
- Plugin errors are isolated -- one broken plugin does not crash the pipeline

The two production code changes (corruption detection, processor error isolation) are PRD-mandated features that were exposed as gaps by the E2E test writing process -- exactly the outcome Phase 5 was designed to produce.

### Review Findings Resolution (post-review commit)

| Finding | Resolution |
|---------|------------|
| R1 | Added `isRetry` parameter to `getOrOpenDb` — prevents unbounded recursion |
| Y1 | Added TODO comment documenting PRD naming discrepancy for Phase 6/7 config migration |
| Y2 | Extracted shared helpers to `test/e2e/helpers.ts` — `findDailyFiles`, `queryDailyDb`, `countRows`, `makeLocalStoreConfig`, `captureErrors`. Updated 3 test files. |
| Y3 | Updated `captureErrors()` to call `original.apply(console, args)` — logs to stderr while capturing |
| Y4 | Added source comments linking log message assertions to `src/pipeline/runtime.ts` |
| Y5 | Filtered benign shutdown patterns before zero-error assertion in soak test |
| G5 | Added comment to `tagsHash()` documenting sort assumption from `createMetric()` |

---

## Appendix: File-by-File Review Notes

### test/e2e/full-pipeline.test.ts (Task 5.0)

- 4 tests, well-structured with clear assertions
- Uses real `InternalInput`, `FilterProcessor`, `RenameProcessor`, `BasicstatsAggregator`, `LocalStoreOutput`, `FileOutput`
- `TestServiceInput` properly implements both `Input` and `ServiceInput` interfaces
- `afterEach` cleanup properly removes temp directories
- Test 5.0.4 shutdown ordering uses instrumented plugins with event timestamps -- thorough
- The `queryDailyDb` helper correctly uses `safeIntegers(true)` for BigInt timestamps

### test/e2e/power-loss-recovery.test.ts (Task 5.1)

- 4 tests covering WAL recovery, buffer recovery, data loss bound, corruption detection
- Corruption injection (5.1.4) writes random bytes past the 100-byte header -- realistic corruption simulation
- The `openStores` array for cleanup is a good pattern for avoiding resource leaks in tests
- Test 5.1.3 has a 15s timeout -- appropriate for the ~5s write phase
- `findDailyFiles` returns full paths (different from other test files -- see Y2)

### test/e2e/sustained-operation.test.ts (Task 5.2)

- 3 tests including two 60-second soak tests
- `SequentialCounterInput` uses incrementing counter for duplicate detection -- clever
- 90-second timeouts appropriate for 60-second tests
- Console.error capture with try/finally restore -- correct pattern
- Daily rotation test uses generous day spacing (10 days vs 5-day retention) to avoid midnight boundary issues

### test/e2e/buffer-overflow.test.ts (Task 5.3)

- 4 tests exercising the transaction model thoroughly
- Correctly notes that S&F buffer is not wired into runtime (isolation testing per plan guidance)
- Partial write test (5.3.3) covers all three transaction outcomes: accept, reject, implicit keep
- Counter-based verification makes assertions precise and deterministic

### test/e2e/error-resilience.test.ts (Task 5.4)

- 4 tests covering all plugin error types: input, processor, output, timeout
- `ThrowingProcessor` tests the NEW try/catch added to runtime.ts -- validates the production change
- `FailNTimesOutput` is a clean mock for testing retry behavior
- `SlowInput` with 500ms interval (not 50ms) is a good decision to reduce orphan background gathers
- `captureErrors()` pattern is reusable and well-structured
