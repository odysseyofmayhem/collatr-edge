# Phase 1 Core Review v2 — Post-Fix Verification

**Reviewer:** Dex (automated code review)
**Date:** 2026-02-23
**Commit:** `81a8ddb` (phase-1: address code review findings)
**Previous review:** `plans/phase-1-review.md`
**Test run:** 55/55 pass, 158 assertions, 6.06s (+14 tests, +29 assertions vs v1)

---

## Overall Assessment: 🟢 GO — All Must-Fix Items Resolved

Every 🔴 Must Fix from the original review has been addressed. The fixes are correct and well-implemented. Test coverage went from 41 → 55 tests, and critically, the *hard paths* (clock jump detection, aligned mode, offset) now have dedicated tests. Two minor items remain for future phases; nothing blocks Phase 2.

---

## Verification: Original 🔴 Must Fix Items

### T1/D3/D6: Clock jump detection — ✅ FIXED CORRECTLY

**Original finding:** Compared monotonic elapsed vs expected elapsed (seq-based). Should compare wall clock elapsed vs monotonic elapsed.

**What changed:**
```typescript
// Before (wrong):
const monoElapsedMs = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
const expectedElapsedMs = seq * interval;
if (Math.abs(monoElapsedMs - expectedElapsedMs) > interval * 2)

// After (correct):
const wallElapsedMs = Date.now() - anchor;
const monoElapsedMs = Number(Bun.nanoseconds() - monotonicAnchor) / 1_000_000;
if (seq > 0 && detectClockJump(wallElapsedMs, monoElapsedMs, interval))
```

**Verification:** The comparison is now wall vs mono, exactly as the PRD prose specifies. Additionally:
- The detection logic was extracted into `detectClockJump()` and exported — good for testability (Rule 9)
- The PRD pseudocode contradiction is documented in a code comment citing CLAUDE.md Rule 5: "NOTE: PRD §13 pseudocode compares monotonic vs expected elapsed time, but the prose says 'wall clock and monotonic clock disagree'. The prose is authoritative."
- 4 dedicated tests cover: agreement, within-tolerance, jump detected, threshold scaling with interval

**Quality of fix:** Excellent. The extracted function makes the clock jump logic independently testable without mocking Bun internals. The PRD discrepancy comment is exactly what Rule 5 asks for.

### C1/D1: Missing `overflow` option on ChannelOptions — ✅ FIXED CORRECTLY

**Original finding:** PRD defines `overflow: 'drop-oldest' | 'block'` in ChannelOptions. Field was missing.

**What changed:**
```typescript
export type OverflowPolicy = "drop-oldest" | "block";

export interface ChannelOptions {
  capacity: number;
  overflow: OverflowPolicy;  // new field
}
```

Constructor now accepts `overflow`, stores it, and throws on `"block"`:
```typescript
this._overflow = options?.overflow ?? "drop-oldest";
if (this._overflow === "block") {
  throw new Error('Channel overflow policy "block" is not implemented (post-MVP)...');
}
```

**Verification:** Interface matches PRD. Default is `"drop-oldest"`. Passing `"block"` throws with a clear error. Two new tests verify both paths. The `OverflowPolicy` type is exported for downstream use. ✅

### D2: Aligned mode default — ✅ FIXED CORRECTLY

**Original finding:** `aligned` defaulted to `false`, PRD says "Aligned mode (default)".

**What changed:**
```typescript
// Before:
const aligned = opts?.aligned ?? false;

// After:
const aligned = opts?.aligned ?? true; // PRD §13: "Aligned mode (default)"
```

**Verification:** Default is now `true` with a PRD reference comment. All existing ticker tests were updated to pass `aligned: false` explicitly so they test unaligned behaviour as intended. New aligned-mode test verifies ticks fire near clock boundaries. ✅

### M1: `copy()` invariant documentation — ✅ FIXED

**What changed:** JSDoc comment on `copy()` now documents:
- Safe because all FieldValue types are primitives
- Must be updated if FieldValue is extended to reference types
- Tracking state deliberately not copied (new data point in pipeline)

**Verification:** Comment is clear and actionable. ✅

### M2: `copy()` tracking state decision — ✅ DOCUMENTED

**What changed:** Comment explicitly states: "Tracking state (_accepted/_rejected/_dropped) is deliberately NOT copied. A copy is a new data point in the pipeline with its own delivery lifecycle."

**Verification:** The decision is documented as recommended. ✅

### M3: Tracking methods TODO — ✅ FIXED

**What changed:** Comment above `accept()`:
```typescript
// TODO: Phase 2 — integrate with delivery tracking / buffer manager.
// These flags are currently write-only. They will be read by the buffer
// manager to track end-to-end delivery status per metric.
```

**Verification:** Clear, actionable TODO with phase reference. ✅

---

## Verification: Original 🟡 Should Fix Items

