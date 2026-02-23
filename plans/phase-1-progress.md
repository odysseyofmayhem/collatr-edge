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

### Task 1.2 — Channel<T>
- **What:** Implemented `Channel<T>` with ring buffer and drop-oldest overflow in `src/core/channel.ts`
- **Result:** 9 tests pass covering all 9 required test cases
- **Implementation details:**
  - Ring buffer backed by fixed-size array with head/tail pointers and count
  - `send()` is async per PRD interface, drops oldest item when full (advances head)
  - `receive()` as `AsyncGenerator<T>` — blocks via Promise-based waiter queue when buffer empty
  - `close()` wakes all waiting receivers so they can see closed state and complete
  - Drain semantics: close + items in buffer → receive yields remaining items, then completes
  - Default capacity 1000 per PRD spec
  - GC-friendly: cleared buffer slots set to `undefined` after read
- **Decisions:**
  - Waiter queue is a simple array of resolve callbacks — sufficient for single-threaded event loop
  - `send()` is `async` per PRD interface even though MVP drop-oldest never actually awaits — keeps interface compatible with future `block` overflow policy

### Task 1.3 — Broadcaster<T>
- **What:** Added `Broadcaster<T>` class to `src/core/channel.ts`
- **Result:** 6 tests pass covering all 6 required test cases
- **Implementation details:**
  - Uses `Set<Channel<T>>` for consumer tracking — O(1) add/remove
  - `broadcast()` sends `copy(value)` to each consumer independently
  - Each consumer channel handles its own overflow — one full channel doesn't affect others
  - `closeAll()` closes every consumer channel
  - Zero-consumer broadcast is a safe no-op
- **Decisions:**
  - Broadcaster lives in same file as Channel since they're tightly coupled (Broadcaster depends on Channel)

## Current Task
Task 1.3i — Integration test: Channel<Metric> + Broadcaster<Metric>

## Blockers
(none)

## Notes
(none)
