# Phase 1: Core Pipeline — Implementation Plan

**Goal:** Build the spine of CollatrEdge — the foundational modules that everything else depends on. By the end of Phase 1, we have a working pipeline that can flow metrics from a test input through processors and aggregators to a test output, with all core primitives proven.

**Estimated Duration:** 1–1.5 weeks
**PRD References:** §4 (Architecture), §5 (Data Model), §6 (Plugin System), §7 (Configuration), §8 (Pipeline Lifecycle), §13 (Scheduling), §14 (Error Handling), Appendix B (Interfaces)

---

## Module Dependency Order

```
1. Metric (data model)          ← no deps
2. Channel<T> + Broadcaster     ← Metric (for type param)
3. Ticker                       ← no deps (standalone scheduling)
4. Accumulator                  ← Metric, Channel
5. Plugin interfaces + registry ← Metric, Accumulator
6. Config parser (TOML + env)   ← Plugin registry (for validation)
7. Pipeline runtime             ← ALL of the above
```

Each module is built, tested, and committed before moving to the next. Integration tests run after each module to verify it works with previously-built modules.

---

## Module 1: Metric

**PRD:** §5 (Data Model), Appendix B

### What to Build
- `src/core/metric.ts`
- `Metric` class implementing the full interface from Appendix B
- `FieldValue`, `MetricType`, `MetricPriority` types
- `hashId()` — FNV-64a hash of name + sorted tags
- `copy()` — hand-rolled deep copy (not structuredClone)
- `accept()`, `reject()`, `drop()` — tracking methods (set internal state, no side effects for now)
- Factory function: `createMetric(name, fields, tags?, timestamp?, type?, priority?)`

### Key Constraints
- Tags must be stored sorted by key (for consistent hashing)
- Fields support exactly: `number`, `bigint`, `string`, `boolean`
- Timestamp is `bigint` (nanosecond Unix UTC)
- `hashId()` must be deterministic — same name+tags always produces same hash
- `copy()` must deep-copy tags and fields Maps (no shared references)

