# Phase 1 Review Fix Verification

**Reviewer:** Dex (sub-agent, fresh context)
**Date:** 2026-02-23
**Commit under review:** `99b029a` — "phase-1: address final code review findings"
**Baseline:** `1368b47` (previous commit, before fixes)
**Test run:** 109/109 pass, 359 assertions, 12.37s ✅

---

## Fix Verification

### 🔴 Must Fix Items

#### R1: `drop_original` uses `.every()` not `.some()` — ✅ Fixed

**Original finding:** `shouldDropOriginals` used `.some()`, meaning ONE aggregator's `drop_original = true` suppressed originals for ALL aggregators. The review recommended changing to `.every()` (only drop if ALL want to drop).

**Verification:**
```typescript
// BEFORE (wrong):
aggregators.length > 0 && aggregators.some((a) => a.dropOriginal);

// AFTER (fixed):
aggregators.length > 0 && aggregators.every((a) => a.dropOriginal);
```

The fix is correct. A thorough LIMITATION comment documents the remaining per-aggregator semantic gap vs Telegraf, noting that this is a global flag (all-or-nothing) rather than per-aggregator routing. The comment accurately describes the trade-off and defers full per-aggregator routing to Phase 2.

**Test coverage:** The existing `drop_original=true` test covers the single-aggregator case. No new test for mixed `drop_original` settings across multiple aggregators was added — but this is appropriate since the limitation is documented and deferred. The single-aggregator behaviour (the Phase 1 case) is correctly tested.

**Verdict:** ✅ Properly fixed. Logic corrected, limitation documented, deferred scope identified.

---

### 🟡 Should Fix Items

#### R2: Wire `roundInterval` from config into Ticker aligned mode — ✅ Fixed

**Original finding:** `runGatherLoop` hardcoded `{ aligned: false }`, overriding the Ticker's corrected default of `true`. Users setting `round_interval = true` (the default) would get unaligned behaviour.

**Verification:**
1. `PipelineOptions` now includes `roundInterval?: boolean` with JSDoc: "Maps to config's round_interval."
2. `runGatherLoop` signature now accepts `aligned: boolean` parameter.
3. In `start()`: `const aligned = this.options.roundInterval ?? true;` — the default matches PRD §13 ("Aligned mode (default)").
4. Each gather loop call passes `aligned` to the ticker: `ticker.tick(intervalMs, { aligned })`.

No hardcoded override remains. The config value flows cleanly from `PipelineOptions.roundInterval` → `start()` → `runGatherLoop` → `Ticker.tick()`.

**Test coverage:** No new test specifically exercises `roundInterval` wiring (i.e., passing `roundInterval: true/false` to `PipelineOptions` and verifying tick alignment). The existing Ticker unit tests cover aligned mode behaviour. The pipeline tests use the default (undefined → true). This is acceptable — the wiring is simple, and aligned mode itself is well-tested in ticker.test.ts.

**Verdict:** ✅ Properly fixed. Hardcode removed, config wired through, default matches PRD.

#### R3: `metric_batch_size` not implemented — ❌ Not Fixed (explicitly deferred)

**Original finding:** The flush loop sends ALL accumulated metrics in one `write()` call regardless of batch size.

**Verification:** No changes to batch splitting logic. The `batch.splice(0)` still sends everything at once. This was categorised in the review as "Priority 2 (can fix during Phase 2)" and is not listed in the commit message's addressed items.

**Verdict:** ❌ Not addressed — explicitly deferred to Phase 2 per the review's priority assessment. Appropriate deferral.

#### R4: Reader/flusher race condition → N/A (downgraded in review)

The original review downgraded this from a race condition to a concern about error handling on `output.write()`, which became R5. No separate action needed.

#### R5: try/catch on `output.write()` with retry on failure — ✅ Fixed

**Original finding:** `output.write()` had no error handling. If it threw, the flush loop crashed and metrics already `splice(0)`'d from the batch were lost permanently.

