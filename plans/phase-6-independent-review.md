# Phase 6 Independent Code Review

**Reviewer:** Independent reviewer (fresh context — did not write or internally review this code)
**Date:** 2026-02-24
**Scope:** All Phase 6 source files, test files, and internal review document
**Commit:** `3fdb465` (HEAD at time of review)

---

## 1. Test Baseline

### Unit Tests
```
491 pass, 0 fail, 1562 expect() calls
Ran 491 tests across 29 files. [14.89s]
```

### E2E Tests

**4 failures in `test/e2e/error-resilience.test.ts` (tests 5.4.1–5.4.4):**

| Test | Status | Root Cause |
|------|--------|------------|
| 5.4.1: input gather error — pipeline continues | ❌ FAIL | `captureErrors()` captures `console.error`, but Phase 6 switched to `process.stderr.write()` via logger |
| 5.4.2: processor error — bad metrics dropped | ❌ FAIL | Same — `captureErrors()` doesn't see logger output |
| 5.4.3: output write failure — metrics retried | ❌ FAIL | Same |
| 5.4.4: gather timeout — slow input timed out | ❌ FAIL | Same |

**This is a Phase 6 regression.** The `captureErrors()` helper in `test/e2e/helpers.ts` intercepts `console.error`, but the Phase 6 logger commit (`d17dc96`) replaced all `console.error` calls in `src/` with `getLogger().error()`, which writes directly to `process.stderr.write()`. The errors ARE being emitted (visible in test output as JSON lines) but the capture function can't see them.

The internal review claims "555 tests pass, 0 failures" at the end of Phase 6 and "491 unit pass, 46 integration pass, 0 failures" after the fix pass. The 4 E2E failures are reproducible on the current HEAD. **The internal review either did not run the full test suite or misreported results.**

**Pre-existing issues (not Phase 6 regressions):**
- Test 5.2.3 (daily rotation) — known timing bug near UTC midnight. Did not encounter it during this review run but acknowledged per briefing.

---

## 2. Independent Code Review Findings

### 🔴 RED-01: E2E error-resilience tests broken by logger migration (Phase 6 regression)

**Files:** `test/e2e/helpers.ts` (line 90–101), `test/e2e/error-resilience.test.ts` (tests 5.4.1–5.4.4)
**Rule:** Rule 1 (No Hand-Waving), Rule 3 (Small Verified Steps — "never commit with failing tests")

The `captureErrors()` function captures `console.error`:
```typescript
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
  original.apply(console, args);
};
```

But after Phase 6, `runtime.ts` uses `getLogger().error()` → `process.stderr.write()`, bypassing `console.error` entirely. This breaks 4 E2E tests that assert on captured error strings.

The error messages are correctly being produced (visible in stderr during test runs), and the functional behavior tested (pipeline continues, metrics are retried, etc.) still works — the assertions just can't see the log output through the broken capture mechanism.

**Fix:** Update `captureErrors()` to spy on `process.stderr.write` (matching the pattern used by the unit tests) and parse the JSON output to extract error messages. Or provide a dual-capture that intercepts both `console.error` and `process.stderr.write`.

**Impact:** 4 E2E tests fail. This violates Rule 1 ("never dismiss a test failure") and Rule 3 ("never commit with failing tests"). The internal review's claim of 0 failures is incorrect.

---

### 🟡 YELLOW-01: `drop_original` collapsed to global all-or-nothing semantics — deeper analysis

**File:** `src/pipeline/runtime.ts` (lines 196–197, 231 of `runMainLoop`)
**Rule:** Rule 13 (Per-Instance, Not Global)
**PRD ref:** §6 ("`drop_original = true` in config suppresses the automatic forwarding")

```typescript
const shouldDropOriginals =
  aggregators.length > 0 && aggregators.every((a) => a.dropOriginal);
```

