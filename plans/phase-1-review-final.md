# Phase 1 Final Review — CollatrEdge Core Pipeline

**Reviewer:** Dex (automated code review)
**Date:** 2026-02-23
**Scope:** Complete Phase 1 — all 12 tasks, all source files, all test files
**Previous review:** `plans/phase-1-review.md` (covered metric.ts, channel.ts, ticker.ts)
**Test run:** 99/99 pass, 336 assertions, 10.16s

---

## Overall Phase 1 Assessment: ✅ COMPLETE

Phase 1 delivers a functional, well-tested pipeline core. All 12 tasks pass. The codebase is clean TypeScript (strict mode, zero `any`), follows the PRD closely, and the test suite verifies meaningful behaviour. The three must-fix items from the previous review have been properly addressed. The architecture is sound and will support Phase 2 plugin development.

There are no blockers. A handful of should-fix items and design notes are documented below for consideration before or during Phase 2.

---

## Previous Review Fix Verification

### ✅ T1/D3 — Clock jump detection (FIXED)

**Previous finding:** Clock jump detection compared monotonic vs *expected* elapsed (seq-based), not wall clock vs monotonic. The PRD prose says "wall clock and monotonic clock disagree."

**Fix verified:** `ticker.ts` now compares `wallElapsedMs = Date.now() - anchor` vs `monoElapsedMs = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000`. The `detectClockJump()` function is extracted and exported for testability. Four dedicated unit tests verify the detection logic (agree, within tolerance, jump detected, threshold scales). A code comment explicitly notes the PRD prose vs pseudocode discrepancy and that the prose is authoritative per CLAUDE.md Rule 5. **Properly fixed.**

### ✅ C1/D1 — `overflow` option on `ChannelOptions` (FIXED)

**Previous finding:** PRD defines `overflow: 'drop-oldest' | 'block'` on `ChannelOptions` but the implementation only had `capacity`.

**Fix verified:** `channel.ts` now exports `OverflowPolicy = "drop-oldest" | "block"` and `ChannelOptions` includes `overflow: OverflowPolicy`. The constructor accepts it (defaulting to `"drop-oldest"`), and throws a clear error if `"block"` is passed ("not implemented (post-MVP)"). Two tests verify: `"block"` throws, `"drop-oldest"` works explicitly. **Properly fixed.**

### ✅ D2 — Aligned mode default (FIXED)

**Previous finding:** PRD §13 says "Aligned mode (default)" but the implementation defaulted to `aligned: false`.

**Fix verified:** `ticker.ts` now defaults `aligned` to `true` (`opts?.aligned ?? true`) with a code comment referencing PRD §13. The aligned mode test ("aligned ticks fire at clock boundaries") verifies boundary alignment within 30ms tolerance. **Properly fixed.**

### Additional fixes from the previous review also verified:

- **M1** (copy() invariant comment) — ✅ Present: "Safe because all FieldValue types are primitives..."
- **M2** (copy() tracking state comment) — ✅ Present: "Tracking state (_accepted/_rejected/_dropped) is deliberately NOT copied..."
- **M3** (tracking methods TODO) — ✅ Present: "TODO: Phase 2 — integrate with delivery tracking / buffer manager"
- **M4** (addTag() sort comment) — ✅ Present: "O(N log N) per call — acceptable for small tag sets..."
- **M6** (hashId() format assumption) — ✅ Present: "Assumes metric names don't contain \0 and tag keys don't contain '='..."
- **T5** (offset tests) — ✅ Added: "offset delays ticks by the specified amount"
- **T6** (aligned mode tests) — ✅ Added: "aligned ticks fire at clock boundaries (default mode)"
- **T8/D4** (clock jump logging) — ✅ TODO comment added, deferred until logging framework
- **CT1** (capacity=1 edge case) — ✅ Added: "capacity=1: every send to full channel replaces the single item"
- **CT2** (send-after-close with buffered items) — ✅ Added: "send-after-close returns false and buffered items are still receivable"

---

## Phase 1 Completeness Checklist