### M4: `addTag()` re-sort comment — ✅ ADDED
Comment now reads: "Re-sort to maintain sorted invariant. O(N log N) per call — acceptable for small tag sets typical in IIoT (rarely >10 tags)."

### M6: `hashId()` serialisation assumption — ✅ DOCUMENTED
Comment: "Assumes metric names don't contain \0 and tag keys don't contain '='. These are safe assumptions for IIoT metric naming conventions."

### T5: Offset tests — ✅ ADDED
New test: "offset delays ticks by the specified amount" — verifies first tick is delayed by ~50ms and spacing remains ~interval.

### T6/TT1: Aligned mode test — ✅ ADDED
New test: "aligned ticks fire at clock boundaries (default mode)" — verifies each tick time is near a multiple of interval, with 30ms tolerance.

### TT3: Clock jump detection tests — ✅ ADDED (4 tests)
- `no jump when wall and monotonic agree`
- `no jump within 2x interval tolerance`
- `jump detected when clocks disagree by >2x interval` (3 scenarios: forward, NTP, backward)
- `threshold scales with interval`

### CT1: Capacity=1 test — ✅ ADDED
"capacity=1: every send to full channel replaces the single item" — verifies ring buffer wraparound at degenerate boundary.

### CT2: Send-after-close test — ✅ ADDED
"send-after-close returns false and buffered items are still receivable" — verifies graceful shutdown path.

### MT1: hashId empty tags — ✅ ADDED
"works with empty tags (base case)" — verifies base case of serialisation format.

### MT4: hashId field-independent — ✅ ADDED
"unchanged by field value differences (fields excluded from hash)" — confirms fields don't affect hash with different types and counts.

### MT2: hashId mutation stability — ✅ ADDED
"stable across tag mutation cycles (add then remove)" — add tag, verify hash changes, remove tag, verify hash returns to original.

### MT3: copy→mutate→different hashId — ✅ ADDED
"copy then mutate tags → different hashId" — the key correctness property for aggregator grouping.

---

## Items Not Addressed (expected — deferred per original review)

These were categorised as "Can be deferred to Phase 2" and are correctly not addressed in this commit:

| Item | Status | Notes |
|------|--------|-------|
| M5: hashId memoisation | Deferred | Performance optimisation, not correctness |
| C3: async send micro-optimisation | Deferred | Promise allocation overhead, marginal |
| C4: Multiple receiver guard | Deferred | Would be nice, not blocking |
| C7: Drop counter for observability | Deferred | Needs agent self-metrics framework |
| T7: Ticker class vs function | Deferred | API aesthetics, not correctness |
| T8/D4: Clock jump logging | Deferred | TODO comment added: "Deferred until logging framework is integrated" ✅ |
| BT2: Broadcast to closed channel | Deferred | Edge case, non-crashing |

---

## New Observations on the Fix Commit

### 🟢 Positives

1. **`detectClockJump` extraction is smart.** By pulling the comparison into a pure exported function, the agent made the most critical logic unit-testable without needing to mock `Bun.nanoseconds()` or `Date.now()`. The 4 tests on this function are clean and cover all the important cases. This is exactly what Rule 9 calls for.

2. **Existing tests updated correctly.** All pre-existing ticker tests now pass `aligned: false` explicitly since the default changed. No tests were deleted or weakened — they were adapted to the new default. Good discipline.

3. **Aligned mode test uses a sound approach.** Checking `time % interval` with tolerance bands is the right way to verify clock alignment without depending on exact timing.

4. **Progress doc is thorough.** `phase-1-progress.md` now has a detailed "Review Fixes" section documenting every change with the original finding ID. This makes the review trail auditable.

5. **14 new tests target exactly the gaps identified.** No filler tests — every new test corresponds to a specific finding from the review.

### 🟡 Minor Observations

1. **Offset test tolerance is generous.** First tick expected at 40-100ms for a 50ms offset. The wide band is necessary for CI reliability but wouldn't catch an off-by-2x bug (e.g., offset applied twice → 100ms). Not worth changing — timing tests inherently need tolerance — but worth noting.

2. **Clock jump detection isn't tested end-to-end in the ticker.** The `detectClockJump` unit tests are solid, but no test actually forces a clock jump mid-tick-loop and verifies the ticker re-anchors. This would require mocking `Date.now()` which Bun's test runner doesn't easily support. Acceptable — the unit tests on the extracted function give sufficient confidence.

3. **`OverflowPolicy` type is exported but `overflow` getter is not.** The Channel stores `_overflow` but doesn't expose it as a readable property. Not a problem now (nothing reads it), but if downstream code needs to check a channel's overflow policy, a getter will be needed.

---

## Final Verdict

**All 🔴 Must Fix items: RESOLVED ✅**
**All 🟡 Should Fix items addressed in this commit: RESOLVED ✅**
**Deferred items: correctly deferred with TODOs ✅**
**Test suite: 55/55 pass, 158 assertions ✅**
**No regressions detected ✅**

Phase 1 core is ready for Phase 2 to build on.
