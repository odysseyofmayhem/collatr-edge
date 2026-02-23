# Phase 4: Processors & Aggregators — Progress

## Status: NOT STARTED

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 4.0 | Metric filtering framework | ⬜ |
| 4.0i | Filtering → pipeline integration | ⬜ |
| 4.1 | Rename processor | ⬜ |
| 4.1i | Rename → pipeline integration | ⬜ |
| 4.2 | Filter processor | ⬜ |
| 4.2i | Filter → pipeline integration | ⬜ |
| 4.3 | Basicstats aggregator | ⬜ |
| 4.3i | Basicstats → pipeline integration (E2E) | ⬜ |

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
