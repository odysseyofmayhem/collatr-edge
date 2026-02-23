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

### Task 1.5i — Integration: Accumulator → Channel → consumer
- **What:** Integration test verifying end-to-end data flow from Accumulator through Channel to consumer
- **Result:** 3 tests pass covering all 3 required test cases
- **Tests:**
  - Full data flow: addFields creates metric with correct name, fields, tags — consumer receives intact
  - Global tags: present on all received metrics, merged correctly with local tags
  - Auto-timestamp: nanosecond timestamp is within before/after window, sanity-checked against epoch

### Task 1.6 — Plugin interfaces and registry
- **What:** Defined all plugin interfaces in `src/core/plugin-types.ts` and implemented `PluginRegistry` class in `src/core/plugin-registry.ts`
- **Result:** 5 tests pass covering all 5 required test cases
- **Implementation details:**
  - `plugin-types.ts`: `Input`, `ServiceInput`, `Processor`, `Aggregator`, `Output`, `StatefulPlugin` — all match PRD Appendix B field-by-field
  - `PluginType` union: `"input" | "processor" | "aggregator" | "output"`
  - `PluginRegistry` class with `registerPlugin()`, `getPlugin()`, `listPlugins()`
  - `PluginMetadata`: name, type, description
  - `PluginRegistration<T>`: metadata + factory function `() => T`
  - Registry is a class (not module singleton) for test isolation
- **Decisions:**
  - Registry key is `metadata.name` (simple string). The PRD's `BUILTIN_PLUGINS` uses composite keys like `input/modbus`, but that's the lazy-loader map, not the registry. For Phase 1, simple name keys are sufficient.
  - Duplicate name registration throws an error (prevents accidental overwrite). This is the safer default — if you want to replace a plugin, you need to be explicit about it.
  - Factory returns a new instance each call (not singleton) — matches PRD §6 "Each config block creates a new instance via factory."

### Task 1.7 — Config parser
- **What:** Implemented config parser in `src/core/config.ts` with TOML parsing, env var expansion, duration parsing, Zod schema, alias uniqueness, and secret ref detection
- **Result:** 15 tests pass (11 required + 4 additional branch coverage)
- **Implementation details:**
  - `expandEnvVars(text)`: Regex-based expansion on raw text before TOML parsing. Supports `${VAR}` (error if unset), `${VAR:-default}` (fallback if unset/empty), `${VAR:?msg}` (error with message if unset/empty)
  - `parseDuration(str)`: Parses `<number><unit>` to milliseconds. Units: ms, s, m, h
  - `parseConfig(tomlText)`: Full pipeline — env expand → TOML parse → Zod validate → extract sections → alias check → secret ref scan
  - `AgentSchema`: Zod schema for `[agent]` section with all PRD §7 fields and defaults
  - `findSecretRefs(obj)`: Recursive scan for `@{store:key}` patterns — marks but doesn't resolve
  - `validateAliasUniqueness()`: Checks all plugin instances across all sections, names both conflicting locations
  - `loadConfigFile(path)`: Async file load with clear "not found" error
  - `PluginInstanceConfig`: Generic interface for plugin configs (per-plugin Zod validation deferred to plugin loading)
- **Decisions:**
  - Added `zod@4.3.6` as dependency — explicitly required by PRD §6 for config schemas, verified it compiles with `bun build --compile`
  - Env var expansion uses colon semantics (`:?` and `:-` trigger on unset OR empty) matching standard bash behavior
  - Secret refs preserved as literal strings in config values — resolution happens at runtime via the secret store (Phase 5+)
  - Plugin sections extracted generically as `Record<string, PluginInstanceConfig[]>` — per-plugin schema validation happens when plugins are instantiated, not at parse time

### Task 1.8 — Pipeline runtime
- **What:** Implemented pipeline runtime with startup, shutdown, and full data flow in `src/pipeline/runtime.ts`
- **Result:** 8 tests pass covering all 8 required test cases
- **Implementation details:**
  - `PipelineOptions` interface with inputs, processors, aggregators, outputs, intervals, timeouts, global tags
  - `CollectingAccumulator` — in-memory accumulator for processor chain (collects metrics between processor stages)
  - `BroadcastAccumulator` — writes metrics directly to output Broadcaster (used for aggregator push)
  - `runGatherLoop()` — Ticker-driven input gather with configurable timeout via `Promise.race`
  - `runMainLoop()` — reads from input channel, runs sequential processor chain, forks to aggregators + broadcasts to outputs. On input channel close: pushes final aggregator summaries, closes all output channels
  - `runAggregatorPushLoop()` — periodic push/reset with abort-responsive `Promise.race([Bun.sleep, abortSignal])` pattern
  - `runOutputFlushLoop()` — concurrent reader (channel → batch buffer) + flusher (periodic `output.write()`) with final flush on drain
  - `PipelineRuntime` class with `start()` (build backwards: outputs → aggregators → processors → inputs) and `stop()` (abort → close input → cascade → drain → close all plugins)
  - Pipeline builds backwards per PRD §8: output channels/broadcaster → output flush loops → aggregator push loops → input channel → main loop → init plugins → gather loops
  - Graceful shutdown cascade: abort signal stops timer loops → close input channel → main loop drains remaining metrics → pushes final aggregator summaries → closes output channels → output flush loops drain and finish → close all plugins