**Verification:**
```typescript
// In periodic flush:
const chunk = batch.splice(0);
try {
  await output.write(chunk);
} catch (err) {
  console.error(`[pipeline] output write error: ${(err as Error).message}`);
  batch.unshift(...chunk);  // Re-add for retry
}

// In final flush:
try {
  await output.write(batch.splice(0));
} catch (err) {
  console.error(`[pipeline] final flush error: ${(err as Error).message}`);
}
```

The periodic flush correctly: (1) splices the batch, (2) attempts write, (3) on failure, logs and re-adds metrics to the front of the batch via `unshift()`. This gives the metrics another chance on the next flush cycle.

The final flush has a try/catch with logging but does NOT re-add on failure — appropriate since there's no "next cycle" to retry on. The metrics are lost on final flush failure, but this is logged.

**Potential concern with retry:** If `output.write()` consistently fails (e.g., output is permanently down), metrics will accumulate unboundedly in the `batch` array since they're re-added after each failure. This is not a regression (previously the pipeline would crash), and bounded retry/circuit-breaking is a Phase 2 concern per PRD §14. The current behaviour (retry once per cycle, log errors) is a significant improvement.

**Test coverage:** New test `"output.write() error: logged and metrics retried on next flush"` verifies:
- First write throws `"network timeout"`
- Error is logged
- Pipeline doesn't crash
- Subsequent writes succeed (writeCallCount ≥ 2)

Good test. It verifies the non-crash and retry behaviour.

**Verdict:** ✅ Properly fixed. Error handling added for both periodic and final flush. Retry on periodic, log-only on final. Tested.

#### R6: Timed-out `gather()` continues running — ⚠️ Partially Fixed (TODO added)

**Original finding:** `Promise.race` doesn't cancel the losing gather call. Slow inputs accumulate orphan executions.

**Verification:** A TODO comment was added:
```typescript
// TODO: Phase 2 — pass AbortSignal into gather() so timed-out calls can
// cooperatively cancel. Currently a slow gather() continues in the background
// after timeout, which could accumulate orphan executions on resource-constrained
// devices. Requires extending Input interface to accept an optional signal.
```

The comment accurately describes the issue and the solution path. No code fix was made — this requires an interface change (extending `Input` to accept `AbortSignal`), which is correctly scoped to Phase 2.

**Verdict:** ⚠️ Partially fixed — documented with TODO, deferred appropriately. The review categorised this as "Should Fix" but acknowledged "Not needed for Phase 1 MVP."

#### R7: Global tags injected into `BroadcastAccumulator` — ✅ Fixed

**Original finding:** `BroadcastAccumulator` (used for aggregator `push()`) didn't inject global tags, so aggregator summary metrics would be missing `site`, `line`, etc.

**Verification:**
1. `BroadcastAccumulator` constructor now accepts `globalTags?: Record<string, string>`.
2. `addFields()` merges: `const mergedTags = { ...this.globalTags, ...(tags ?? {}) };`
3. All three construction sites pass `globalTags`:
   - `runMainLoop()` final push: `new BroadcastAccumulator(outputBroadcaster, globalTags)`
   - `start()` aggregator push loops: `new BroadcastAccumulator(outputBroadcaster, globalTags)`
   - `runMainLoop()` receives `globalTags` parameter from `start()`

**Test coverage:** New test `"aggregator summary metrics include global tags"` verifies:
- Pipeline created with `globalTags: { site: "factory_a", line: "3" }`
- Summary metrics from aggregator push have `getTag("site") === "factory_a"` and `getTag("line") === "3"`

Excellent test — directly validates the fix.

**Verdict:** ✅ Properly fixed and tested. Global tags flow through both periodic push and final push paths.

#### R8: `CollectingAccumulator` doesn't inject global tags — ✅ Fixed

**Original finding:** `CollectingAccumulator` (used between processors) didn't inject global tags when processors called `addFields()`.

**Verification:**
1. `CollectingAccumulator` now has a constructor accepting `globalTags?: Record<string, string>`.
2. `addFields()` merges: `const mergedTags = { ...this.globalTags, ...(tags ?? {}) };`
3. Construction in `runMainLoop()`: `const acc = new CollectingAccumulator(globalTags);` — receives `globalTags` from the function parameter.