| Task | Description | Status | Tests |
|------|-------------|--------|-------|
| 1.0 | Project setup (Bun, TypeScript, dependencies) | ✅ | Smoke test passes |
| 1.1 | Metric data model | ✅ | 9 unit tests |
| 1.2 | Channel\<T\> with ring buffer | ✅ | 12 unit tests |
| 1.3 | Broadcaster\<T\> | ✅ | 6 unit tests |
| 1.3i | Integration: Channel\<Metric\> + Broadcaster\<Metric\> | ✅ | 3 integration tests |
| 1.4 | Ticker with dual-clock design | ✅ | 10 unit tests |
| 1.5 | Accumulator | ✅ | 8 unit tests |
| 1.5i | Integration: Accumulator → Channel → consumer | ✅ | 3 integration tests |
| 1.6 | Plugin interfaces + registry | ✅ | 5 unit tests |
| 1.7 | Config parser (TOML, env vars, durations) | ✅ | 12 unit tests |
| 1.8 | Pipeline runtime | ✅ | 8 unit tests |
| 1.8i | Integration: Full pipeline E2E | ✅ | 4 integration tests |

**All 12 tasks have `passes: true` in `phase-1-tasks.json`.** ✅

---

## Per-File Findings: New Modules

### `src/core/accumulator.ts`

Clean, focused implementation. The Accumulator contract matches the PRD Appendix B interface exactly.

#### 🟡 Should Fix

**A1. `addFields()` fire-and-forgets `channel.send()` without awaiting or checking the return value**

```typescript
addFields(...): void {
  ...
  this.channel.send(metric); // Promise<boolean> is ignored
}
```

The comment says "With drop-oldest overflow, send() never actually awaits — fire-and-forget is safe." This is true for the current implementation where `send()` is synchronous despite its `async` signature. However:

1. If a future `Channel.send()` becomes truly async (e.g., implementing the `block` overflow policy), this will silently discard the Promise.
2. The return value (`false` if channel is closed) is never checked. If the accumulator's channel is closed (during shutdown), metrics are silently lost with no error or log.

**Recommendation:** At minimum, check the return value and call `console.warn` if `send()` returns `false`, or track a "dropped metrics" counter. This gives operational visibility into data loss during shutdown transitions.

**A2. `addMetric()` also ignores the `send()` return value**

Same issue as A1 for the passthrough path. Processors calling `acc.addMetric()` won't know if the downstream channel rejected their metric.

**Impact:** Low for MVP (drop-oldest never blocks, and closed channels during shutdown are a brief window). But a counter would help debugging.

#### 🟢 Nice to Have

**A3. `addError()` uses raw `console.error`**

When the logging framework is integrated, this should use structured logging with plugin context (which plugin errored, error count, etc.). The current `console.error` is fine for Phase 1.

**A4. No `addError()` test for error with `cause` property**

Modern errors often have a `cause` chain (`new Error("wrap", { cause: innerError })`). The current logging only prints `error.message`, losing the cause chain. Low priority for Phase 1.

---

### `src/core/plugin-types.ts`

Exact match with PRD Appendix B interfaces. All six interfaces are present: `Input`, `ServiceInput`, `Processor`, `Aggregator`, `Output`, `StatefulPlugin`. Method signatures match the PRD.

#### 🟢 Nice to Have

**PT1. No `PluginType` validation helper**

`PluginType` is defined as a string union but there's no runtime type guard (e.g., `isPluginType(s: string): s is PluginType`). Not needed now, but will be useful in Phase 2 when loading plugins from config strings.

---

### `src/core/plugin-registry.ts`

Clean, minimal implementation. Registration, lookup, and listing work correctly.

#### 🟡 Should Fix

**PR1. Registry uses plugin `name` as key — but PRD implies type-scoped naming**

The registry stores plugins keyed by `name` only. The PRD §6 shows plugin loading as `'input/modbus'`, `'processor/rename'`, etc. — with a `type/name` namespace. The current registry would reject registering both an input named "filter" and a processor named "filter" as duplicates.

**Impact:** In practice, the plan doesn't envision name collisions across types. The PRD's `BUILTIN_PLUGINS` table uses `type/name` keys, but that's the lazy-loading table, not the registry itself. The registry pattern is fine for Phase 1 where the pipeline directly instantiates plugins from config. But in Phase 2+ when dynamic loading is needed, consider whether the registry key should be `${type}/${name}` for safety.

**Recommendation:** Document this design decision. Either:
- (a) Keep name-only keys and enforce global uniqueness across types (simpler), or
- (b) Switch to `type/name` keys for future-proofing (aligns with PRD §6 patterns).

**PR2. No `unregisterPlugin()` method**

The registry has `registerPlugin()` and `getPlugin()` but no removal. Hot-reload (PRD §8) will need to unregister/re-register plugins. Not needed for Phase 1, but worth adding a TODO.

#### 🟢 Nice to Have