### Tests
- Create metric with all field types, verify round-trip
- `hashId()` is deterministic across multiple calls
- `hashId()` is the same regardless of tag insertion order
- `hashId()` differs when name or any tag changes
- `copy()` produces independent copy (mutating copy doesn't affect original)
- `copy()` preserves all fields, tags, timestamp, type, priority
- Factory function with defaults (timestamp auto-assigned, type=untyped, priority=normal)
- Tags are sorted by key in iteration order

---

## Module 2: Channel\<T\> and Broadcaster

**PRD:** §4 (Architecture Overview — Inter-Stage Data Flow)

### What to Build
- `src/core/channel.ts`
- `Channel<T>` class with: `send()`, `receive()`, `close()`, `length`, `capacity`, `closed`
- Ring buffer implementation (fixed capacity, drop-oldest overflow)
- `Broadcaster<T>` class with: `addConsumer()`, `removeConsumer()`, `broadcast()`, `closeAll()`

### Key Constraints
- `send()` on full channel: drop oldest item, add new item (never blocks for MVP)
- `send()` on closed channel: returns `false`, does not throw
- `receive()` yields `AsyncGenerator` — completes naturally when channel is closed AND drained
- `broadcast()` deep-copies metrics to each consumer via a `copy` function parameter
- Each consumer channel is independent — one slow/full consumer doesn't affect others
- Single-threaded — no mutexes needed, cooperative interleaving is sufficient

### Default Capacities (from PRD)
- Input fan-in: 10,000
- Processor chain: 1,000
- Aggregator fork: 1,000
- Per-output: 10,000

### Tests
- **Basic flow:** send N items, receive N items, correct order
- **Capacity:** send more than capacity, verify oldest dropped, newest retained
- **Close:** close channel, verify send returns false, receive drains remaining then completes
- **Empty receive:** receive on empty channel blocks until item sent (async)
- **Broadcaster:** 3 consumers, broadcast 100 items, each consumer gets independent copies
- **Broadcaster independence:** one consumer's channel is full (drops oldest), other consumers unaffected
- **Broadcaster close:** closeAll closes all consumer channels
- **Copy function:** broadcast uses provided copy function, not reference sharing
- **Concurrent send/receive:** producer and consumer running simultaneously via async

### Integration with Module 1
- Create `Channel<Metric>`, send metrics, receive metrics, verify data integrity

---

## Module 3: Ticker

**PRD:** §13 (Scheduling)

### What to Build
- `src/core/ticker.ts`
- `Ticker` class with `tick()` method returning `AsyncGenerator<number>`
- Dual-clock design: monotonic (`Bun.nanoseconds()`) for interval tracking, wall clock (`Date.now()`) for alignment
- Clock jump detection (>2× interval drift triggers re-anchor)
- Aligned mode (default): fires at clock-aligned boundaries
- Jitter support: random delay per tick
- Offset support: fixed delay from boundary

### Key Constraints
- Anchor-based scheduling (not relative to previous tick) — eliminates drift accumulation
- Clock jump detection: if monotonic and wall clock diverge by >2× interval, log warning and re-anchor
- `alignToInterval()` helper: for 10s interval, fires at :00, :10, :20, etc.
- Jitter is random per-tick within [0, jitter] range
- Offset is fixed per-ticker

### Tests
- **Basic interval:** 100ms ticker fires ~10 times in 1 second (±20% tolerance for CI)
- **Aligned mode:** 500ms interval, verify ticks land near multiples of 500ms from epoch
- **Sequence numbers:** yields incrementing sequence starting from 0
- **Cancellation:** async generator can be broken out of (via break or AbortSignal)
- **Jitter:** with 50ms jitter, tick times vary within expected range
- **Clock jump detection:** mock `Date.now()` to simulate a 30-second jump forward, verify re-anchor and warning
- **No drift accumulation:** run 50 ticks at 50ms, verify total elapsed is ~2500ms (not drifting)

---

## Module 4: Accumulator

**PRD:** §6 (Plugin System — Accumulator Contract), Appendix B

### What to Build
- `src/core/accumulator.ts`
- `Accumulator` class implementing: `addFields()`, `addMetric()`, `addError()`
- Takes a `Channel<Metric>` as output target
- `addFields()` creates a Metric and sends to channel
- `addMetric()` sends an existing metric to channel
- `addError()` logs + counts the error (does not throw)
- Auto-timestamp assignment when not provided (`BigInt(Date.now()) * 1_000_000n` for MVP — full nanosecond precision in Phase 2)
- Global tags injection (from config)

### Key Constraints
- `addFields()` auto-assigns timestamp if not provided
- `addFields()` merges global tags with per-metric tags (per-metric takes precedence)
- `addError()` never throws — it's a reporting mechanism
- Thread-safe by virtue of single-threaded runtime (no mutexes)

### Tests
- `addFields()` creates metric with correct name, fields, tags
- `addFields()` auto-assigns timestamp when not provided
- `addFields()` uses explicit timestamp when provided
- `addFields()` merges global tags (global + local, local wins on conflict)
- `addMetric()` sends metric to channel unmodified
- `addError()` counts errors, does not throw
- Multiple `addFields()` calls produce multiple metrics in channel
- Field type validation: number, bigint, string, boolean all work

### Integration with Modules 1–2
- Accumulator writes to Channel\<Metric\>, consumer reads and verifies

---

## Module 5: Plugin Interfaces and Registry

**PRD:** §6 (Plugin System), Appendix B

### What to Build
- `src/core/plugin-types.ts` — interface definitions
- `src/core/plugin-registry.ts` — plugin registration and lookup
- Interfaces: `Input`, `ServiceInput`, `Processor`, `Aggregator`, `Output`, `StatefulPlugin`
- Plugin registry: `registerPlugin()`, `getPlugin()`, `listPlugins()`
- Plugin metadata type (name, type, description)
- Plugin factory: create instances from registry by name

### Key Constraints
- Registry stores classes/factories, not instances
- Multiple instances of same plugin type allowed (e.g., two `modbus` inputs)
- Plugin alias must be globally unique across all types (validated elsewhere, but type supports it)
- Lazy loading via dynamic import (pattern established, actual loading in Phase 2)

### Tests
- Register a plugin, retrieve it by name
- Register multiple plugins of same type
- `getPlugin()` returns undefined for unregistered name
- `listPlugins()` returns all registered plugins with metadata
- Factory creates new instances (not singletons)
- Interface type checks: verify a mock plugin implements Input correctly
- Verify ServiceInput extends Input (has both gather and start/stop)

---

## Module 6: Config Parser

**PRD:** §7 (Configuration)

### What to Build
- `src/core/config.ts`
- TOML parser (use a TOML library: `smol-toml` or `@iarna/toml`)
- Environment variable expansion (`${VAR}`, `${VAR:-default}`, `${VAR:?error}`)
- Zod schema for global agent config
- Per-plugin config extraction (pass raw TOML objects to plugins)
- Secret reference detection (`@{store:key}`) — mark but don't resolve (resolution is Phase 3)
- Config validation with clear error messages

### Key Constraints
- Env var expansion happens BEFORE TOML parsing (or after, on string values — check Telegraf behaviour)
- Invalid config = fail fast with clear error messages, never start with bad config
- Plugin alias uniqueness validation (global across all plugin types)
- `interval` values parsed as duration strings: "10s", "5m", "100ms"
- Config is immutable after validation (frozen object)

### Tests
- Parse valid TOML config → correct structure
- Env var expansion: `${HOME}` resolves to actual value
- Env var default: `${MISSING:-fallback}` resolves to "fallback"
- Env var error: `${MISSING:?must set this}` throws with message
- Duration parsing: "10s" → 10000, "5m" → 300000, "100ms" → 100, "1h" → 3600000
- Invalid TOML → clear error message with line number
- Plugin alias uniqueness: duplicate aliases → error
- Per-plugin interval overrides parsed correctly
- Secret references detected but not resolved (left as `@{store:key}`)
- Empty/missing config file → helpful error (not stack trace)
- Deeply nested config (inputs with arrays of registers) parses correctly

### Integration with Module 5
- Config parser identifies plugin types from TOML sections, maps to registry

---

## Module 7: Pipeline Runtime

**PRD:** §4 (Architecture), §8 (Pipeline Lifecycle)

### What to Build
- `src/pipeline/runtime.ts`
- Pipeline assembly: parse config → create channels → instantiate plugins → wire together
- Startup sequence (simplified for Phase 1 — no SQLite, no Hub, no Web UI)
- Shutdown sequence with graceful drain
- Gather loop: Ticker + Input.gather() + timeout
- Processor chain: for each metric, call each processor in order
- Aggregator fork: copy metrics to aggregator, auto-forward originals
- Output flush loop: batch metrics from channel, call Output.write()
- Signal handling: SIGINT/SIGTERM → graceful shutdown

### Key Constraints
- Pipeline built backwards: outputs → aggregators → processors → inputs (PRD §8)
- Each input gets its own Ticker + gather loop
- Processor chain is sequential (one after another, not parallel)
- Aggregator auto-forwards originals; plugin only emits summaries via push()
- Output flush batches up to `metric_batch_size` before calling write()
- Gather timeout: if gather() exceeds timeout, log error and skip
- If gather() exceeds interval, skip next scheduled collection

### Tests (using mock plugins)
- **End-to-end flow:** mock input → processor → output, verify metrics flow correctly
- **Processor chain:** 2 processors in sequence, each transforms, output sees both transforms
- **Aggregator fork:** metrics pass through to output AND get copied to aggregator
- **Drop original:** with `drop_original = true`, originals don't reach output
- **Gather timeout:** mock input that takes 5s with 1s timeout → timeout error logged, no crash
- **Graceful shutdown:** SIGTERM → all plugins get close/stop called, pipeline drains
- **Multiple inputs:** 2 inputs writing to same channel, output sees metrics from both
- **Multiple outputs:** broadcaster sends to 2 outputs independently

### Integration with ALL previous modules
- This is the full integration test. Real Channel, real Ticker, real Accumulator, mock plugins.

---

## Phase 1 Acceptance Criteria

Phase 1 is complete when:

1. ✅ All unit tests pass (`bun test test/unit/`)
2. ✅ All integration tests pass (`bun test test/integration/`)
3. ✅ End-to-end pipeline test: mock input → rename processor → basicstats aggregator → mock output
4. ✅ Graceful shutdown works (SIGTERM → clean exit, no data loss)
5. ✅ Config file loads and validates correctly
6. ✅ All modules committed with passing tests
7. ✅ No `any` types except in test fixtures
8. ✅ `bun test` runs with zero failures

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Ticker drift on slow CI machines | Use generous tolerance in timing tests (±20%), test tick count not exact timing |
| AsyncGenerator complexity | Start with simplest possible implementation, add features incrementally |
| TOML library compatibility with Bun | Test TOML library in isolation first (add as first task if needed) |
| Config validation error messages too opaque | Write tests for specific error cases, verify messages are helpful |