This means if two aggregators are configured — one with `drop_original: true` and one with `drop_original: false` — originals flow through for both (because `.every()` returns false). The PRD defines this as per-aggregator. The runtime comment acknowledges this limitation and defers it. This was first flagged as a Rule 13 violation in the Phase 1 review (CLAUDE.md lesson #5) and has been carried through every subsequent phase.

#### Is this a foundation problem?

**Question:** Has Phase 6 built on top of a broken foundation that will require rework?

**Answer: No — but for a subtler reason than expected.** On deeper analysis, the current `.every()` semantics are arguably the *correct* interpretation, and the PRD's "per-aggregator" language is misleading given the pipeline topology.

**The topology constraint:** In the current architecture, all aggregators share a single output broadcaster. Originals and aggregator summaries both flow to the same set of outputs. `drop_original` doesn't mean "this aggregator doesn't see originals" — aggregators always see them via `add(copy)`. It means "originals shouldn't also flow to outputs alongside the summaries."

This makes `drop_original` inherently a **global** decision about the data flow to outputs: either original metrics reach outputs or they don't. Mixed settings (aggregator A says drop, aggregator B says keep) are contradictory — you can't simultaneously send and not-send the same original metric to the same output broadcaster.

The only way true per-aggregator `drop_original` would be meaningful is if each aggregator had its own downstream output set (per-aggregator output routing). The PRD does not describe that architecture.

**The `.every()` approach is a reasonable resolution of the contradiction:** "only drop originals if every aggregator agrees they should be dropped." This is the safe default — it preserves data (originals reach outputs) unless ALL aggregators explicitly say they shouldn't.

#### Phase 6's contribution is correct

Phase 6 did two things with `drop_original`:
1. **Plugin factory** correctly wires per-aggregator `dropOriginal` from config into `PipelineOptions` — correct, and *helps* any future fix
2. **Runtime** passes per-aggregator `dropOriginal` into `runMainLoop` — the data is available, the `.every()` logic consumes it

Neither of these makes a future fix harder. If per-aggregator output routing is ever added, the per-instance `dropOriginal` values are already correctly threaded through the system.

#### Why it hasn't caused problems

Every test and E2E scenario uses either zero aggregators or one aggregator. The bug (if it is one) only manifests with two or more aggregators with different `drop_original` settings — a scenario that hasn't been tested or needed for MVP.

**Recommendation:** Reclassify from "known bug to fix later" to "deliberate design decision given pipeline topology." Add a clarifying comment in the runtime explaining why `.every()` is the correct resolution. If the PRD ever adds per-aggregator output routing, revisit then.

**Impact:** None for MVP (single-aggregator configs). The current semantics are defensible and the per-instance wiring is in place for future evolution.

---

### 🟡 YELLOW-02: `FilteringAccumulator.addFields()` double-applies global tags

**File:** `src/pipeline/runtime.ts` (lines 136–149)
**Rule:** Rule 8 (Interface Compliance)

`FilteringAccumulator.addFields()` merges `this.globalTags` into the tags before creating a metric for filter evaluation. But the `inner` accumulator (a `ChannelAccumulator`) will ALSO merge global tags when it processes the metric via `addMetric()`. Looking at `ChannelAccumulator.addMetric()`:

```typescript
// In FilteringAccumulator.addFields():
const mergedTags = { ...this.globalTags, ...(tags ?? {}) };
const metric = createMetric({ name: measurement, fields, tags: mergedTags, timestamp });
const result = this.filter.apply(metric);
if (result) this.inner.addMetric(result); // addMetric doesn't re-merge tags
```

Actually, checking `ChannelAccumulator.addMetric()` — it just sends the metric to the channel without re-merging tags. So the double-apply concern is limited to the `addFields` path: global tags are merged in `FilteringAccumulator.addFields()` before filter evaluation, then the metric (already with global tags) goes to `inner.addMetric()` which doesn't re-merge. This is actually correct — metrics will have global tags applied exactly once.

**Retracted.** The code is correct on closer inspection. The `addMetric` path skips tag merging, so there's no double-application.

---

### 🟡 YELLOW-02 (revised): Config validate does not validate `[global_tags]` values

**File:** `src/cli/commands/config-validate.ts` (line 41)

The command always prints `✓ [global_tags] valid` without checking that all tag values are strings. If an operator writes `[global_tags]\ncount = 42` (integer, not string), the config parser accepts it, `config validate` says it's valid, but downstream tag handling may behave unexpectedly since tags are `Map<string, string>`.

**Impact:** Minor — TOML gives typed values and the config parser casts `global_tags` as `Record<string, string>` without strict validation. Integer values would become `"42"` through string coercion. Cosmetic issue in the validation output.

---

### 🟡 YELLOW-03: `parseGlobalOptions` does not error when `--config` has missing value — silently falls back to default

**File:** `src/cli/index.ts` (lines 52–55)

```typescript
if (next === undefined || next.startsWith("-")) {
  process.stderr.write(`Error: ${arg} requires a path argument\n`);
  configPath = DEFAULT_CONFIG_PATH;
}
```

When `--config` is provided without a value (e.g., `collatr-edge --config run`), it prints an error to stderr but does NOT return an error code — it silently falls back to the default config path and continues. This means `collatr-edge --config run` would:
1. Print "Error: --config requires a path argument"
2. Treat `run` as a standalone command (since it was consumed by `remaining`)
3. Try to use `/etc/collatr-edge/config.toml`

Wait — actually, `run` would NOT be consumed because the `next.startsWith("-")` check fails for `"run"`, so `"run"` would be taken as the config path value. The guard only fires when `next` is undefined or starts with `-`. So `collatr-edge --config run` would set `configPath = "run"` and have no remaining command.

The real problem case is `collatr-edge --config -h` or `collatr-edge --config` (at end of args). In the latter case, `next` is undefined, the error is printed, but the command continues with the default. This is misleading — the user tried to specify a config but it was silently ignored.

**Impact:** Edge case in CLI arg parsing. The error message is printed, so it's not truly silent, but the command still proceeds rather than returning exit code 1.

---

### 🟡 YELLOW-04: No test for SIGTERM signal handling (only SIGINT tested)

**File:** `test/unit/cli/run.test.ts`
**Rule:** Rule 9 (Test the Hard Paths First)

All signal-related tests use `Promise.resolve("SIGINT")` for the `awaitSignal` mock. There is no test exercising the SIGTERM path. While SIGINT and SIGTERM are handled identically in the implementation, the systemd service sends SIGTERM (not SIGINT), making SIGTERM the production-path signal.

The `createDefaultSignalAwaiter()` function in `run.ts` registers handlers for both signals, but no test verifies SIGTERM actually resolves the promise.

**Impact:** Low — the handler is symmetric. But since SIGTERM is the systemd production path, it deserves at least one test.

---

### 🟡 YELLOW-05: `runMainLoop` processor filter semantics — non-matching metrics pass through unprocessed

**File:** `src/pipeline/runtime.ts` (lines 222–230)

```typescript
if (filter) {
  const filtered = filter.apply(m.copy());
  if (filtered === null) {
    next.push(m);  // Pass through unmodified
    continue;
  }
}
```

When a processor has a filter configured (e.g., `namepass = ["temperature_*"]`), metrics that DON'T match the filter are passed through to the next stage without being processed. This is correct per Telegraf semantics — the filter determines which metrics the processor sees, not which metrics survive.

However, there's a subtle issue: `filter.apply(m.copy())` creates a copy just for filter evaluation, then if the metric passes, the original `m` (not the filtered copy) is passed to `proc.process()`. If the filter has `fieldpass`/`fielddrop` configured, the copy would have fields removed but the actual metric passed to the processor would have all fields. This means field-level filters on processors don't actually filter fields — they only determine pass/drop at the metric level.

**Impact:** Processors with `fieldpass`/`fielddrop` filter configs won't see field-filtered metrics. They'll see the full metric. This is arguably correct behavior (the processor should decide what to do with fields), but it differs from how the same filter works on inputs/outputs where fields are actually removed from the metric. Should be documented.

---

### 🟢 GREEN-01: `config-init.ts` template uses single bracket `[outputs.local_store]` for local store

**File:** `src/cli/commands/config-init.ts` (template)

The template uses `[outputs.local_store]` (single bracket — TOML table) instead of `[[outputs.local_store]]` (array of tables). This means only one local_store output can be configured via the init template. The progress notes say this is intentional ("singleton plugin, consistent with PRD Appendix A"). This is fine — if someone needs multiple local_store outputs they'd add `[[outputs.local_store]]` manually.

---

### 🟢 GREEN-02: Import style inconsistency between test files

**Files:** `test/unit/pipeline/plugin-factory.test.ts` (uses `@pipeline/plugin-factory`), other test files use relative imports

Path aliases (`@core/`, `@pipeline/`, `@plugins/`) are used in `plugin-factory.test.ts` and E2E tests, while unit tests for CLI commands use relative imports (`../../../src/cli/commands/run`). Both work, but the inconsistency is noticeable.

---

### 🟢 GREEN-03: `run.ts` forceExit handler doesn't clean up the shutdown timer

**File:** `src/cli/commands/run.ts` (lines 137–141)

When the double-signal force exit handler fires, it calls `d.forceExit(1)` but doesn't clear the shutdown timer first. In the real implementation, `forceExit` calls `process.exit(1)` which terminates everything, so the timer is irrelevant. But in tests, `forceExit` is a no-op mock, so the timer may still fire after the test completes. The timer is `unref()`'d, so it won't keep the process alive, but it could theoretically fire and call `forceExit` a second time.

The shutdown timeout test (`"shutdown timeout → forceExit called"`) handles this by having `forceExit` resolve the `stop()` promise, which causes `runCommand` to proceed to cleanup where `clearTimeout(shutdownTimer)` is called. So in practice this is fine.

---

## 3. Review of Internal Review Quality

### Thoroughness

The internal review (`phase-6-review-final.md`) was **thorough** in its line-by-line analysis of source files. It identified three RED findings (MetricFilter not applied, aggregator filter stripped, error_behavior not wired) and seven YELLOW findings. The RED findings were genuinely critical — MetricFilter wired but never consumed is exactly the kind of "fix in one module undone by another" pattern documented in CLAUDE.md lesson #2.

### Findings Classification

The classification was mostly correct:

- **RED-01 (MetricFilter not applied):** Correctly classified as RED. Silent functional failure where configured filters are ignored.
- **RED-02 (Aggregator filter stripped):** Correctly classified as RED. `extractFilterConfig()` stripped fields before they reached the Zod schema.
- **RED-03 (error_behavior not wired):** **Overclassified.** This was classified as RED but should have been YELLOW. The implicit defaults (inputs retry, outputs error) are correct per PRD §14. The config field just isn't configurable to override those defaults. For MVP, this is a YELLOW — the behavior is correct, just not user-configurable.
- **YELLOW findings:** All correctly classified.

### Fix Quality

The fixes were well-executed:

| Fix | Quality | Notes |
|-----|---------|-------|
| RED-01: `FilteringAccumulator` + runtime filter application | ✅ Good | Three-point application: input (FilteringAccumulator), processor (copy-based filter eval in runMainLoop), output (filter in runOutputFlushLoop reader). Correct approach. |
| RED-02: Skip `extractFilterConfig()` for aggregators | ✅ Good | Clean fix — lets aggregator Zod schemas handle their own filter fields internally. |
| RED-03: Added all PRD §7 override keys | ✅ Good | Comprehensive — all missing keys added to `OVERRIDE_KEYS` with clear Phase 7+ comments. |
| YELLOW-05: `stripOverrideFields()` in config-validate | ✅ Good | Correct fix for fragility — strips both override and filter keys before Zod validation. |
| YELLOW-06: Injectable shutdown timeout + test | ✅ Good | Made `shutdownTimeoutMs` injectable, added 50ms timeout test. |

### Critical Miss: E2E Test Failures

**The internal review missed that Phase 6 broke 4 E2E tests.** The review document claims "555 tests pass, 0 failures" and the fix pass claims "491 unit pass, 46 integration pass, 0 failures." Running the full test suite on the current HEAD shows 4 E2E failures in `error-resilience.test.ts`.

This is a significant oversight. The E2E tests were already fragile (they rely on capturing `console.error`), and the logger migration to `process.stderr.write` broke the capture mechanism. This should have been caught by running `bun test` (not just `bun test test/unit/`) at the end of each phase task.

The progress document for Task 6.0 says: "458 pass, 0 fail (445 existing + 13 new)". But the previous count (Phase 5 complete) should have been around 537 tests (including E2E). If only 445 were "existing" at the start of task 6.0, the E2E tests may not have been included in the test run.

### Grade: **B+**

**Strengths:**
- Found all three critical MetricFilter wiring issues (RED-01, RED-02)
- Comprehensive YELLOW findings covering config-to-pipeline gaps
- Fix implementations were correct and well-tested
- PRD compliance table was thorough per module
- Test coverage assessment identified specific gaps

**Weaknesses:**
- Missed 4 E2E test failures (the most important quality gate)
- Misreported test counts ("555 pass, 0 fail" is incorrect)
- RED-03 was overclassified (error_behavior defaults are correct, just not configurable)
- Did not verify that `captureErrors()` helper was still compatible with the new logging approach

---

## 4. Phase 7 Readiness Assessment

### Decision: **NO-GO** (conditional)

Phase 7 cannot start until the 4 E2E test failures are fixed. This is a firm gate per Rule 1 ("Never dismiss a test failure") and Rule 3 ("Never commit with failing tests").

### Blocking Issue

| Issue | Effort | Description |
|-------|--------|-------------|
| RED-01 (this review) | 15 min | Update `captureErrors()` in `test/e2e/helpers.ts` to spy on `process.stderr.write` instead of (or in addition to) `console.error`, and parse JSON log lines to extract error messages. All 4 tests should pass without any source code changes. |

### After the fix, Phase 7 can start

The Phase 6 source code is solid after the internal review's fix pass:
- Logger: Correct JSON format, level filtering, child loggers, global singleton ✅
- CLI framework: Clean arg parsing, subcommand routing, exit codes ✅
- Config validate: Per-plugin schema validation with override stripping ✅
- Config init: Mode-aware templates, all three modes validate ✅
- Plugin factory: Config-to-PipelineOptions with per-plugin overrides, filters, ordering ✅
- Run command: Full lifecycle with DI, signal handling, shutdown timeout ✅
- MetricFilter application: Input (FilteringAccumulator), processor (copy-based), output (reader filter) ✅
- Systemd unit: Correct hardening, timeouts ✅

### Deferred Items (documented, acceptable for MVP)

These items are documented in the internal review and are acceptable to carry into Phase 7:

1. **Per-plugin child loggers** — `logLevel` and `alias` wired through PipelineOptions but not yet consumed as child logger context
2. **Per-output flush_interval** — extracted and stripped, not yet wired to per-output flush loop timing
3. **error_behavior switching** — implicit defaults correct, not yet operator-configurable
4. **Per-aggregator `drop_original`** — deliberate design decision given pipeline topology, now documented in PRD §6 (commit `7c68105`). Not a deferred bug.
5. **Processor field-level filter semantics** — `fieldpass`/`fielddrop` on processor filters evaluate on a copy but process the original (YELLOW-05 this review)

---

### 🔴 RED-02: Test 5.2.3 (daily rotation) fails near UTC midnight — wall-clock-dependent timestamps

**File:** `test/e2e/sustained-operation.test.ts` (lines 250–325)
**Rule:** Rule 1 (No Hand-Waving — never dismiss a test failure), Rule 2 (Tests Prove Behaviour)

The daily rotation test creates timestamps relative to `Date.now()`:

```typescript
const now = Date.now();
const day1Ms = now - 10 * MS_PER_DAY;  // 10 days ago
const day2Ms = now - 1 * MS_PER_DAY;   // yesterday
const day3Ms = now;                      // today
```

Then `makeMetricsForDay` creates 50 metrics spaced 1 minute apart:

```typescript
const tsNs = BigInt(dayMs + i * 60_000) * NS_PER_MS;
```

When the test runs close to UTC midnight (e.g., 23:49 UTC), the 50-minute spread pushes metrics past the day boundary. For "today" starting at 23:49, metric #12 onwards (23:49 + 12 min = 00:01 next day) spills into the next UTC day. The test expects 3 daily files but gets 5.

This is a **pre-existing bug from Phase 5** (not a Phase 6 regression), but it's a real test failure on the current HEAD that must be fixed before Phase 7.

**Fix:** Snap to midday of each target day so the 50-minute metric spread cannot cross a day boundary at any time of day:

```typescript
const todayMidnight = now - (now % MS_PER_DAY);
const day1Ms = todayMidnight - 10 * MS_PER_DAY + 12 * 3_600_000; // 10 days ago, noon
const day2Ms = todayMidnight - 1 * MS_PER_DAY + 12 * 3_600_000;  // yesterday, noon
const day3Ms = todayMidnight + 12 * 3_600_000;                     // today, noon
```

**Impact:** Test fails non-deterministically depending on wall clock time. Verified failing at 23:49 UTC (5 files instead of 3). Would also fail for any `now` within 50 minutes of midnight.

---

## 5. Pre-Phase-7 Cleanup Items

| Priority | Item | Effort | Description |
|----------|------|--------|-------------|
| **MUST** | Fix E2E error-resilience tests | 15 min | Update `captureErrors()` in `test/e2e/helpers.ts` to capture `process.stderr.write` output and parse JSON log lines. Currently captures `console.error` which Phase 6 eliminated. All 4 tests (5.4.1–5.4.4) should pass after this fix. |
| **MUST** | Fix test 5.2.3 daily rotation timestamps | 5 min | Change `makeMetricsForDay` base timestamps to use midday (noon UTC) of each target day instead of raw `Date.now()`. Prevents metric timestamps spilling across UTC day boundaries when tests run near midnight. |
| Should | Add SIGTERM test | 5 min | Add one test in `run.test.ts` with `awaitSignal` returning `"SIGTERM"` to verify the production signal path. |
| Should | Fix `parseGlobalOptions` edge case | 5 min | When `--config` is at end of args with no value, return exit code 1 instead of falling back to default config path. |
| Nice | Document processor filter field semantics | 2 min | Add a code comment in `runMainLoop` noting that `fieldpass`/`fielddrop` on processor filters only determine pass/drop, not actual field removal from the metric passed to the processor. |

Commit the MUST fixes as:
- `phase-6: fix E2E error-resilience tests — update captureErrors() for logger migration`
- `phase-5: fix test 5.2.3 — use midday timestamps to prevent UTC day boundary spill`