**Test coverage:** The `"processor that splits"` test uses `acc.addFields()` inside the processor, which now goes through the global-tag-merging path. However, this test doesn't set `globalTags` on the pipeline, so it doesn't directly verify the tag injection. The `"aggregator summary metrics include global tags"` test does set global tags but doesn't test the processor path specifically.

**Gap:** No dedicated test that sets `globalTags` and verifies they appear on metrics created via `CollectingAccumulator.addFields()` inside a processor. The code is correct by inspection, but untested for this specific path. Low risk since the merging logic is identical to `BroadcastAccumulator`.

**Verdict:** ✅ Fixed (code correct). Minor test gap for the processor + globalTags combination.

#### R11: `output.connect()` moved to `start()` for fail-fast — ✅ Fixed

**Original finding:** `output.connect()` was called inside `runOutputFlushLoop()` (a background task), so connection failures wouldn't surface until shutdown. PRD §8 step 11 requires connecting outputs before flush loops start.

**Verification:**
```typescript
// In start():
// 2. Connect outputs (PRD §8 step 11: connect before flush loops start)
for (const { plugin } of this.options.outputs) {
  await plugin.connect();
}

// 3. Start output flush loops
for (let i = 0; i < this.options.outputs.length; i++) { ... }
```

The `connect()` call is now sequential and awaited in `start()`, before any flush loops launch. A connection failure will cause `start()` to throw immediately — fail-fast as required.

The `runOutputFlushLoop` function no longer calls `connect()` (the `await output.connect();` line was removed from it).

**Test coverage:** New test `"output.connect() failure during startup prevents pipeline from starting"`:
- Output's `connect()` throws `"connection refused"`
- `pipeline.start()` throws with the same error
- Pipeline never starts accepting data

Excellent test — validates the fail-fast behaviour.

**Verdict:** ✅ Properly fixed and tested. Lifecycle ordering now matches PRD §8.

#### A1/A2: Track dropped metrics when `channel.send()` returns false — ✅ Fixed

**Original finding:** `ChannelAccumulator.addFields()` and `addMetric()` fire-and-forgot `channel.send()` without checking the return value. Metrics silently lost on closed channels.

**Verification:**
```typescript
// addFields():
void this.channel.send(metric).then((ok) => {
  if (!ok) this._droppedCount++;
});

// addMetric():
void this.channel.send(metric).then((ok) => {
  if (!ok) this._droppedCount++;
});
```

The `void` prefix correctly marks the intentional fire-and-forget while still handling the result. A new `droppedCount` getter exposes the counter. The original review suggested `console.warn` on drop OR a counter — the counter approach is cleaner (avoids log spam during shutdown) and provides operational visibility.

**Note:** The `void` prefix with `.then()` is a common pattern for "check but don't await." This is correct since `addFields`/`addMetric` must remain synchronous per the PRD `Accumulator` interface (methods return `void`).

**Test coverage:** No dedicated test for `droppedCount` incrementing when the channel is closed. The existing "send-after-close returns false" channel test validates the underlying channel behaviour, and the accumulator's tracking is a simple boolean check on top. Low risk.

**Verdict:** ✅ Fixed. Return values checked, drops tracked. Could benefit from a unit test, but the logic is trivially correct.

#### CF5: Duration fields validated at config parse time via Zod refinement — ✅ Fixed

**Original finding:** Duration fields like `interval`, `flush_interval` accepted any string at parse time. Invalid values like `"banana"` would only fail at runtime when `parseDuration()` was called.

**Verification:**
```typescript
const durationString = z.string().check(
  z.refine((s) => { try { parseDuration(s); return true; } catch { return false; } },
  "Invalid duration string. Expected format: <number><unit> (e.g., \"10s\", \"5m\", \"100ms\", \"1h\")"),
);
```

All 6 duration fields in `AgentSchema` now use `durationString` instead of `z.string()`:
- `interval`, `collection_jitter`, `collection_offset`, `flush_interval`, `flush_jitter`, `precision`

Invalid durations are now caught at config parse time with a clear error message.

**Test coverage:** Two new tests:
- `"invalid duration in agent interval → clear validation error"` — `interval = "banana"` → throws `/Invalid \[agent\] config/`
- `"invalid duration in flush_interval → clear validation error"` — `flush_interval = "10x"` → throws `/Invalid \[agent\] config/`