**PR3. `PluginRegistration<T>` generic parameter `T` is not actually constrained**

The generic `T` is unconstrained (`T = unknown`). It could be constrained to `Input | Processor | Aggregator | Output` to prevent registering non-plugin objects. Low priority since the registry is internal.

---

### `src/core/config.ts`

Thorough implementation covering all PRD §7 requirements. Env var expansion, duration parsing, TOML parsing, Zod validation, alias uniqueness, and secret reference detection all work correctly.

#### 🟡 Should Fix

**CF1. Env var expansion happens on raw text BEFORE TOML parsing — but `${...}` syntax clashes with TOML**

The PRD §7 says "Telegraf syntax, processed before TOML parsing." This is implemented correctly. However, there's a subtle issue: TOML string values that contain literal `${` (e.g., a regex pattern or template string in a plugin config) will be incorrectly expanded. TOML has no escaping mechanism for this since expansion happens before parsing.

**Impact:** Unlikely in IIoT configs, but not impossible. Telegraf has the same limitation. Document this: "Literal `${` in config values will be treated as env var references. Use env vars to inject values that contain `${` if needed."

**CF2. `expandEnvVars` regex doesn't handle nested or escaped braces**

`/\$\{([^}]+)\}/g` will not handle `${VAR_${NESTED}}` or `\${LITERAL}`. This matches Telegraf's behaviour (no nesting, no escaping), so it's correct per PRD. But a code comment noting this limitation would help future maintainers.

**CF3. Duration parsing rejects fractional values with integer-only regex — but the regex actually allows floats**

The regex is `DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/` which correctly allows `"2.5s"` → 2500. This is good — but it's not tested. The PRD examples show only integer durations. Add a test for fractional durations: `"2.5s"` → 2500, `"0.5h"` → 1800000.

**CF4. `extractPluginSection` silently coerces non-array TOML values to single-element arrays**

```typescript
} else if (typeof instances === "object" && instances !== null) {
  result[pluginName] = [instances as PluginInstanceConfig];
}
```

This handles TOML's ambiguity where `[inputs.modbus]` (single table) and `[[inputs.modbus]]` (array of tables) have different structures. The coercion is correct, but it means a typo like `[inputs.modbus]` (should be `[[inputs.modbus]]`) will silently work instead of warning the user. This is Telegraf-compatible behaviour, so it's fine, but worth noting.

**CF5. `AgentSchema` validates `interval` as a string but doesn't validate it's a valid duration string**

The Zod schema accepts any string for `interval`, `flush_interval`, etc. Validation that these are valid duration strings (parseable by `parseDuration()`) only happens later in the pipeline runtime. If someone writes `interval = "banana"`, they get a parse error at runtime, not at config validation time.

**Recommendation:** Add a Zod refinement that validates duration fields are parseable:

```typescript
z.string().refine((s) => { try { parseDuration(s); return true; } catch { return false; } }, "Invalid duration string")
```

This would catch invalid durations at config validation time with a clear error message, rather than at pipeline start.

#### 🟢 Nice to Have

**CF6. Config is not frozen after parsing**

PRD §7 says "Config is immutable after validation (frozen object)." The returned `AgentConfig` is a plain mutable object. Adding `Object.freeze()` (deep) would enforce this contract. Low priority since nothing currently mutates config after parsing.

**CF7. No validation that `global_tags` values are strings**

```typescript
const globalTags = (raw.global_tags ?? {}) as Record<string, string>;
```

This casts without validation. A user writing `site = 42` (number) in `[global_tags]` would pass this as-is, potentially causing issues downstream. A Zod schema for `global_tags` (`z.record(z.string())`) would catch this.

**CF8. `findSecretRefs` uses a global regex with `lastIndex` reset**

