# Phase 2 Review — Tasks 2.0 and 2.1 (+2.1i)

**Reviewer:** Dex (sub-agent code review)
**Date:** 2026-02-23
**Scope:** Task 2.0 (ServiceInput runtime support), Task 2.1 (Modbus TCP input), Task 2.1i (Modbus integration tests)
**Test run:** 154/154 pass, 509 assertions, 15.45s

---

## Overall Assessment: ✅ SOLID — Two Must-Fix Items

Tasks 2.0 and 2.1 are well-implemented. The Modbus plugin covers all four function codes, all four byte orders, batch optimization, shared mode, exception handling with per-register disabling, and reconnection logic. The ServiceInput runtime support is correctly integrated into the pipeline lifecycle with proper startup/shutdown ordering. The test suite covers the hard paths that matter (exception codes, byte orders, reconnection, batch grouping).

Two must-fix items, three should-fix items, and a few nice-to-haves are documented below.

---

## File-by-File Findings

### `src/core/plugin-types.ts` — isServiceInput() type guard

**Status:** ✅ Clean

- Interfaces match PRD Appendix B exactly (field-by-field verified)
- `Input`, `ServiceInput`, `Processor`, `Aggregator`, `Output`, `StatefulPlugin` all present
- `ServiceInput extends Input` — correct, PRD shows it inherits `gather()`
- `isServiceInput()` uses duck-typing (`typeof start === "function" && typeof stop === "function"`) — correct approach for structural typing

**No findings.**

---

### `src/pipeline/runtime.ts` — ServiceInput lifecycle + metric_batch_size

**Status:** ⚠️ Two should-fix items

#### 🟡 R1 — `drop_original` comment says `.some()` but code uses `.every()` — comment is stale

**Location:** Lines 149–157

The code correctly uses `.every()` (only drop originals if ALL aggregators want it), which is the safer behaviour. But the comment says:

> "If ANY aggregator has dropOriginal=true, ALL originals are suppressed"

This describes the old `.some()` bug from Phase 1. The code was fixed but the comment wasn't updated. The comment is now actively misleading.

**Fix:** Update comment to match the actual `every()` behaviour.

---

#### 🟡 R2 — ServiceInput `stop()` errors are caught but failed starts aren't tracked for shutdown

**Location:** Lines 357–363 (`start`) and 371–378 (`stop`)

When a ServiceInput's `start()` throws, the error is caught and logged — good. But the plugin is NOT added to `this.serviceInputs`, which means `close()` is never called on it during shutdown.

Looking at the shutdown sequence (lines 386–389), `close()` is called via `this.options.inputs` (ALL inputs), not just `this.serviceInputs`. So the plugin WILL get `close()` called. **This is actually fine.** The `stop()` call is what's skipped for failed service inputs, which is correct since they never started.

**No bug here** — my initial read was wrong. The code is correct because:
1. `stop()` only called on successfully started service inputs (tracked in `this.serviceInputs`)
2. `close()` called on ALL inputs regardless (via `this.options.inputs` loop)

This is the correct distinction. **Retracted.**

---

#### 🟡 R2 (actual) — Output flush loop final flush doesn't respect `metricBatchSize` splitting consistently

**Location:** Lines 277–291 (final flush in `runOutputFlushLoop`)

The regular flush path (line 265) calls `writeBatch()` which handles `metricBatchSize` splitting with error handling and re-queuing. But the final flush path (lines 282–290) duplicates the batch-splitting logic inline WITHOUT the error re-queuing (failed metrics are lost on final flush).

This is acceptable for MVP (final flush is best-effort during shutdown), but the code duplication creates a maintenance risk. The final flush should call `writeBatch()` directly — or at minimum have a comment explaining why it doesn't.

**Fix:** Either call `writeBatch()` for final flush, or add a comment explaining the intentional difference (final flush can't re-queue because there's no next cycle).

---

### `test/unit/pipeline/service-input.test.ts` — ServiceInput tests

**Status:** ✅ Good coverage

