# Phase 4: Processors & Aggregators — Progress

## Status: IN PROGRESS

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 4.0 | Metric filtering framework | ✅ |
| 4.0i | Filtering → pipeline integration | ✅ |
| 4.1 | Rename processor | ✅ |
| 4.1i | Rename → pipeline integration | ✅ |
| 4.2 | Filter processor | ⬜ |
| 4.2i | Filter → pipeline integration | ⬜ |
| 4.3 | Basicstats aggregator | ⬜ |
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