- **Decisions:**
  - `shouldDropOriginals` checks if ANY aggregator has `dropOriginal: true` — consistent with Telegraf semantics where drop_original is a per-aggregator flag that affects whether originals pass through at all
  - `runAggregatorPushLoop` uses `Promise.race([Bun.sleep, abortPromise])` instead of Ticker — simpler, abort-responsive without blocking on long periods
  - Final aggregator push in `runMainLoop` cleanup does NOT call `reset()` — this is intentional since the pipeline is shutting down and we want the final summary to include all accumulated data

### Task 1.8i — Full pipeline integration test
- **What:** Integration test bridging config parsing with pipeline runtime — TOML → parse → build plugins → run pipeline → verify output → shutdown
- **Result:** 4 tests pass covering all 4 required test cases
- **Tests:**
  - Config-driven pipeline: TOML parsed, config values drive mock plugin construction, global tags flow through pipeline
  - Rename processor: field "celsius" renamed to "temp_c" using config-driven from/to values
  - Metric count: input.gatherCount === output.written.length (no loss)
  - Shutdown: all plugins (input, processor, output) have close() called
- **Implementation details:**
  - `ConfigDrivenInput` — mock input constructed from parsed TOML values (measurement, field_name, field_value)
  - `RenameProcessor` — mock processor constructed from parsed TOML values (from, to) using `metric.removeField()` + `metric.addField()`
  - `MockStoreOutput` — collects written metrics for assertion
  - Tests use `parseDuration()` on config strings to get interval milliseconds, same path as real pipeline would
  - Global tags from `[global_tags]` section flow through to output metrics via `PipelineOptions.globalTags`

### Final Review Fixes — Code Review Remediation (`phase-1-review-final.md`)
- **What:** Addressed all must-fix (1) and should-fix (12) findings from final review
- **Code fixes (runtime.ts):**
  - **R1 (must-fix):** Changed `shouldDropOriginals` from `.some()` to `.every()` — originals only dropped if ALL aggregators have `dropOriginal=true`. Added comment documenting the per-aggregator vs global-flag semantic.
  - **R2:** Removed hardcoded `aligned: false` in gather loop. Added `roundInterval` to `PipelineOptions`, wired through to Ticker. Default `true` matches PRD §13 aligned mode.
  - **R5:** Added try/catch around `output.write()` in flush loop. Failed metrics re-added to batch for retry. Final flush also wrapped.
  - **R6:** Added TODO comment about gather() cancellation via AbortSignal for Phase 2.
  - **R7:** `BroadcastAccumulator` now accepts and injects global tags. Aggregator summary metrics include site/line tags.
  - **R8:** `CollectingAccumulator` now accepts and injects global tags for processor `addFields()` calls.
  - **R11:** Moved `output.connect()` from inside `runOutputFlushLoop` to `start()` method. Fail-fast: connection failure during startup prevents pipeline from starting.
- **Code fixes (accumulator.ts):**
  - **A1/A2:** `addFields()` and `addMetric()` now check `send()` return value via `.then()`. Dropped metrics counted in `droppedCount` getter.
- **Code fixes (config.ts):**
  - **CF1/CF2:** Added documentation comment on env var expansion limitations (no literal `${`, no nesting, no escaping — Telegraf-compatible).
  - **CF5:** Added Zod `durationString` refinement — duration fields in `[agent]` schema are validated at parse time, not just at runtime.
- **Code fixes (plugin-registry.ts):**
  - **PR1:** Added design decision comment explaining name-only key (vs type/name), with note to reconsider for Phase 2.
- **New tests (10 added, total 109):**
  - Runtime: processor drop (emits nothing → output empty), processor split (1 in → 2 out), aggregator periodic push fires during operation, `output.connect()` failure → start() throws, `output.write()` error logged and retried, aggregator summaries include global tags
  - Config: fractional duration parsing (`"2.5s"` → 2500), invalid duration in agent interval/flush_interval → clear error, cross-type alias collision (input + output with same alias → error)

## Status: PHASE COMPLETE

All Phase 1 tasks pass (1.0–1.8i). 109 tests across 12 files, 0 failures.

## Blockers
(none)

## Notes
(none)