Tests cover all planned scenarios from the Phase 2 plan:
- ✅ ServiceInput `start()` called during startup
- ✅ ServiceInput pushes metrics asynchronously → output receives them
- ✅ ServiceInput `stop()` called during shutdown
- ✅ Mixed pipeline: polling + service input, both produce output
- ✅ ServiceInput `start()` error: logged, pipeline continues
- ✅ `isServiceInput()` type guard: positive, negative, partial objects
- ✅ `metric_batch_size`: large batch split into chunks ≤ limit
- ✅ `metric_batch_size`: without limit, single call with all metrics

#### 🟢 N1 — Test could verify shutdown ordering more precisely

The "stop() called during shutdown before channel close" test verifies `stopped` and `closed` are both true, but doesn't prove the ordering (stop THEN close). A more precise test would record timestamps or call order. Not critical — the runtime code is clear and correct.

---

### `src/plugins/inputs/modbus.ts` — Modbus TCP input implementation

**Status:** ⚠️ Two must-fix items, one should-fix

#### 🔴 M1 — No test for batch read failure → individual read fallback

**Location:** Lines 244–260 (`readRegistersForSlave`)

The code correctly implements the PRD requirement:

> "Batch reads: if a batch read fails, fall back to individual register reads to isolate which specific register(s) caused the error."

When a batch read fails and the batch has >1 member, it falls back to `readSingleRegister()` per member. This is critical PRD behaviour, but **there is no test exercising this path.** This violates Rule 9 ("Test the Hard Paths First").

**Fix:** Add a unit test where a batch read (e.g., registers 100–102 in one group) throws an error on the batch read, but individual reads succeed for 100 and 102 while 101 throws a Modbus exception. Verify:
1. Batch read was attempted first (single FC03 call)
2. Fallback to individual reads happened (3 separate FC03 calls)
3. Good registers (100, 102) emitted metrics
4. Bad register (101) properly handled (disabled or retried per exception code)

---

#### 🔴 M2 — FC02 (discrete inputs) has no dedicated test

**Location:** `readBatch()` lines 271–278

The code has a distinct path for `readDiscreteInputs()` (FC02), but the test file has zero tests for discrete input registers. FC01 (coils) is tested, FC03 (holding) is thoroughly tested, FC04 (input) is tested — but FC02 is only present in mock setup code, never exercised.

**Fix:** Add a test similar to the coil test but for discrete inputs:
```typescript
it("read discrete input (FC02) → boolean value", async () => {
  // Set up discrete inputs, verify correct boolean values
});
```

---

#### 🟡 R3 — `describe()` missing on `max_batch_size` in Zod schema

**Location:** Line 42

PRD schema has:
```typescript
max_batch_size: z.number().int().min(1).max(125).default(125)
    .describe('Max registers per batch read (Modbus spec limit: 125 for FC03)'),
```

Implementation has:
```typescript
max_batch_size: z.number().int().min(1).max(125).default(125),
```

The `.describe()` is used for documentation generation and Web UI config forms. Missing it breaks the plugin manifest pipeline described in PRD §6.

**Fix:** Add `.describe('Max registers per batch read (Modbus spec limit: 125 for FC03)')`.

---

#### 🟢 N2 — Per-register byte_order override not tested

**Location:** `decodeRegisterValue()` line 305: `config.byte_order ?? this.config.byte_order`

The code correctly falls back from per-register `byte_order` to plugin-level `byte_order`. This is a PRD requirement ("Per-register byte order override for mixed-vendor setups"). But no test exercises a per-register override — all byte order tests set the plugin-level default.

**Fix (nice-to-have):** Add one test with `byte_order: "ABCD"` at plugin level and one register overriding to `"CDAB"`.

---

#### 🟢 N3 — Exception codes 01, 03, 05, 06, 08, 0A, 0B not individually tested

**Location:** `handleRegisterError()` lines 325–350

Exception 02 (Illegal Address) is tested for disable behaviour. Exception 04 (Slave Failure) is tested for retry behaviour. But the other codes in the PRD table are not individually tested:
- 01 (Illegal Function) → disable (same as 02, 03)
- 03 (Illegal Data Value) → disable (same as 01, 02)
- 05 (Acknowledge) → retry
- 06 (Slave Busy) → retry
- 08 (Memory Parity) → retry
- 0A (Gateway Path Unavailable) → retry
- 0B (Gateway Target Failed) → retry