Both confirm early validation. Good coverage.

**Verdict:** ✅ Properly fixed and tested. Config validation is now fail-fast for invalid durations.

#### CF1/CF2: Documentation comments on env var expansion limitations — ✅ Fixed

**Original finding:** CF1: Literal `${` in TOML values would be incorrectly expanded. CF2: No nested/escaped braces support. Both match Telegraf but should be documented.

**Verification:** Comment added above `expandEnvVars`:
```typescript
// NOTE: Expansion runs on raw text BEFORE TOML parsing (Telegraf-compatible).
// Limitations: (1) Literal "${" in config values will be treated as env var refs.
// Use env vars to inject values containing "${" if needed. (2) No nested refs
// (e.g., ${VAR_${INNER}}) and no escaping (e.g., \${LITERAL}). Both match Telegraf.
```

Clear, complete, and matches the review's recommendations.

**Verdict:** ✅ Fixed (documentation).

#### CF3: Fractional duration strings tested — ✅ Fixed

**Original finding:** The regex supports `"2.5s"` but it was untested.

**Verification:** New test:
```typescript
it("fractional duration strings: '2.5s' → 2500, '0.5h' → 1800000", () => {
  expect(parseDuration("2.5s")).toBe(2_500);
  expect(parseDuration("0.5h")).toBe(1_800_000);
  expect(parseDuration("1.5m")).toBe(90_000);
  expect(parseDuration("0.1ms")).toBe(0.1);
});
```

Thorough — tests four different units with fractional values, including sub-millisecond precision.

**Verdict:** ✅ Fixed (test added).

#### PR1: Document registry naming decision — ✅ Fixed

**Original finding:** Registry uses plugin `name` as key, which could collide across types. Should document the design decision.

**Verification:** Comment added above `PluginRegistry` class:
```typescript
// Design decision: Registry uses plugin name (not type/name) as key. This means
// an input named "filter" and a processor named "filter" would collide. The PRD §6
// BUILTIN_PLUGINS table uses type/name keys (e.g., "input/modbus"), but that's
// the lazy-loading map, not the registry. For Phase 1 where plugins are directly
// instantiated from config, name-only keys enforce global uniqueness — simpler and
// sufficient. If Phase 2+ needs type-scoped naming, switch key to `${type}/${name}`.
```

Clear documentation of the trade-off, matches the review's recommendation option (a).

**Verdict:** ✅ Fixed (documentation).

---

## New Tests Added (10)

| # | File | Test Name | Covers Finding |
|---|------|-----------|----------------|
| 1 | runtime.test.ts | processor that emits nothing: metric is dropped | Test gap from review |
| 2 | runtime.test.ts | processor that splits: one metric in → multiple out | Test gap from review |
| 3 | runtime.test.ts | aggregator periodic push fires during operation | Test gap from review |
| 4 | runtime.test.ts | output.connect() failure prevents startup | R11 |
| 5 | runtime.test.ts | output.write() error: logged and retried | R5 |
| 6 | runtime.test.ts | aggregator summary metrics include global tags | R7/R8 |
| 7 | config.test.ts | fractional duration strings | CF3 |
| 8 | config.test.ts | invalid duration in agent interval | CF5 |
| 9 | config.test.ts | invalid duration in flush_interval | CF5 |
| 10 | config.test.ts | cross-type alias collision | Test gap from review |

All 10 tests target real gaps. No filler tests. Good selection.

---

## New Issues Introduced by Fixes

### NI-1: Potential unbounded batch growth on persistent write failures (Low Risk)

In `runOutputFlushLoop`, when `output.write()` fails, failed metrics are re-added to the batch:
```typescript
batch.unshift(...chunk);
```

If the output is permanently down, the batch grows without bound as new metrics arrive (from the reader) while failed chunks are re-added. On a memory-constrained RPi4, this could cause OOM.

**Mitigation:** This is a known concern — the review already noted that bounded retry/circuit-breaking is a Phase 2 concern (PRD §14). The previous behaviour (pipeline crash on first error) was worse. This is an improvement, not a regression.

