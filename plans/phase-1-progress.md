# Phase 1: Core Pipeline — Progress

## Status: In Progress

## Completed Tasks

### Task 1.0 — Project Setup
- **What:** Verified existing project initialisation (Bun, TypeScript strict, test infra)
- **Result:** All pre-existing setup confirmed working:
  - `tsconfig.json` has `strict: true`, ESM, path aliases (`@core/*`, `@plugins/*`, `@pipeline/*`)
  - Directory structure matches CLAUDE.md spec (`src/core/`, `src/plugins/`, `test/unit/`, etc.)
  - `smoke.test.ts` covers bun:test, strict mode, smol-toml, msgpackr — all 4 tests pass
  - `bun build --compile` produces binary that runs and outputs version string
- **Decisions:** None — setup was already done correctly prior to this session.

### Task 1.1 — Metric Data Model
- **What:** Implemented `Metric` interface and `createMetric()` factory in `src/core/metric.ts`
- **Result:** 13 tests pass covering all 9 required test cases plus extras (tag/field helpers, tracking methods)
- **Implementation details:**
  - `MetricImpl` class implements the full `Metric` interface from Appendix B
  - Tags sorted on construction and re-sorted on `addTag()` via `sortedMap()` helper
  - `hashId()` uses FNV-64a over `"name\0key1=val1\0key2=val2"` string — deterministic, order-independent
  - `copy()` is hand-rolled: new Maps from existing entries, new `MetricImpl` instance
  - `createMetric()` factory with defaults: auto-timestamp (`BigInt(Date.now()) * 1_000_000n`), type `"untyped"`, priority `"normal"`
  - All 4 field types supported: number, bigint, string, boolean
- **Decisions:**
  - hashId format uses null byte separator between name and tag pairs, `=` between key/value — prevents collisions between e.g. name="a" tag "b=c" vs name="a\0b" tag "c"
  - Tags re-sorted on every `addTag()` call to maintain invariant — acceptable since tag count is small in IIoT contexts

## Current Task
Task 1.2 — Implement Channel<T>

## Blockers
(none)

## Notes
(none)