The manual `SECRET_REF_RE.lastIndex = 0` reset before `.match()` is correct but fragile. Using a non-global regex or `String.match()` (which doesn't use `lastIndex` with non-global) would be cleaner. Not a bug, but the pattern is easy to accidentally break.

---

### `src/pipeline/runtime.ts`

This is the most complex module and the heart of Phase 1. Overall, the implementation is solid — the pipeline builds backwards per PRD §8, data flows correctly through all stages, and graceful shutdown works.

#### 🔴 Must Fix

**R1. `shouldDropOriginals` is computed as a single global flag across ALL aggregators**

```typescript
const shouldDropOriginals =
  aggregators.length > 0 && aggregators.some((a) => a.dropOriginal);
```

If you have two aggregators and only ONE has `drop_original = true`, ALL originals are dropped. The PRD §6 says `drop_original` is per-aggregator config: "drop_original = true in config suppresses the automatic forwarding." This implies each aggregator independently controls whether the originals it received are forwarded.

**However**, looking at the pipeline model more carefully: there's only one stream of originals flowing through. The aggregators fork *copies* from this stream. `drop_original` controls whether the *original* continues downstream. If ANY aggregator says "drop originals," the originals shouldn't reach outputs — because the aggregator is saying "I'll handle summarising, don't forward the raw data."

**Counterargument:** In Telegraf, `drop_original` is per-aggregator. If aggregator A has `drop_original = true` and aggregator B doesn't, the originals still flow through (B wants them). Only the data going to A's summarisation is affected.

**Analysis:** The current implementation is a simplification that's probably wrong for multi-aggregator scenarios. However, Phase 1 acceptance criteria don't require multiple aggregators with mixed `drop_original` settings, and the single-aggregator case is correct. This should be fixed in Phase 2 when aggregators become more sophisticated.

**Recommendation:** Add a code comment documenting this limitation. The fix would be: only drop originals if ALL aggregators have `drop_original = true`.

#### 🟡 Should Fix

**R2. `runGatherLoop` uses `aligned: false` hardcoded — should use config value**

```typescript
for await (const _seq of ticker.tick(intervalMs, { aligned: false })) {
```

The PRD §7 shows `round_interval = true` in the config, which maps to aligned mode. The `PipelineOptions` interface doesn't include this setting, and the gather loop always uses unaligned mode regardless of config. After the previous review fix made `aligned: true` the Ticker's default, this hardcoded `false` **overrides the corrected default**.

**Impact:** Users who set `round_interval = true` (the default) expect aligned tick behaviour, but they'll get unaligned behaviour because the runtime hardcodes `false`. This is a regression from the previous review fix.

**Fix:** Either remove `aligned: false` to use the Ticker's default (now `true`), or add `aligned` to `PipelineOptions` and wire it from config's `round_interval`.

**R3. `runOutputFlushLoop` doesn't respect `metric_batch_size`**

The PRD §7 specifies `metric_batch_size` (max metrics per `write()` call) and `metric_buffer_limit` (max buffered). The current implementation flushes ALL accumulated metrics in one `write()` call regardless of batch size:

```typescript
await output.write(batch.splice(0)); // sends everything
```

For outputs that have rate limits or payload size limits, sending thousands of metrics in a single `write()` call could cause failures.

**Recommendation:** Accept `batchSize` in `PipelineOptions` and split the flush:

```typescript
while (batch.length > 0) {
  const chunk = batch.splice(0, batchSize);
  await output.write(chunk);
}
```

**R4. `runOutputFlushLoop`'s reader/flusher race condition**

The `batch` array is shared between the `reader` and `flusher` async functions without synchronisation:

```typescript
// Reader pushes items:
batch.push(metric);

// Flusher drains items:
await output.write(batch.splice(0));
```

In a single-threaded JS runtime, `batch.push()` and `batch.splice()` can't interleave mid-operation (no preemption). However, the `done` flag can create a subtle issue:

1. Flusher checks `while (!done)` → false, enters loop body
2. Flusher calls `await Bun.sleep(flushIntervalMs)` — yields to event loop
3. Reader finishes (channel closed), sets `done = true`, pushes final metrics
4. Flusher wakes from sleep, flushes batch
5. Flusher loops back, checks `!done` → false, exits loop
6. Final flush: checks `batch.length > 0` — this catches remaining items ✓

Actually on analysis, the final flush after the while loop handles this correctly. The only edge case is if `output.write()` in the loop body throws — the final flush after the loop is not in a try/catch, so an exception would propagate and the Promise.all would reject.

**Downgrading: not a race condition per se, but the lack of error handling on `output.write()` is a concern.** See R5.

**R5. No error handling in `runOutputFlushLoop` write calls**

If `output.write()` throws (network error, serialisation error), the entire flush loop crashes:

```typescript
// No try/catch around this:
await output.write(batch.splice(0));
```

Since the metrics were already `splice(0)`'d out of the batch before `write()` runs, those metrics are lost permanently. The PRD §14 (Error Handling) discusses retry and circuit-breaking for outputs. While full retry logic is post-Phase 1, a basic try/catch with error logging would prevent data loss and pipeline crashes.

**Recommendation:** Wrap `output.write()` in try/catch, log the error, and consider re-adding failed metrics to the batch (or a separate failed batch for retry).

**R6. `runGatherLoop` timeout doesn't cancel the timed-out `gather()` call**

```typescript
await Promise.race([
  input.gather(acc),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Gather timeout")), timeoutMs),
  ),
]);
```

`Promise.race` resolves with the first settled Promise, but does NOT cancel the other. The `input.gather()` call continues running in the background even after the timeout. If `gather()` takes 5 seconds and the timeout is 1 second, the gather function continues for 4 more seconds, potentially holding resources (TCP connections, file handles) and potentially emitting metrics into the accumulator after the timeout.

**Impact:** A slow input could accumulate orphan `gather()` executions — each new tick starts a new `gather()` before the previous one finishes. On an RPi4 with limited resources, this could cause memory growth and connection exhaustion.

**Recommendation:** Pass an `AbortSignal` into `gather()` so the input plugin can cooperatively cancel. This requires extending the `Input` interface to accept an optional signal. Not needed for Phase 1 MVP, but add a TODO comment documenting the issue.

**R7. Pipeline doesn't wire `globalTags` from `PipelineOptions` into the `BroadcastAccumulator`**

The `BroadcastAccumulator` (used for aggregator `push()`) doesn't inject global tags. When an aggregator calls `pushAcc.addFields("summary", ...)`, the resulting metric won't have global tags. Only the `ChannelAccumulator` for inputs gets `globalTags`.

**Impact:** Summary metrics from aggregators will be missing global tags (e.g., `site`, `line`). This could cause issues downstream if outputs expect all metrics to have these tags.

**Fix:** Either:
- (a) Have `BroadcastAccumulator` accept and inject global tags (like `ChannelAccumulator` does), or
- (b) Apply global tags in a later pipeline stage (output serialisation), or
- (c) Document that aggregator summaries don't inherit global tags and it's the aggregator plugin's responsibility.

Option (a) is simplest and most correct.

**R8. `CollectingAccumulator` doesn't inject global tags either**

Same issue as R7. Processor `addFields()` calls (if a processor creates new metrics rather than passing through existing ones) won't have global tags. Less common than R7 since processors typically use `addMetric()` not `addFields()`, but still a gap.

#### 🟢 Nice to Have

**R9. `PipelineOptions` doesn't map cleanly from `AgentConfig`**

There's no function to convert a parsed `AgentConfig` into a `PipelineOptions`. The E2E test manually extracts and converts config values:

```typescript
const gatherIntervalMs = parseDuration(config.agent.interval);
const flushIntervalMs = parseDuration(config.agent.flush_interval);
```

A `buildPipelineOptions(config: AgentConfig, registry: PluginRegistry): PipelineOptions` function would encapsulate this conversion and be the natural place to resolve plugin instances from the registry. This is likely Phase 2 work.

**R10. No SIGINT/SIGTERM handler**

The PRD §8 shutdown sequence says "Graceful shutdown on SIGINT/SIGTERM." The `PipelineRuntime` has a clean `stop()` method, but there's no code that wires `process.on('SIGINT', ...)` to call it. The tests call `stop()` directly.

**Impact:** This is expected for Phase 1 (the CLI entry point that adds signal handlers is Phase 3+). But document this as a known gap so the entry point implementation in a later phase wires it up.

**R11. Output `connect()` is called inside `runOutputFlushLoop` — but PRD §8 says outputs connect before flush loops start**

PRD §8 step 11: "Connect outputs (Output.connect())" comes before step 16: "Begin flush loops for outputs." The current implementation calls `connect()` inside the flush loop:

```typescript
async function runOutputFlushLoop(...) {
  await output.connect();  // <-- connect happens here, inside the loop
  ...
}
```

This means the output connects asynchronously in a background task, not sequentially before the pipeline starts accepting data. If `connect()` fails, the error propagates to the `Promise.all` of loops during `stop()`, not during `start()`.

**Recommendation:** Move `output.connect()` into `start()` before launching flush loops. This way, a connection failure during startup prevents the pipeline from starting (fail-fast, per PRD §7 and §8).

---

## Test Quality Assessment

### New Unit Tests

#### `test/unit/core/accumulator.test.ts` — 8 tests ✅

Good coverage of the core Accumulator contract. All planned test cases from `phase-1-tasks.json` are present. Tests verify meaningful behaviour: tag merging, auto-timestamp within expected range, error counting without throwing, multiple metrics in channel.

**Gap:** No test verifying `addFields()` with all four field types (`number`, `bigint`, `string`, `boolean`). The Accumulator delegates to `createMetric()` which is tested in metric.test.ts, so this is low risk.

#### `test/unit/core/plugin-registry.test.ts` — 5 tests ✅

Covers registration, lookup (found and not found), listing, factory independence, and duplicate registration. All planned test cases present.

**Gap:** No test for registering plugins of different types with the same name. This relates to PR1 above — if name-only keying is intentional, test that different-type same-name collides. If type-scoped naming is desired, test that it doesn't.

#### `test/unit/core/config.test.ts` — 12 tests ✅

Thorough coverage. Tests env var expansion (set, default, error, missing), duration parsing (valid and invalid), TOML errors, schema validation, alias uniqueness, secret references, file loading, and plugin section extraction.

**Gaps:**
- No test for fractional duration strings (`"2.5s"` → 2500) — the parser supports them via the regex but they're untested.
- No test for cross-type alias collision (input alias = output alias → should error).
- No test for empty string env var with `:-` default syntax. Is `""` considered "unset" for `${VAR:-default}`? The code treats empty as unset (`value !== undefined && value !== ""`), which is correct, but should be tested.

#### `test/unit/pipeline/runtime.test.ts` — 8 tests ✅

All planned test cases from `phase-1-tasks.json` are present. Tests verify: basic flow, processor chaining, aggregator fork, drop_original, gather timeout, graceful shutdown, multiple inputs fan-in, and broadcaster fan-out.

**Gaps:**
- No test for processor that drops metrics (emits nothing via accumulator). This is a key processor contract: "If the processor emits nothing, the metric is dropped." Should verify that when a processor calls no acc methods, the metric doesn't reach the output.
- No test for processor that splits (emits multiple metrics from one input). This is another key contract: "To split: emit multiple."
- No test for aggregator periodic push (the `runAggregatorPushLoop` timer). The tests only verify the final push on shutdown, not the periodic timer-driven push during operation.
- No test for `output.connect()` failure. What happens if `connect()` throws? Currently it would cause the flush loop promise to reject, but would the pipeline recover?

### New Integration Tests

#### `test/integration/accumulator-channel.test.ts` — 3 tests ✅

Clean integration tests verifying Accumulator → Channel data flow, global tag injection, and auto-timestamp reasonableness. The timestamp test includes a sanity check (after 2024-01-01) which is a nice touch.

#### `test/integration/pipeline-e2e.test.ts` — 4 tests ✅

Good E2E coverage: config-driven pipeline, rename processor field transformation, metric count (no loss), and shutdown cleanup. The test uses a real TOML config parsed by the config parser, building plugins from the parsed config values — exactly the integration path that matters.

**Gap:**
- No E2E test with aggregators. The E2E tests only cover input → processor → output. An E2E test with a config-driven aggregator (basicstats-like) would verify the full pipeline including fork/copy/periodic-push.
- The "metric count: no loss" test is strong — it verifies `output.written.length === input.gatherCount`. This is a critical data integrity check.

---

## PRD Compliance — New Modules

### Accumulator (PRD §6, Appendix B)

| Requirement | Status | Notes |
|-------------|--------|-------|
| `addFields()` creates metric with auto-timestamp | ✅ | Uses `BigInt(Date.now()) * 1_000_000n` |
| `addFields()` accepts explicit timestamp | ✅ | Passed through to `createMetric()` |
| `addFields()` merges global tags | ✅ | Global + local, local wins on conflict |
| `addMetric()` forwards existing metric | ✅ | Same object reference, unmodified |
| `addError()` logs + counts, never throws | ✅ | Tested with various error types |
| Interface matches Appendix B | ✅ | `Accumulator` interface exact match |

### Plugin Interfaces (PRD §6, Appendix B)

| Requirement | Status | Notes |
|-------------|--------|-------|
| `Input` interface with `gather(acc)` | ✅ | Exact match |
| `ServiceInput` extends `Input` with `start()`/`stop()` | ✅ | Exact match |
| `Processor` interface with `process(metric, acc)` | ✅ | Exact match |
| `Aggregator` with `add()`/`push()`/`reset()` | ✅ | Exact match |
| `Output` with `connect()`/`write()`/`close()` | ✅ | Exact match |
| `StatefulPlugin` with `getState()`/`setState()` | ✅ | Exact match |
| All methods have optional `init?()` | ✅ | Present on all types |
| `close()` optional on Input/Processor/Aggregator, required on Output | ✅ | Matches PRD |

### Plugin Registry (PRD §6)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Registry stores classes/factories, not instances | ✅ | Factory function pattern |
| Multiple instances from same factory | ✅ | Tested: different objects per call |
| Duplicate name → error | ✅ | Throws with clear message |
| `listPlugins()` with metadata | ✅ | Returns all registrations |
| Lazy loading via dynamic import | 🟡 | Pattern not established — deferred to Phase 2 |

### Config Parser (PRD §7)

| Requirement | Status | Notes |
|-------------|--------|-------|
| TOML parsing | ✅ | Via smol-toml |
| `${VAR}` expansion | ✅ | Error if unset |
| `${VAR:-default}` expansion | ✅ | Fallback value |
| `${VAR:?error}` expansion | ✅ | Error with custom message |
| Duration parsing (ms, s, m, h) | ✅ | Returns milliseconds |
| Zod schema for [agent] | ✅ | All fields with defaults |
| Plugin alias uniqueness | ✅ | Cross-section validation |
| Secret reference detection | ✅ | Marked but not resolved |
| Config immutability | 🟡 | Not frozen (CF6) |
| Plugin section extraction | ✅ | Handles TOML array-of-tables |
| Clear error messages | ✅ | TOML errors, validation errors, missing file |
| Duration validation at parse time | 🟡 | Deferred to runtime (CF5) |
| Per-plugin filtering (namepass/namedrop/etc.) | ⏭️ | Phase 2+ |

### Pipeline Runtime (PRD §4, §8)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Build backwards: outputs → inputs | ✅ | Channels, broadcaster, loops, then inputs |
| Input fan-in (multiple inputs → one channel) | ✅ | Tested with 2 inputs |
| Processor chain (sequential) | ✅ | Tested with 2 processors |
| Aggregator fork (copy to aggregator, forward originals) | ✅ | Tested |
| `drop_original` suppresses forwarding | ✅ | Tested |
| Output fan-out via Broadcaster | ✅ | Tested with 2 outputs |
| Gather timeout | ✅ | Promise.race with setTimeout |
| Gather loop with Ticker | ✅ | Per-input Ticker |
| Output flush loop | ✅ | Reader + periodic flusher |
| Graceful shutdown cascade | ✅ | Abort → close input → drain → close outputs |
| All plugins get `close()` called | ✅ | Tested |
| `metric_batch_size` respected | 🟡 | Not implemented (R3) |
| `Output.connect()` before flush loop | 🟡 | Connected inside loop (R11) |
| SIGINT/SIGTERM handlers | ⏭️ | CLI entry point (Phase 3+) |
| Hot-reload | ⏭️ | Phase 3+ |
| SQLite state persistence | ⏭️ | Phase 3+ |

---

## API Design Assessment: Phase 2 Readiness

Phase 2 will implement real plugins: OPC-UA input, Modbus input, and local data store output. Evaluating whether the Phase 1 API will support them cleanly:

### Input Plugin Integration ✅

The `Input` interface (`gather(acc: Accumulator)`) is clean and sufficient. An OPC-UA input would:
```typescript
async gather(acc: Accumulator): Promise<void> {
  const nodes = await this.session.read(this.nodeIds);
  for (const node of nodes) {
    acc.addFields(node.displayName, { value: node.value }, { nodeId: node.nodeId });
  }
}
```

The `Accumulator` handles timestamp assignment and global tag injection. The pipeline runtime handles scheduling via `Ticker`. No issues.

### ServiceInput Integration ✅

For MQTT or OPC-UA subscriptions that push data asynchronously, the `ServiceInput` interface (`start(acc)` / `stop()`) is appropriate. The pipeline runtime doesn't currently handle `ServiceInput` differently from `Input` in the startup sequence, but the interface is ready. Phase 2 will need to add ServiceInput detection and call `start()` instead of running a gather loop.

### Output Plugin Integration ✅

The `Output` interface (`connect()` / `write(batch)` / `close()`) is clean. A local data store output would:
```typescript
async connect(): Promise<void> {
  this.db = new Database(this.config.path);
  // Create tables, WAL mode, etc.
}
async write(batch: Metric[]): Promise<void> {
  // Insert metrics into SQLite
}
```

### Processor Plugin Integration ✅

The `Processor` interface gives full control to the plugin. Rename, filter, and enrichment processors can all be implemented cleanly. The no-auto-forward design is correct — it makes the contract explicit.

### Aggregator Plugin Integration ✅

The `Aggregator` interface (`add()` / `push()` / `reset()`) maps well to time-window aggregation (basicstats, histograms). The runtime handles copying metrics to the aggregator and auto-forwarding originals.

### Potential Phase 2 Issues

1. **ServiceInput support in runtime** — `start()` needs to be called instead of a gather loop. The pipeline runtime currently only supports polling inputs. Will need a type check or config flag.
2. **Plugin loading from config** — No function to instantiate plugins from config + registry. Will need a `buildPipeline(config, registry)` factory.
3. **Per-plugin intervals** — The config supports per-input `interval` overrides, and the pipeline runtime supports per-input intervals via `input.interval`. The wiring works.
4. **`metric_batch_size`** — Needs to be implemented before outputs with payload size limits (R3).

---

## Summary of Findings

### 🔴 Must Fix (1)

| # | File | Finding |
|---|------|---------|
| R1 | runtime.ts | `drop_original` global flag affects ALL aggregators. Per-aggregator control needed. Add comment documenting limitation. |

### 🟡 Should Fix (12)

| # | File | Finding |
|---|------|---------|
| A1 | accumulator.ts | `send()` return value ignored in `addFields()` — silent data loss on closed channel |
| A2 | accumulator.ts | `send()` return value ignored in `addMetric()` — same issue |
| PR1 | plugin-registry.ts | Name-only key could collide across types — document decision |
| CF1 | config.ts | `${` in TOML values interpreted as env var — document limitation |
| CF3 | config.ts | Fractional duration strings (`"2.5s"`) supported but untested |
| CF5 | config.ts | Duration fields not validated at config parse time |
| R2 | runtime.ts | `aligned: false` hardcoded in gather loop, overriding corrected default |
| R3 | runtime.ts | `metric_batch_size` not implemented |
| R5 | runtime.ts | No error handling on `output.write()` — can crash flush loop and lose data |
| R6 | runtime.ts | Timed-out `gather()` continues running — add TODO for cancellation |
| R7 | runtime.ts | `BroadcastAccumulator` missing global tags for aggregator push |
| R11 | runtime.ts | `output.connect()` inside flush loop instead of during startup |

### 🟢 Nice to Have (10)

| # | File | Finding |
|---|------|---------|
| A3 | accumulator.ts | `addError()` uses raw `console.error` |
| A4 | accumulator.ts | No `addError()` test with `cause` chain |
| PT1 | plugin-types.ts | No `PluginType` type guard |
| PR2 | plugin-registry.ts | No `unregisterPlugin()` for hot-reload |
| PR3 | plugin-registry.ts | Generic `T` unconstrained |
| CF2 | config.ts | Note: no nested env vars, no escaping |
| CF4 | config.ts | Silent coercion of `[inputs.x]` to `[[inputs.x]]` |
| CF6 | config.ts | Config not frozen after parsing (PRD says immutable) |
| CF7 | config.ts | `global_tags` values not validated as strings |
| R9 | runtime.ts | No `buildPipelineOptions()` convenience function |

---

## Phase 2 Readiness Assessment

### ✅ Ready to proceed

The Phase 1 core is solid. The plugin interfaces are correct, the pipeline data flow works, the config parser handles all PRD-specified features, and the test suite has meaningful coverage. Phase 2 can build real plugins on top of this foundation.

### Before Phase 2 starts, address:

**Priority 1 (should fix before Phase 2):**
1. **R2** — Remove hardcoded `aligned: false` in gather loop. This is a regression that will confuse users.
2. **R5** — Add basic try/catch around `output.write()`. Without this, the first real output plugin (local data store) will crash the pipeline on any write error.
3. **R7** — Add global tags to `BroadcastAccumulator`. Aggregator summaries without site/line tags will be a debugging headache.
4. **R11** — Move `output.connect()` to `start()` for fail-fast behaviour.

**Priority 2 (can fix during Phase 2):**
5. **R3** — Implement `metric_batch_size` when building output plugins.
6. **CF5** — Add duration validation to Zod schema when refining config.
7. **R1** — Document or fix per-aggregator `drop_original` when needed.
8. **A1/A2** — Add send() return value checking when implementing structured logging.

### Phase 2 new work needed in existing modules:
- `PipelineRuntime.start()` needs to detect and handle `ServiceInput` plugins (call `start()` instead of gather loop)
- A `buildPipeline(config, registry)` factory function should be created to encapsulate config → pipeline conversion
- Error handling/retry for output writes should be designed alongside real output plugins