**Recommendation:** When implementing `metric_buffer_limit` in Phase 2 (R3), enforce it here.

### NI-2: `CollectingAccumulator` globalTags not tested through processor path (Very Low Risk)

As noted in R8 verification above, no test sets `globalTags` on a pipeline and verifies they appear on metrics created by a processor's `addFields()` call inside `CollectingAccumulator`. The code is correct by inspection (identical pattern to `BroadcastAccumulator` which IS tested), but the specific path is uncovered.

**Impact:** Very low. The merging logic is `{ ...this.globalTags, ...(tags ?? {}) }` — trivially correct.

### NI-3: Zod v4 `z.refine` / `z.check` API usage

The duration validation uses:
```typescript
z.string().check(
  z.refine((s) => { ... }, "message"),
);
```

This is the Zod v4 API (`z.check` + `z.refine`). Verified working (tests pass). No issue per se, but future Zod upgrades should check for API stability.

---

## Remaining Items (Unaddressed)

### Deferred 🟡 Items

| # | Finding | Status | Rationale |
|---|---------|--------|-----------|
| R3 | `metric_batch_size` not implemented | Deferred to Phase 2 | Review said "Priority 2 (can fix during Phase 2)" |
| R6 | Timed-out gather() continues running | TODO added | Requires Input interface change — Phase 2 |

### 🟢 Nice to Have (all skipped — appropriate)

| # | Finding | Status |
|---|---------|--------|
| A3 | `addError()` uses raw console.error | Skipped — awaiting logging framework |
| A4 | No `addError()` test for `cause` chain | Skipped |
| PT1 | No `PluginType` type guard | Skipped |
| PR2 | No `unregisterPlugin()` for hot-reload | Skipped — Phase 3+ |
| PR3 | Generic `T` unconstrained | Skipped |
| CF2 | Note: no nested env vars, no escaping | ✅ Addressed (merged with CF1 documentation) |
| CF4 | Silent coercion of `[inputs.x]` → `[[inputs.x]]` | Skipped |
| CF6 | Config not frozen after parsing | Skipped |
| CF7 | `global_tags` values not validated as strings | Skipped |
| CF8 | `findSecretRefs` global regex pattern | Skipped |
| R9 | No `buildPipelineOptions()` function | Skipped — Phase 2 |
| R10 | No SIGINT/SIGTERM handler | Skipped — Phase 3+ CLI entry point |

All skips are appropriate. These are genuine nice-to-haves that don't affect correctness or Phase 2 readiness.

---

## Phase 2 Readiness Assessment

### ✅ Phase 1 is ready for Phase 2

All 🔴 Must Fix items have been resolved. All Priority 1 🟡 items from the review have been addressed:

| Priority 1 Item | Status |
|------------------|--------|
| R2 — Remove hardcoded `aligned: false` | ✅ Fixed |
| R5 — try/catch on `output.write()` | ✅ Fixed |
| R7 — Global tags in BroadcastAccumulator | ✅ Fixed |
| R11 — `output.connect()` fail-fast | ✅ Fixed |

The two deferred 🟡 items (R3 batch size, R6 gather cancellation) are correctly scoped for Phase 2 and documented with comments/TODOs.

### Quality indicators:
- **109 tests, 0 failures, 359 assertions** — comprehensive and all passing
- **10 new tests** all target real gaps (not coverage padding)
- **No new regressions** introduced by fixes
- **Code comments** document all known limitations and design decisions
- **Lifecycle ordering** now matches PRD §8 (connect → flush loops → gather loops)
- **Error handling** prevents pipeline crashes on output failures
- **Global tags** flow through all accumulator paths
- **Config validation** is fail-fast for invalid durations

### For Phase 2, the following should be kept in mind:
1. Implement `metric_batch_size` when building real output plugins (R3)
2. Add `AbortSignal` to `Input.gather()` when needed (R6)
3. Add `metric_buffer_limit` enforcement in flush loop to prevent unbounded growth (NI-1)
4. Detect `ServiceInput` vs `Input` in runtime and call `start()` instead of gather loop
5. Build `buildPipeline(config, registry)` factory to encapsulate config → pipeline conversion
