# Phase 4: Processors & Aggregators — Progress

## Status: IN PROGRESS

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 4.0 | Metric filtering framework | ✅ |
| 4.0i | Filtering → pipeline integration | ✅ |
| 4.1 | Rename processor | ✅ |
| 4.1i | Rename → pipeline integration | ✅ |
| 4.2 | Filter processor | ✅ |
| 4.2i | Filter → pipeline integration | ✅ |
| 4.3 | Basicstats aggregator | ✅ |
| 4.3i | Basicstats → pipeline integration (E2E) | ⬜ |

## Task 4.0: Metric Filtering Framework

**Files created:**
- `src/core/metric-filter.ts` — MetricFilter class + MetricFilterSchema + globToRegex
- `test/unit/core/metric-filter.test.ts` — 33 tests (all pass)

**What was built:**
- `globToRegex()` — compiles glob patterns (*, ?) to RegExp at construction time, not per-metric
- `MetricFilterSchema` — Zod v4 schema with all 6 optional filter fields
- `MetricFilter` class with:
  - Pre-compiled regex patterns for all glob-based filters
  - `isNoop` flag for fast passthrough when no filters configured
  - `apply(metric)` → returns metric (possibly modified), or null if dropped
  - Evaluation order: namepass → namedrop → tagpass → tagdrop → fieldpass → fielddrop

**Decisions:**
- Zod v4 `z.record()` requires explicit key+value schemas: `z.record(z.string(), z.array(z.string()))` — not just the value schema like Zod v3
- Field filters (fieldpass/fielddrop) mutate the metric's field map in-place. This is acceptable because the pipeline runtime copies metrics before passing to processors/aggregators
- `isNoop` computed once at construction to skip all filter logic when no filters configured

**Test coverage (33 tests):**
- globToRegex: 5 tests (*, ?, metachar escaping, exact match, combined)
- No-filter passthrough: 2 tests (empty config, empty arrays)
- namepass: 3 tests (match, no-match, multiple patterns)
- namedrop: 2 tests (match dropped, no-match passes)
- namepass + namedrop: 1 test (whitelist then blacklist)
- tagpass: 4 tests (match, no-match, missing key, multiple keys)
- tagdrop: 3 tests (match dropped, no-match passes, missing key passes)
- fieldpass: 3 tests (keep matching, glob pattern, all removed → drop)
- fielddrop: 3 tests (remove matching, no match → all kept, all removed → drop)
- Glob edge cases: 3 tests (*, ?, multiple patterns)
- Case sensitivity: 1 test
- Evaluation order: 1 test (full chain)
- Config validation: 2 tests

**Test results:** 371 pass, 0 fail (338 existing + 33 new)

## Task 4.0i: Metric Filtering Pipeline Integration

**Files created:**
- `test/integration/metric-filter-pipeline.test.ts` — 3 integration tests (all pass)

**What was tested:**
- Input with namepass filter: 5 metrics produced per gather, only 3 matching `temperature_*` or `pressure_*` reach output. Verified `humidity` and `debug_info` never arrive.
- Processor with fieldpass: metric with 4 fields passes through a filter processor keeping only `value` and `quality`. Verified `debug_count` and `internal_seq` removed.
- Combined input namepass + processor fieldpass: two filter layers work together. Input filters by name, processor trims fields. Verified both filters applied correctly.

**Design notes:**
- The pipeline runtime doesn't have built-in per-plugin filter hooks (yet). Integration tests wire MetricFilter into mock plugins that apply filtering in `gather()` or `process()`.
- `FilteringInput` creates metrics internally, applies MetricFilter, then emits only passing metrics via `acc.addMetric()`.
- `FilterProcessor` implements the Processor contract: receives metric, applies filter, emits if passes, drops if null.
- Tests run the real `PipelineRuntime` with real `Channel<T>`, real timers (50ms gather/flush), and verify output after 300ms.

**Test results:** 374 pass, 0 fail (371 + 3 new integration tests)

## Task 4.1: Rename Processor

**Files created:**
- `src/plugins/processors/rename.ts` — RenameProcessor class + RenameConfigSchema
- `test/unit/plugins/processors/rename.test.ts` — 15 tests (all pass)

**What was built:**
- `RenameConfigSchema` — Zod v4 schema with `replace` array of `{ field?, tag?, dest }` rules
- `RenameProcessor` class implementing `Processor` interface:
  - Applies rename rules in order (field rename, tag rename)
  - Missing source field/tag: rule silently skipped
  - Tag rename uses `addTag()` which re-sorts tags (hashId updates automatically)
  - Always emits via `acc.addMetric()` (explicit processor contract — no auto-forward)

**Test coverage (15 tests):**
- Field rename: 2 tests (basic rename, other fields unaffected)
- Tag rename: 2 tests (basic rename, hashId changes)
- Missing source: 2 tests (field not present, tag not present)
- Multiple rules: 2 tests (3 rules in order, chained A→B→C)
- Explicit emit: 1 test (empty rules still forwards)
- Value type preservation: 1 test (number, string, boolean, bigint)
- Config validation: 5 tests (empty array, defaults, dest required, field+dest, tag+dest)