The code uses Set lookups (`DISABLE_EXCEPTIONS`, `RETRY_EXCEPTIONS`), so testing 02 and 04 proves the Set-lookup mechanism works. But verifying the Sets contain the correct codes requires either inspecting the code or testing each code.

**Fix (nice-to-have):** Add a parametrized test that loops over all PRD exception codes and verifies the correct behaviour (disable vs retry). This is more thorough than individual tests:

```typescript
it.each([
  [0x01, "disable"], [0x02, "disable"], [0x03, "disable"],
  [0x04, "retry"], [0x05, "retry"], [0x06, "retry"],
  [0x08, "retry"], [0x0A, "retry"], [0x0B, "retry"],
])("exception 0x%x → %s", async (code, behaviour) => { ... });
```

---

#### 🟢 N4 — No config validation for mutual exclusivity of `registers` vs `slaves`

The PRD schema implies `registers` is for dedicated mode and `slaves` is for shared mode. The current schema allows both simultaneously, which could cause confusion. A Zod `.refine()` could enforce:
- If `connection_mode === "shared"`, `slaves` must be present, `registers` should be ignored/rejected
- If `connection_mode === "dedicated"`, `registers` should be present, `slaves` should be ignored

Not a bug (the code handles both correctly by checking `connection_mode` first in `initRegisterStates`), but a config validation improvement.

---

### `test/unit/plugins/inputs/modbus.test.ts` — Modbus unit tests

**Status:** ✅ Good — thorough mock, clear structure

The `MockModbusClient` is well-designed:
- Tracks all read calls with method/slaveId/address/count for assertion
- Supports per-read error injection via `throwOnRead` map
- Supports connection drop simulation via `disconnectAfterReads`
- Properly separates per-slave data stores
- Buffer generation matches Modbus wire format (big-endian register values)

Float32 test values are computed dynamically using IEEE 754 precision — no magic numbers, no rounding surprises.

**Minor note:** The `mkReg` helper in `groupIntoBatches` tests uses `any` type annotation. This is acceptable per CLAUDE.md ("No `any` except in test fixtures where typing adds no value").

---

### `test/integration/modbus-pipeline.test.ts` — Modbus integration tests

**Status:** ✅ Good — verifies end-to-end data flow

Three integration tests:
1. ✅ Metrics have correct register names and values (including scaling)
2. ✅ Global tags AND slave_id tag present on output metrics
3. ✅ Multiple registers produce multiple metrics per gather cycle

The integration tests verify the full path: ModbusInput → ChannelAccumulator → Channel → MainLoop → Broadcaster → OutputChannel → MockOutput. This catches interface mismatches between the Modbus plugin and the pipeline runtime.

#### 🟢 N5 — No integration test for error scenarios

Integration tests are all happy-path. Adding one error scenario (e.g., register exception flowing through pipeline without crashing) would increase confidence. Not critical since unit tests cover error handling thoroughly.

---

## PRD Compliance Table — Modbus TCP Input

