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

### Task 1.3i — Integration: Channel<Metric> + Broadcaster<Metric>
- **What:** Integration test verifying Metric data integrity through Channel and Broadcaster
- **Result:** 3 tests pass covering all 3 required test cases
- **Tests:** 100-metric data integrity, Broadcaster copy isolation (mutate one consumer, other unaffected), hashId consistency across channel transit

### Task 1.4 — Ticker
- **What:** Implemented `Ticker` class with dual-clock design in `src/core/ticker.ts`
- **Result:** 6 tests pass covering all 6 required test cases
- **Implementation details:**
  - `tick()` async generator yields incrementing sequence numbers
  - Dual-clock: `Bun.nanoseconds()` (monotonic) for elapsed tracking, `Date.now()` (wall clock) for scheduling
  - Anchor-based timing: each tick calculated from anchor + seq*interval, eliminates drift accumulation
  - Aligned mode: `alignToInterval()` calculates next clock boundary
  - Jitter: `randomJitter()` adds [0, max] ms per tick in the target calculation
  - Offset: fixed delay added to target
  - Clock jump detection: if monotonic vs wall clock disagree by >2x interval, re-anchor and reset seq
  - Cancellable via `break` in `for await...of`
- **Decisions:**
  - Jitter is applied in the target calculation per PRD pseudocode. With anchor-based timing, spacing between ticks is `interval + jitter_new - jitter_old`, giving a range of [interval-jitter, interval+jitter]. This is the mathematically correct behavior for anchor-based jitter — it prevents thundering herd while maintaining long-term timing accuracy.
  - Jitter test uses tolerances accounting for this anchor-based behavior rather than naive [interval, interval+jitter] range.

### Review Fixes — Code Review Remediation
- **What:** Addressed all must-fix and should-fix findings from `plans/phase-1-review.md`
- **Code fixes:**
  - **T1/D3/D6:** Clock jump detection now compares wall elapsed vs monotonic elapsed (was mono vs expected). PRD prose/pseudocode discrepancy documented per Rule 5.
  - **C1/D1:** Added `overflow: 'drop-oldest' | 'block'` to `ChannelOptions`. `'block'` throws (post-MVP).
  - **D2:** Ticker `aligned` defaults to `true` per PRD §13.
  - **M1/M2:** Documented `copy()` invariant (primitive-only FieldValue, tracking state deliberately not copied).
  - **M3:** Added TODO on tracking methods for Phase 2 integration.
  - **M4/M6:** Added comments on `addTag()` re-sort cost and `hashId()` serialization assumptions.
- **New tests (14 added, total 55):**
  - Metric: hashId empty tags, hashId field-independent, hashId mutation stability, copy→mutate→different hashId
  - Channel: capacity=1, send-after-close, overflow option (block throws, drop-oldest explicit)
  - Ticker: aligned mode e2e, offset, clock jump detection (4 tests covering agreement, tolerance, jump, scaling)
- **Existing tests updated:** All ticker tests now explicitly pass `aligned: false` since default changed to `true`.

### Task 1.5 — Accumulator
- **What:** Implemented `Accumulator` interface and `ChannelAccumulator` class in `src/core/accumulator.ts`
- **Result:** 9 tests pass covering all 9 required test cases
- **Implementation details:**
  - `Accumulator` interface matches PRD Appendix B exactly: `addFields`, `addMetric`, `addError`
  - `ChannelAccumulator` takes `Channel<Metric>` and optional global tags in constructor
  - `addFields()` merges global tags with per-metric tags (per-metric wins on conflict via spread order)
  - Auto-timestamp via `createMetric()` factory: `BigInt(Date.now()) * 1_000_000n` when not provided
  - `addMetric()` sends metric unmodified (same object reference, no copy)
  - `addError()` logs via `console.error`, increments error count, never throws
  - `errorCount` getter exposes error count for monitoring
- **Decisions:**
  - `addFields`/`addMetric` are `void` per PRD but `Channel.send()` is async. With drop-oldest overflow, send() completes synchronously in practice — fire-and-forget is safe. No need for Promise handling in the sync interface.
  - `addMetric()` does NOT copy the metric — it sends the exact object reference. The PRD says "forward an existing metric", and copying is the caller's responsibility (processors can copy if needed).
  - Global tag merge uses `{ ...globalTags, ...localTags }` — spread order ensures per-metric tags win on conflict.

## Current Task
Task 1.5i — Integration: Accumulator → Channel → consumer

## Blockers
(none)

## Notes
(none)
