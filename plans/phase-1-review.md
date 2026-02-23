# Phase 1 Core Review — CollatrEdge

**Reviewer:** Dex (automated code review)
**Date:** 2026-02-23
**Commit scope:** `src/core/metric.ts`, `src/core/channel.ts`, `src/core/ticker.ts` + tests
**Test run:** 41/41 pass, 129 assertions, 4.93s

---

## Overall Assessment: 🟢 GO (with targeted fixes)

The Phase 1 core is solid. The three primitives (Metric, Channel, Ticker) are well-implemented, closely follow the PRD, and the test suite is meaningfully thorough rather than superficial. The code is clean, idiomatic TypeScript with strict mode, zero `any` types, and good naming. No blockers. A handful of must-fix items (mostly correctness edge cases and one PRD deviation) and some should-fix items before building Phase 2 on top of this.

---

## Per-File Findings

### `src/core/metric.ts`

#### 🔴 Must Fix

**M1. `copy()` does not deep-copy field values containing reference types (future-proofing)**

Currently `FieldValue = number | bigint | string | boolean` — all primitives, so `new Map(this.fields)` is a correct shallow copy. However, the copy only clones the Map container, not any future reference-type field values. This is fine *today*, but the comment says "deep copy for fan-out" and the PRD §5 says `copy()` is "hand-rolled, not `structuredClone()` — faster for our known structure". If `FieldValue` ever expands (e.g., to include `Uint8Array` for binary payloads), `copy()` will silently produce shared references.

**Impact:** Not a bug today, but a landmine. Add a code comment on `copy()` explicitly documenting the invariant: "Safe because all FieldValue types are primitives. If FieldValue is extended to include reference types, this must be updated."

**M2. `copy()` does not preserve tracking state (`_accepted`, `_rejected`, `_dropped`)**

The copy constructor creates a fresh `MetricImpl` with all tracking flags reset to `false`. If a metric was already accepted/rejected and then copied (e.g., in an aggregator fork), the copy loses that state. The PRD says `accept()`/`reject()`/`drop()` enable "end-to-end delivery tracking through the pipeline" (§5).

**Impact:** Depending on how tracking is consumed downstream, this could cause double-counting or lost tracking signals. The question is: should a copy inherit tracking state, or should it start fresh? Either way, the decision needs to be explicit and documented. My recommendation: copies should start fresh (a copy is a new data point in the pipeline), but add a comment explaining this is intentional.

**M3. Tracking methods (`accept`/`reject`/`drop`) are fire-and-forget with no observable effect**

The private `_accepted`, `_rejected`, `_dropped` flags are set but never read. There's no way for any external code to query tracking state, no callback/event mechanism, and no metrics counter integration. These are dead writes.

**Impact:** This is presumably Phase 2+ work (buffer manager, delivery tracking), but right now these methods are literally dead code. Acceptable for MVP scaffolding, but add a `// TODO: Phase 2 — integrate with delivery tracking / buffer manager` comment so it's clear these aren't forgotten.

#### 🟡 Should Fix

**M4. `addTag()` re-sorts the entire Map on every call**

`addTag()` calls `sortedMap(this.tags)` which converts to array, sorts, and rebuilds a new Map. For a metric with N tags, this is O(N log N) per tag addition. In hot paths (processors adding tags to every metric), this could matter.

**Impact:** Unlikely to be a real problem (metrics rarely have >10 tags), but a binary insertion into the correct position would be O(N) and avoid the re-allocation. Low priority but worth a `// Note: O(N log N) re-sort — acceptable for small tag sets` comment.

**M5. `hashId()` allocates on every call (string concatenation + TextEncoder)**

`hashId()` builds a string via concatenation, then encodes to `Uint8Array` via `TextEncoder`. This allocates at least two objects per call. If `hashId()` is called frequently (aggregator grouping on every metric), this creates GC pressure.

**Impact:** On a Raspberry Pi 4 processing thousands of metrics/second, this could be noticeable. Consider memoising the hash (cache it, invalidate on `addTag`/`removeTag`/name change). Not a blocker for Phase 1, but flag for Phase 2 optimisation.