| PRD Requirement | Status | Notes |
|---|---|---|
| Config schema: `controller` (string, required) | ✅ | Present, with `.describe()` |
| Config schema: `connection_mode` (dedicated/shared, default dedicated) | ✅ | Correct enum, correct default |
| Config schema: `slave_id` (1–247, default 1) | ✅ | Correct range and default |
| Config schema: `registers` array | ✅ | Optional, matches register schema |
| Config schema: `slaves` array (shared mode) | ✅ | Correct sub-schema |
| Config schema: `byte_order` (ABCD/CDAB/BADC/DCBA, default ABCD) | ✅ | Correct enum and default |
| Config schema: `optimization` (none/batch, default batch) | ✅ | Correct |
| Config schema: `max_batch_size` (1–125, default 125) | ✅ | Correct range and default |
| Config schema: `max_gap` (≥0, default 10) | ✅ | Correct |
| Config schema: `timeout` (string, default "5s") | ✅ | Correct |
| Register: `address`, `name`, `type`, `data_type`, `byte_order`, `scale`, `offset`, `bit` | ✅ | All fields present with correct types and defaults |
| Read-only constraint (FC01–04 only) | ✅ | No write methods. SAFETY comment at top. |
| FC01 (coils) | ✅ | Implemented + tested |
| FC02 (discrete inputs) | ⚠️ | Implemented, **NOT tested** (🔴 M2) |
| FC03 (holding registers) | ✅ | Implemented + thoroughly tested |
| FC04 (input registers) | ✅ | Implemented + tested |
| Byte order: ABCD, CDAB, BADC, DCBA for 32-bit types | ✅ | All four tested for float32. uint32 tested for ABCD. int32 tested for ABCD. |
| Per-register byte order override | ⚠️ | Code implemented, **not tested** (🟢 N2) |
| Scaling: `output = raw * scale + offset` | ✅ | Implemented + tested (8550 * 0.01 = 85.5) |
| Bit extraction (bit 0–15 → boolean) | ✅ | Implemented + tested |
| Batch reads: contiguous registers in single request | ✅ | Implemented + tested |
| Gap handling: split when gap > max_gap | ✅ | Implemented + tested |
| Batch fallback: batch fail → individual reads | ⚠️ | Code implemented, **NOT tested** (🔴 M1) |
| Shared mode: single TCP, multiple slave IDs | ✅ | Implemented + tested |
| Exception 01 (Illegal Function) → disable register | ✅ | In `DISABLE_EXCEPTIONS` set. Not individually tested. |
| Exception 02 (Illegal Address) → disable register | ✅ | Tested |
| Exception 03 (Illegal Data Value) → disable register | ✅ | In `DISABLE_EXCEPTIONS` set. Not individually tested. |
| Exception 04 (Slave Failure) → retry | ✅ | Tested |
| Exception 05 (Acknowledge) → retry | ✅ | In `RETRY_EXCEPTIONS` set. Not individually tested. |
| Exception 06 (Slave Busy) → retry | ✅ | In `RETRY_EXCEPTIONS` set. Not individually tested. |
| Exception 08 (Memory Parity) → retry | ✅ | In `RETRY_EXCEPTIONS` set. Not individually tested. |
| Exception 0A (Gateway Path Unavailable) → retry | ✅ | In `RETRY_EXCEPTIONS` set. Not individually tested. |
| Exception 0B (Gateway Target Failed) → retry | ✅ | In `RETRY_EXCEPTIONS` set. Not individually tested. |
| Timeout → retry | ✅ | Connection error handling covers this |
| Disabled register: stop polling, others continue | ✅ | Tested (second gather skips disabled register) |
| Reconnection on connection loss | ✅ | Implemented + tested |
| `.describe()` on `max_batch_size` | ❌ | Missing (🟡 R3) |

---

## Test Coverage Assessment

### Task 2.0 — ServiceInput Runtime Support

| Test Area | Covered? | Notes |
|---|---|---|
| `isServiceInput()` type guard: positive | ✅ | |
| `isServiceInput()` type guard: negative | ✅ | |
| `isServiceInput()` type guard: partial objects | ✅ | Both start-only and stop-only |
| ServiceInput `start()` called at startup | ✅ | |
| ServiceInput async push → output receives | ✅ | |
| ServiceInput `stop()` called at shutdown | ✅ | |
| Mixed pipeline (polling + service) | ✅ | |
| ServiceInput `start()` error handling | ✅ | Pipeline continues |
| `metric_batch_size` splitting | ✅ | |
| `metric_batch_size` absent (no splitting) | ✅ | |

**Assessment:** Excellent. All planned scenarios from Phase 2 plan are tested.

### Task 2.1 — Modbus TCP Input