**Test results:** 389 pass, 0 fail (374 + 15 new)

## Task 4.1i: Rename Pipeline Integration

**Files created:**
- `test/integration/rename-pipeline.test.ts` — 3 integration tests (all pass)

**What was tested:**
- Field rename in pipeline: input metric with `temperature` → output has `motor_temp_c`, original absent, other fields unaffected
- Multiple rename rules: 2 field renames + 1 tag rename all applied in output
- Missing field: metric without matching field passes through unchanged, no spurious fields added

**Test results:** 392 pass, 0 fail (389 + 3 new)

## Task 4.2: Filter Processor

**Files created:**
- `src/plugins/processors/filter.ts` — FilterProcessor class + FilterConfigSchema
- `test/unit/plugins/processors/filter.test.ts` — 7 tests (all pass)

**What was built:**
- `FilterConfigSchema` — reuses `MetricFilterSchema` directly (same fields)
- `FilterProcessor` — thin wrapper around `MetricFilter.apply()`. Emits via `acc.addMetric()` if metric passes, emits nothing if dropped.

**Test coverage (7 tests):**
- namepass: matching pass, non-matching dropped
- namedrop: matching dropped
- tagpass: matching tags pass
- Combined namepass + tagdrop: both applied
- No-op: no filters → all pass
- fieldpass: only specified fields kept
- All fields filtered → metric dropped

**Test results:** 399 pass, 0 fail (392 + 7 new)

## Task 4.2i: Filter Pipeline Integration

**Files created:**
- `test/integration/filter-pipeline.test.ts` — 3 integration tests (all pass)

**What was tested:**
- Mixed input: 5 metrics per cycle, namepass allows 3 → only matching names in output, count is multiple of 3
- tagdrop: metrics with `env=test` removed, `env=production` pass through
- fieldpass: 4-field metric trimmed to 2 fields in output

**Test results:** 402 pass, 0 fail (399 + 3 new)

## Task 4.3: Basicstats Aggregator

**Files created:**
- `src/plugins/aggregators/basicstats.ts` — BasicstatsAggregator class + BasicstatsConfigSchema
- `test/unit/plugins/aggregators/basicstats.test.ts` — 17 tests (all pass)

**What was built:**
- `BasicstatsConfigSchema` — Zod v4 schema with period, drop_original, stats selection, per-plugin filtering
- `FieldStats` class — Welford's online algorithm for numerically stable mean/variance/stdev
- `BasicstatsAggregator` class implementing `Aggregator` interface:
  - `add(metric)` — accumulates numeric fields (number, bigint), groups by hashId, skips string/boolean
  - `push(acc)` — emits summary metrics via `acc.addFields()` with `{field}_{stat}` naming
  - `reset()` — clears all series state
  - Per-plugin filtering via namepass/namedrop/tagpass/tagdrop
  - Configurable stats: subset of [count, min, max, sum, mean, variance, stdev]
  - Population variance (not sample variance)

**Decisions:**
- Population variance (divide by N) rather than sample variance (divide by N-1). Telegraf uses population variance. For monitoring use cases, the window IS the population.
- BigInt fields converted to Number with a console.warn if > MAX_SAFE_INTEGER
- Summary metric reuses the original metric name (not suffixed) — fields are suffixed instead (`value_mean`, `value_count`, etc.)
- Tags captured as plain object at first `add()` for each series, preserved on push

**Test coverage (17 tests):**
- Core stats: 2 tests (10 values, single value)
- Welford's variance/stdev: 1 test (known population: mean=5, var=4, stdev=2)
- Multiple series: 1 test (separate stats per host tag)
- Mixed types: 1 test (number aggregated, string/boolean ignored)
- BigInt: 1 test (converted to Number)
- Empty window: 1 test (push emits nothing)
- reset(): 2 tests (clears state, reset then push with no data)
- Stats selection: 1 test (only count+mean emitted)
- Field naming: 1 test (all 7 stat suffixes on 2 fields)
- Tag preservation: 1 test
- namepass filtering: 1 test
- Config validation: 4 tests (defaults, custom stats, invalid stat, period string)

**Test results:** 419 pass, 0 fail (402 + 17 new)

## Notes

### This is the lightweight phase
- PRD estimate: 0.5–1 week
- The hard work (pipeline contract, processor/aggregator lifecycle) was done in Phase 1
- Phase 4 implements the actual plugins that use those contracts

### Key algorithms
- Glob matching: compile to regex on init, not per-metric
- Basicstats variance: use Welford's online algorithm (numerically stable)

### Existing pipeline support
- Processor chain (sequential, explicit emit) — tested in Phase 1
- Aggregator fork (copy + auto-forward + periodic push) — tested in Phase 1
- drop_original — tested in Phase 1
