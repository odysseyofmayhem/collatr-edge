# Phase 4: Processors & Aggregators — Progress

## Status: IN PROGRESS

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 4.0 | Metric filtering framework | ✅ |
| 4.0i | Filtering → pipeline integration | ⬜ |
| 4.1 | Rename processor | ⬜ |
| 4.1i | Rename → pipeline integration | ⬜ |
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