| Test Area | Covered? | Notes |
|---|---|---|
| FC01 (coils) read | ✅ | |
| FC02 (discrete inputs) read | ❌ | **🔴 M2** |
| FC03 (holding registers) read | ✅ | |
| FC04 (input registers) read | ✅ | |
| Float32 all 4 byte orders | ✅ | ABCD, CDAB, BADC, DCBA |
| uint32 | ✅ | ABCD only |
| int32 | ✅ | ABCD only |
| int16 (signed) | ✅ | Via scaling test |
| Scaling | ✅ | Two examples |
| Bit extraction | ✅ | Bit 8 (on) + bit 0 (off) |
| Batch read (contiguous) | ✅ | |
| Gap split | ✅ | |
| Batch read fail → fallback | ❌ | **🔴 M1** |
| Shared mode (multi-slave) | ✅ | |
| Exception → disable (02) | ✅ | |
| Exception → retry (04) | ✅ | |
| All 9 exception codes | ⚠️ | Only 2 tested; others inferred from Set membership |
| Connection timeout | ✅ | |
| Reconnection after drop | ✅ | |
| Config validation (missing controller) | ✅ | |
| Config validation (slave_id out of range) | ✅ | |
| Per-register byte_order override | ❌ | Code works, not tested |
| `decodeMultiRegister()` unit tests | ✅ | All byte orders for float32, uint32, int32 |
| `groupIntoBatches()` unit tests | ✅ | 6 scenarios including disabled regs |

**Assessment:** Good overall. Two untested code paths (batch fallback, FC02) are must-fix. Per-register byte order override and remaining exception codes are nice-to-have.

---

## Rules Compliance Summary

| Rule | Status | Notes |
|---|---|---|
| Rule 1 (No hand-waving) | ✅ | All 154 tests pass. No skipped tests. |
| Rule 2 (Tests prove behaviour) | ✅ | Tests focus on data correctness, failure modes, contracts. |
| Rule 3 (Small verified steps) | ✅ | Commit history shows incremental progress. |
| Rule 5 (PRD is the spec) | ✅ | Config schema matches PRD field-by-field. |
| Rule 8 (Interface compliance) | ✅ | All plugin interfaces match PRD Appendix B. Schema matches PRD §6. One `.describe()` missing. |
| Rule 9 (Hard paths first) | ⚠️ | Batch fallback (critical PRD requirement) untested. FC02 path untested. |
| Rule 10 (No hardcoded overrides) | ✅ | All config values wired from parsed config. Defaults match PRD. |
| Rule 11 (Async error handling) | ✅ | `gather()` errors caught. `connect()` errors caught. Per-register errors handled. Connection drops detected. |
| Rule 12 (Lifecycle ordering) | ✅ | PRD §8: outputs connected → service inputs started → gather loops started. Shutdown: stop service inputs → close channels → drain → close outputs. |
| Rule 13 (Per-instance semantics) | ✅ | Per-register disabling. Per-slave register states. Per-register byte order. Shared mode is per-slave. |

---

## Summary — Fix Priorities

### 🔴 Must Fix (before continuing Phase 2)

1. **M1 — Batch fallback not tested:** Add test for batch read failure → individual register fallback. This is a critical PRD requirement with zero test coverage.

2. **M2 — FC02 (discrete inputs) not tested:** Add dedicated test for discrete input register reads. The code path exists but is unverified.

### 🟡 Should Fix (during Phase 2)

3. **R1 — Stale `drop_original` comment in runtime.ts:** Update the comment on lines 149–155 to match the actual `every()` behaviour.

4. **R2 — Final flush code duplication in output flush loop:** Extract or unify the final flush path to call `writeBatch()`, or document why it's intentionally different.

5. **R3 — Missing `.describe()` on `max_batch_size`:** Add for plugin manifest compatibility.

### 🟢 Nice to Have

6. **N1 — ServiceInput shutdown ordering test precision:** Record call order to prove stop() before close().
7. **N2 — Per-register byte_order override test:** One test with plugin-level ABCD + register-level CDAB.
8. **N3 — Parametrized exception code test:** Loop over all 9 PRD exception codes verifying disable vs retry.
9. **N4 — Config mutual exclusivity validation:** Zod `.refine()` for registers vs slaves based on connection_mode.
10. **N5 — Integration test for error scenarios:** One error-path integration test.