**M6. `hashId()` format has a theoretical collision between name and tag key**

The hash input format is `name\0key1=val1\0key2=val2`. If a metric name contains `\0`, or a tag key contains `=`, there are ambiguous serialisations that could collide. Example: name=`a\0b` with no tags produces the same hash input as name=`a` with tag `b=` (empty value).

**Impact:** Extremely unlikely in practice (metric names shouldn't contain null bytes), but worth documenting the assumption. The PRD doesn't specify the serialisation format, so this is an implementation detail that should be commented.

#### 🟢 Nice to Have

**M7. `createMetric()` uses `Date.now()` for default timestamp, not monotonic clock**

PRD §5 specifies: "Auto-assigned timestamps use monotonic time adjusted by [wall-clock] offset — monotonic ordering with wall-clock alignment." The current implementation uses `BigInt(Date.now()) * 1_000_000n` which is pure wall-clock. This means two metrics created in rapid succession could theoretically get the same timestamp (or even reversed timestamps if the clock adjusts between calls).

**Impact:** This is explicitly called out as a runtime responsibility in the PRD ("Runtime auto-assigns at gather time"), so it's arguably not `createMetric()`'s job. But the default timestamp in `createMetric()` should either match the PRD's monotonic-adjusted approach, or the factory function should not assign a default timestamp at all (forcing the runtime to always provide one). Recommend adding a comment: "Default timestamp is wall-clock only. Runtime should override with monotonic-adjusted timestamp for production metrics."

**M8. No validation on metric name or field names**

Empty strings, strings with only whitespace, extremely long names — all accepted silently. The PRD doesn't specify validation rules, but downstream serialisation (Sparkplug B, InfluxDB line protocol) may choke on empty names.

**Impact:** Low for Phase 1. Consider adding a `name.length > 0` assertion in Phase 2 when the config validation layer is built.

---

### `src/core/channel.ts`

#### 🔴 Must Fix

**C1. PRD specifies `overflow` option on `ChannelOptions` — not implemented**

PRD §4 defines:
```typescript
interface ChannelOptions {
  capacity: number;
  overflow: 'drop-oldest' | 'block';  // default: 'drop-oldest'
}
```

The implementation only has `capacity` in `ChannelOptions`. The `overflow` field is missing entirely. While the PRD says "MVP: drop-oldest only" and "Post-MVP: configurable per-channel", the interface should still include the field for forward compatibility, and the implementation should throw/warn if `block` is passed.

**Impact:** Downstream code (Pipeline Runtime) will expect to pass `overflow` in options per the PRD interface. Adding the field now (even if only `drop-oldest` is implemented) prevents a breaking interface change later.

**C2. `receive()` has a race condition: closed channel with items can miss wake-up**

Consider this sequence:
1. Channel has 0 items. Receiver calls `receive()`, enters the `while (this.count === 0)` loop, checks `this._closed` (false), creates a Promise and pushes to `this.waiters`.
2. Before the Promise awaits, `close()` is called — sets `_closed = true`, resolves all waiters.
3. The waiter resolves, the receiver loops back to `while (this.count === 0)` — count is still 0, checks `this._closed` (now true), returns.

This is actually correct ✓. But consider:
1. Receiver is in the outer `while (true)` loop.
2. It yields a value. Consumer processes it.
3. Meanwhile, the channel is closed and more items were added.
4. Consumer calls `.next()` on the generator, re-enters the loop.
5. `this.count > 0` — skips inner while loop, yields value.
6. Eventually `this.count === 0` and `this._closed === true` — returns.

Actually, on closer inspection, this is correct. The receive generator properly drains remaining items after close. ✓

**Downgrading this to a non-issue after analysis.** The implementation is correct.

#### 🟡 Should Fix

**C3. `send()` is `async` but never actually awaits anything**

`send()` is declared `async` returning `Promise<boolean>`, but the function body contains no `await`. Every call allocates a Promise microtask unnecessarily. In a hot path (input sending thousands of metrics/sec), this creates GC pressure from Promise allocations.

**Impact:** On RPi4, this could matter at high throughput. Consider making `send()` synchronous (returning `boolean`) or using a sync-first approach that only becomes async if backpressure is needed. However, the PRD interface shows `send(value: T): Promise<boolean>`, so the async signature is correct per spec. Recommendation: keep the async signature for API compatibility but note in implementation comments that the current implementation is synchronous under the hood.

Actually, there's a subtlety: making `send` truly synchronous would change the API contract. The async signature is correct per PRD. This is really about micro-optimisation — a `Promise.resolve(true)` wrapper would be slightly better than `async` function overhead, but it's marginal. **Downgrade to Nice to Have.**

**C4. Multiple concurrent `receive()` generators on the same Channel**

Nothing prevents calling `receive()` multiple times on the same Channel, creating multiple generator instances that compete for the same items. The `waiters` array will wake one receiver per send, but which one is non-deterministic. This could cause subtle bugs if someone accidentally creates two receivers.

**Impact:** The PRD doesn't address this. In the pipeline model, each Channel should have exactly one consumer. Consider either: (a) throwing if `receive()` is called while another generator is active, or (b) documenting that only one concurrent `receive()` generator is supported. Recommendation: add a guard that throws on multiple concurrent receivers.

**C5. `close()` doesn't clear the buffer**

After `close()`, existing items can still be received (correct per spec), but the buffer array itself is never cleared/nulled. If a channel is closed and not garbage-collected (e.g., held by a Broadcaster), the buffer holds onto references.

**Impact:** Minor memory concern. After all items are drained, the ring buffer slots that have been consumed are already set to `undefined` (the receive code does `this.buffer[this.head] = undefined`), so this is actually fine. Only the unconsumed items remain, which is correct behaviour. **Non-issue on inspection.**

#### 🟢 Nice to Have

**C6. Default capacity differs from PRD defaults**

The Channel constructor defaults to `capacity: 1000`. The PRD §4 specifies different defaults per stage: 10,000 for input fan-in, 1,000 for processor chains, etc. The 1,000 default is fine as a code-level default (the Pipeline Runtime will pass stage-specific capacities), but it's worth documenting why 1,000 was chosen as the code default.

**C7. No `drop` metric/counter on overflow**

When `send()` drops the oldest item, there's no signal to the caller or any observability mechanism. The PRD §4 mentions the Broadcaster design goal: "One slow or down output never impacts other outputs." For operational visibility, knowing *when* drops happen is important.

**Impact:** Phase 2 concern (agent self-metrics), but worth a `// TODO: emit drop counter for observability` comment.

---

### `src/core/ticker.ts`

#### 🔴 Must Fix

**T1. Clock jump detection compares monotonic elapsed vs *expected* elapsed, not vs wall clock**

The PRD says: "if wall clock and monotonic clock disagree by more than 2× the interval, the system clock has jumped." The implementation compares:
```typescript
const monoElapsedMs = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
const expectedElapsedMs = seq * interval;
if (Math.abs(monoElapsedMs - expectedElapsedMs) > interval * 2) { ... }
```

This compares monotonic elapsed time vs *expected* elapsed time (based on sequence number). This detects if the *process* was suspended (e.g., laptop sleep, container pause) — which is useful — but does NOT detect wall-clock jumps (NTP correction, manual time change) which is what the PRD specifies.

A wall-clock jump means `Date.now()` suddenly shifts, but `Bun.nanoseconds()` continues monotonically. The current check would NOT trigger on a wall-clock jump because monotonic elapsed and expected elapsed would still agree — it's the *wall clock* that disagrees with monotonic.

The correct check (per PRD pseudocode) should compare wall-clock elapsed vs monotonic elapsed:
```typescript
const wallElapsedMs = Date.now() - anchor;
const monoElapsedMs = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
if (Math.abs(wallElapsedMs - monoElapsedMs) > interval * 2) { ... }
```

**Impact:** This is a correctness bug. NTP corrections (which happen regularly on embedded devices) and manual clock changes will NOT be detected. The ticker will compute negative delays (since `target` is based on the old `anchor` + wall-clock `Date.now()`) and fire ticks immediately in a burst, or hang for a long time. This is exactly the scenario the dual-clock design is supposed to handle.

**T2. Jitter is recalculated on each iteration but may cause negative delays**

The target calculation is:
```typescript
const target = anchor + seq * interval + offset + randomJitter(jitterMax);
```

Since `randomJitter` is called every iteration (including when re-evaluating after a clock jump `continue`), and it returns a different random value each time, the effective target changes on every loop iteration. More importantly, the `delay` calculation:
```typescript
const delay = target - Date.now();
```

If the jitter value is small and wall-clock time has advanced past the target, `delay` will be negative and the tick fires immediately. This is actually correct behaviour (fire late rather than skip), but it means jitter is computed before the clock-jump check. If a clock jump is detected and the loop continues, a new jitter value is computed for the re-anchored seq=0 tick. This is fine.

**Downgrading: not a bug, but the jitter-before-clock-check ordering is fragile. Non-issue currently.**

**T3. PRD specifies `elapsed` variable computed but unused in implementation**

The PRD pseudocode computes `const elapsed = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;` and uses it in the clock jump check. The implementation computes `monoElapsedMs` in the same way. However, the PRD uses `elapsed` vs `expectedElapsed` — which, as noted in T1, is the wrong comparison for detecting wall-clock jumps. So both the PRD pseudocode and the implementation have the same comparison, but the PRD *prose* describes a different check ("wall clock and monotonic clock disagree").

**Impact:** This suggests the PRD pseudocode has a bug that was faithfully transcribed into the implementation. The prose is correct; the pseudocode is wrong. Implementation should follow the prose, not the buggy pseudocode.

#### 🟡 Should Fix

**T4. `alignToInterval` returns the same value when `now` is exactly on the boundary**

```typescript
Math.ceil(now / interval) * interval
```

When `now` is exactly on the boundary (e.g., `alignToInterval(1700000010000, 10000)` → `1700000010000`), this returns the current boundary, not the next one. The test verifies this: "Exact boundary returns same value."

**Impact:** This means if the ticker starts at exactly an interval boundary, the first tick has zero delay and fires immediately. This is arguably correct (you want to fire at boundaries, and you're on one), but could also be surprising. The PRD says "fires at clock-aligned boundaries" without specifying this edge case. Worth documenting the behaviour.

**T5. No `offset` tests**

The `offset` option is implemented but has no test coverage. The test file tests `jitter` and `aligned` mode but never exercises `offset`.

**Impact:** Untested code path. Offset is used for manual scheduling control per the PRD. Add a test that verifies offset delays ticks by the specified amount.

**T6. Aligned mode not tested**

The test file never passes `aligned: true`. All timing tests use the default (unaligned) mode. The `alignToInterval` helper is tested in isolation, but the full aligned ticker path — where the anchor is set to the next clock boundary — is never exercised end-to-end.

**Impact:** The aligned mode is described as the "default" in the PRD §13 ("Aligned mode (default)"), yet the implementation defaults to `aligned: false` (the `Ticker.tick` default is `opts?.aligned ?? false`). This is a PRD deviation AND untested.

#### 🟢 Nice to Have

**T7. `Ticker` is a class with no state — could be a plain function**

The `Ticker` class has no instance fields. `tick()` could be a standalone exported async generator function. The class wrapper adds no value and creates an unnecessary instantiation step.

**Impact:** Minor API cleanliness. The PRD shows it as a class, so this is spec-compliant, but a function would be simpler: `export async function* tick(interval, opts)`.

**T8. No logging on clock jump re-anchor**

The PRD says: "A warning is logged for visibility" when a clock jump is detected. The implementation silently re-anchors with no log output.

**Impact:** Operational visibility. When debugging timing issues on deployed edge devices, knowing that a clock jump was detected is critical. Add a log warning. Can be deferred to when the logging framework is integrated.

---

### `test/unit/core/metric.test.ts`

#### 🟡 Should Fix

**MT1. No test for `hashId()` with empty tags**

The hash of a metric with no tags (common for simple measurements) is never tested. This verifies the base case of the serialisation format.

**MT2. No test for `hashId()` stability across metric mutations**

If you `addTag()` and then `removeTag()` back to the original set, does `hashId()` return the original hash? This tests the sorted-tags invariant under mutation.

**MT3. No test for `copy()` producing a different `hashId()` after mutation**

Copy a metric, mutate the copy's tags, verify the copy's `hashId()` differs from the original's. This is the key correctness property for aggregator grouping.

**MT4. No test for field type `bigint` specifically in `hashId()` — verifying fields are NOT included in hash**

Create two metrics with same name+tags but different bigint field values. Verify `hashId()` is identical. This confirms fields don't affect the hash.

#### 🟢 Nice to Have

**MT5. Tracking method tests are trivially shallow**

The test only verifies `accept()`/`reject()`/`drop()` don't throw. Since these methods currently have no observable effect (see M3), there's nothing else to test. But once tracking is integrated, these tests need to be expanded.

---

### `test/unit/core/channel.test.ts`

#### 🟡 Should Fix

**CT1. No test for capacity=1 edge case**

A capacity-1 channel is the degenerate case of the ring buffer. Every send to a full channel drops the only item. This exercises head/tail wraparound at the boundary.

**CT2. No test for send-after-close returning false with items still buffered**

Send items, close, attempt to send more. Verify send returns false AND that the previously-buffered items are still receivable. This is the graceful-shutdown case.

**CT3. No test for multiple waiters being woken on close**

Have multiple receivers (if that's supported) or a single receiver blocked, then close. Verify all waiters resolve.

#### 🟢 Nice to Have

**CT4. Concurrent producer/consumer test doesn't verify ordering under contention**

The test sends 1000 items and receives 1000, but only checks first and last. A full ordering check (`received[i] === i` for all i) would be stronger.

---

### `test/unit/core/broadcaster.test.ts`

Tests are strong. Good coverage of the core scenarios: fan-out, copy independence, overflow isolation, remove consumer, close-all, zero consumers.

#### 🟢 Nice to Have

**BT1. No test for adding a consumer mid-broadcast**

Start broadcasting, add a new consumer after some items, verify it only receives items sent after it was added.

**BT2. No test for `broadcast()` to a closed consumer channel**

If one consumer's channel is closed but not removed from the broadcaster, does `broadcast()` handle it gracefully? Currently `channel.send()` returns `false` for closed channels — the broadcaster ignores the return value.

**Impact:** Not a crash bug, but the broadcaster silently sends to a dead channel forever. Consider checking the return value or having the broadcaster auto-remove closed channels.

---

### `test/unit/core/ticker.test.ts`

#### 🟡 Should Fix

**TT1. No test for aligned mode**

See T6 above. Need a test that verifies aligned ticks fire at clock boundaries.

**TT2. No test for offset option**

See T5 above.

**TT3. No test for clock jump detection**

The core differentiator of the dual-clock design is untested. This is hard to test without mocking, but possible approaches:
- Mock `Bun.nanoseconds()` (if possible in Bun's test runner)
- Use a dependency-injected clock interface
- At minimum, test the detection logic in isolation

**Impact:** The most complex logic in the ticker — the reason for the dual-clock design — has zero test coverage. This is a significant gap.

#### 🟢 Nice to Have

**TT4. Timing tests have wide tolerances**

The jitter test accepts spacings of [140, 270] for a 200ms interval with 50ms jitter. The drift test accepts ±500ms on 2500ms expected. These tolerances are necessary for CI reliability but mean the tests would still pass with significant drift bugs.

---

### `test/integration/channel-metric.test.ts`

Strong integration tests. The three scenarios (bulk metrics through channel, broadcaster copy independence, hashId preservation) cover the key integration points well.

#### 🟢 Nice to Have

**IT1. No integration test for overflow with metrics**

Channel overflow with drop-oldest using actual Metric objects — verify the dropped metrics are the oldest and the surviving metrics have correct data.

---

## PRD Deviations

| # | Deviation | PRD Says | Implementation Does | Severity |
|---|-----------|----------|-------------------|----------|
| **D1** | Missing `overflow` option | `ChannelOptions` has `overflow: 'drop-oldest' \| 'block'` | Only `capacity` in options | 🔴 Interface mismatch |
| **D2** | Aligned mode default | "Aligned mode (default)" | `aligned` defaults to `false` | 🟡 Behaviour mismatch |
| **D3** | Clock jump detection | "wall clock and monotonic clock disagree" | Compares monotonic vs expected (seq-based) | 🔴 Wrong comparison |
| **D4** | Clock jump logging | "A warning is logged for visibility" | Silent re-anchor | 🟡 Missing observability |
| **D5** | Timestamp auto-assign | "monotonic time adjusted by [wall-clock] offset" | `Date.now()` only | 🟢 Not `createMetric`'s job |
| **D6** | PRD pseudocode bug | Prose says wall vs mono; code says mono vs expected | Implementation matches pseudocode, not prose | 🔴 Spec ambiguity |

---

## Missing Test Coverage Summary

### Must Have (before Phase 2)
1. **Clock jump detection** (ticker) — the core dual-clock feature is untested
2. **Aligned mode end-to-end** (ticker) — PRD default mode, never tested
3. **Offset option** (ticker) — implemented but untested
4. **Capacity=1 channel** — degenerate ring buffer case
5. **hashId with empty tags** — base case
6. **hashId unchanged by field differences** — confirms fields excluded from hash

### Should Have
7. **hashId stability across tag mutation cycles** (add then remove)
8. **copy() then mutate → different hashId**
9. **Broadcast to closed consumer** — graceful handling
10. **Send-after-close with buffered items** — graceful shutdown path

---

## Positive Observations

1. **TypeScript strict mode is properly configured** — `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`. No `any` types anywhere. The codebase is genuinely type-safe.

2. **Clean, minimal API surface** — The interfaces match the PRD closely. `createMetric()` factory with sensible defaults is a good pattern. Channel's `send/receive/close` is exactly right.

3. **Ring buffer implementation is correct** — Head/tail pointer arithmetic with modular indexing, proper GC-friendly `undefined` assignment on consume. No off-by-one errors. The overflow behaviour (drop-oldest) works correctly including the edge case of sending capacity+N items.

4. **FNV-64a hash is correctly implemented** — Constants match the FNV spec. Byte-level hashing via TextEncoder avoids string encoding ambiguities. Sorted tags ensure deterministic hash across insertion orders.

5. **Broadcaster fan-out isolation is well-designed** — Each consumer has its own channel with independent overflow. The `copy` function parameter is a clean way to handle deep copy at the broadcast level. The tests verify this isolation thoroughly.

6. **Test quality is genuinely good** — Tests verify meaningful behaviour, not just "code doesn't crash." The overflow test (send capacity+5, verify last N), the Broadcaster isolation test (small channel drops while large channels keep all), and the integration tests (mutate copy, verify original unchanged) all test real correctness properties.

7. **Anchor-based tick calculation** — Computing each tick from anchor+seq*interval rather than previous_tick+interval is the right approach for eliminating drift accumulation. The test verifying 50 ticks at 50ms ≈ 2500ms confirms this.

8. **Memory-conscious design** — No `structuredClone()`, hand-rolled copy, ring buffer reuse, `undefined` assignment for GC. Good fit for RPi4 24/7 operation.

9. **All 41 tests pass cleanly** — No flaky tests, no skipped tests, clean output.

---

## Recommended Fix Priority

### Before Phase 2 starts:
1. **T1/D3** — Fix clock jump detection to compare wall vs monotonic (not mono vs expected)
2. **C1/D1** — Add `overflow` field to `ChannelOptions` (accept but only implement `drop-oldest`)
3. **D2** — Decide: should `aligned` default to `true` per PRD, or update PRD? Document the decision.
4. **T5/T6/TT1/TT2** — Add tests for aligned mode and offset
5. **M3** — Add TODO comments on tracking methods
6. **M1** — Add invariant comment on `copy()` re: primitive-only FieldValue

### Can be deferred to Phase 2:
- M5 (hashId memoisation)
- C3 (async send micro-optimisation)
- C4 (multiple receiver guard)
- C7 (drop counter)
- T7 (class vs function)
- T8/D4 (clock jump logging — needs logging framework)
- BT2 (broadcast to closed channel)
