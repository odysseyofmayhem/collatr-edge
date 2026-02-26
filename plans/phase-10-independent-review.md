# Phase 10 Independent Review — MQTT Data Format Hardening

**Reviewer:** Dex (with sub-agent analysis)
**Date:** 2026-02-26
**Scope:** All Phase 10 commits (4dfc699..f59719e), 5 implementation tasks
**Verdict:** GO — no blockers, 2 should-fix, 4 nice-to-have

---

## Summary

Phase 10 adds `data_format = "auto"` (try JSON, silent fallback to value) and `data_format = "string"` (always string, no coercion) to the MQTT consumer input plugin. It also implements parse error throttling to prevent log flooding from wildcard subscriptions on public brokers receiving non-JSON payloads.

The implementation is clean, well-tested (19 new tests, 1003 total), and closely follows the plan with one justified deviation (omitting `since_last_summary` from the throttled summary log — the plan's calculation was incorrect). The code is correct for all tested paths. The independent sub-agent verified edge cases by running actual JS evaluation for `Number()`, `JSON.parse()`, and binary detection behaviour.

No must-fix issues found. Two should-fix items identified (one new, one agreeing with the internal review). Phase 11 is not blocked.

---

## Code Review Findings

### 🔴 Must Fix (blocks Phase 11)

None.

---

### 🟡 Y-1: `Number()` accepts hex, octal, binary literals and `Infinity` (NEW — internal review missed this)

**File:** `src/plugins/inputs/mqtt-consumer.ts`, lines 355-358 (auto fallback) and lines 369-372 (value mode)
**Rule:** Observation / correctness

The `Number()` conversion in both `auto` fallback and `value` mode accepts JavaScript numeric literal formats that are unlikely to represent IIoT data:

```js
Number("0x1F")     → 31       // hex literal
Number("0o77")     → 63       // octal literal
Number("0b1010")   → 10       // binary literal
Number("Infinity") → Infinity // infinity
Number("-Infinity") → -Infinity
```

A payload of `"0x1F"` on an MQTT topic would be stored as the number `31`, which may be unexpected. More critically, `Infinity` and `-Infinity` would pass the `!isNaN()` check and be stored as `Infinity` — which is a valid IEEE 754 value but likely corrupts downstream aggregations (mean of `[23.5, Infinity]` = `Infinity`).

**Recommendation:** Add a `isFinite()` guard alongside `!isNaN()`:
```typescript
if (!isNaN(num) && isFinite(num) && payloadStr.trim() !== "") {
```
This blocks `Infinity`, `-Infinity`, and `NaN`. The hex/octal/binary literal issue is lower priority — these are vanishingly unlikely in real MQTT payloads.

**Severity:** 🟡 Should Fix. The `Infinity` case is the real concern. Hex/octal is cosmetic.

---

### 🟡 Y-2: Parse error counter never resets on reconnect (agrees with internal review SF-1)

**File:** `src/plugins/inputs/mqtt-consumer.ts`, lines 200-201
**Rule:** Observation / operational

The internal review correctly identified this: after reconnection (potentially to a different broker via failover), the error counter carries over. The first parse errors on the new connection are silenced if the old connection already exceeded the verbose threshold.

**Recommendation:** Reset `parseErrorCount` and `lastParseErrorLogTime` to 0 in the `onConnect` handler (line 250, where `reconnectAttempts` is already reset). This gives operators fresh verbose errors after each reconnection.

**Severity:** 🟡 Should Fix. Low effort (2 lines), meaningful operational improvement.

---

### 🟢 NH-1: No test for `auto` mode with JSON array payload (agrees with internal review)

**File:** `test/unit/plugins/inputs/mqtt-consumer.test.ts`

`JSON.parse("[1,2,3]")` succeeds, returns an array. The code enters `toFieldValue(parsed)` which calls `String([1,2,3])` → `"1,2,3"`. This is correct but untested in auto mode. The json-mode array tests cover the code path, but an explicit auto-mode test would document the expected behaviour.

---

### 🟢 NH-2: No test for `auto` mode with JSON boolean/null primitives (agrees with internal review)

`JSON.parse("true")` → `true`, `JSON.parse("null")` → `null`. Both handled correctly by `toFieldValue()`. No test coverage in auto mode for these paths.

---

### 🟢 NH-3: Smoke test config changes undocumented (agrees with internal review SF-2)

**File:** `configs/smoke-test-public.toml`

The plan (task 10.4) specified changing `data_format` and adding comments. The implementation also commented out `device/#`, `iot/#`, `collatr/smoke-test/#` topics and the entire Mosquitto broker section. These are likely practical noise reduction, but there's no inline comment explaining why. A one-liner would help: `# Disabled: too noisy for demos, re-enable for protocol testing`.

---

### 🟢 NH-4: `isBinary` detection runs on every message regardless of format

**File:** `src/plugins/inputs/mqtt-consumer.ts`, line 323

`const isBinary = payloadStr.includes("\uFFFD") || payloadStr.includes("\0")` runs for every message, even in `string` and `value` modes where it's never used. The performance cost is negligible (two `includes()` calls on a small string), but it's unnecessary work. Moving it inside the `json` and `auto` cases would be marginally cleaner.

Not worth changing — clarity of the current code is fine.

---

## PRD Compliance

| Requirement | Status | Notes |
|------------|--------|-------|
| §19: mqtt_consumer expanded description | ✅ PASS | All four formats + throttling documented |
| Appendix A: data_format comment | ✅ PASS | Inline comment lists all options |
| §6: Plugin error handling | ✅ PASS | Errors isolated per-plugin instance |
| §14: Error handling | ✅ PASS | Parse errors at warn, throttled |
| Schema default `"json"` preserved | ✅ PASS | Backward compatible |

---

## CLAUDE.md Rules Compliance

| Rule | Status | Notes |
|------|--------|-------|
| 1: No hand-waving | ✅ | All 1003 tests pass |
| 2: Tests prove behaviour | ✅ | 19 new tests, comprehensive coverage |
| 5: PRD is the spec | ✅ | PRD updated first (task 10.0) |
| 7: No premature abstraction | ✅ | No plugin hooks, no configurable thresholds |
| 8: Interface compliance | ✅ | Schema matches PRD exactly |
| 9: Test hard paths first | ✅ | Binary, throttle boundaries, per-instance all tested |
| 10: No hardcoded overrides | ✅ | All config-driven except throttle constants (YAGNI) |
| 11: Async error handling | ✅ | `handleMessage` is sync; `acc.addError()` guarded |
| 12: Lifecycle ordering | N/A | No lifecycle changes |
| 13: Per-instance, not global | ✅ | Instance fields, tested with two independent instances |

---

## Test Coverage Assessment

| Feature | Tests | Gaps |
|---------|-------|------|
| `auto`: JSON object | ✅ | — |
| `auto`: JSON primitive | ✅ | — |
| `auto`: non-JSON string fallback | ✅ | — |
| `auto`: numeric string fallback | ✅ | — |
| `auto`: binary fallback | ✅ | — |
| `auto`: silent (no acc.addError) | ✅ | — |
| `auto`: JSON array | ❌ | NH-1 |
| `auto`: JSON boolean/null | ❌ | NH-2 |
| `auto`: hex/Infinity string | ❌ | Y-1 |
| `string`: text | ✅ | — |
| `string`: numeric text | ✅ | — |
| `string`: empty | ✅ | — |
| Throttle: first 5 verbose | ✅ | — |
| Throttle: 6th summary | ✅ | — |
| Throttle: 7th-10th silent | ✅ | — |
| Throttle: 60s interval | ✅ | — |
| Throttle: valid after errors | ✅ | — |
| Throttle: per-instance | ✅ | — |
| Binary: all 4 formats | ✅ | — |
| Config: all 4 + invalid | ✅ | — |

19/19 planned tests implemented. 3 gap tests identified (all 🟢).

---

## Binary Payload Handling Assessment

The `isBinary` heuristic checks for `\uFFFD` (Unicode replacement character) and `\0` (null byte). This is a standard heuristic used by text editors and is appropriate for IIoT.

**Edge cases verified by sub-agent:**
- `\uFFFD` can appear in valid UTF-8 (U+FFFD is a real codepoint) — theoretical false positive, vanishingly unlikely in IIoT data
- `\0` in JSON payloads would cause `JSON.parse()` to fail anyway — the binary check is a fast-path optimization
- Binary detection correctly short-circuits in `auto` mode (direct string fallback) and throws explicit error in `json` mode (throttled)

**Verdict:** Heuristic is fit for purpose. The false positive risk (valid UTF-8 containing U+FFFD) was noted by both internal and independent review and deemed acceptable.

---

## Internal Review Quality Assessment

The internal review (`phase-10-review.md`) was thorough and well-structured. It covered:

- ✅ Complete PRD compliance table (10 requirements, all checked)
- ✅ Full CLAUDE.md rules compliance (12 rules checked)
- ✅ Comprehensive error handling analysis (8 paths, all verified)
- ✅ Test coverage matrix (20 features × tests)
- ✅ Identified counter-reset-on-reconnect issue (SF-1)
- ✅ Identified undocumented smoke config changes (SF-2)
- ✅ Identified missing array/boolean test coverage (NH-1, NH-2)
- ✅ Correctly validated the `since_last_summary` plan deviation (NH-3)
- ✅ Assessed binary detection false positive risk (NH-4)

**What it missed:**
- ❌ `Number()` accepting hex/octal/binary literals and `Infinity` (Y-1) — the most operationally significant finding
- ❌ `isBinary` running unnecessarily for `string` and `value` modes (NH-4, cosmetic)

The internal review correctly identified 2 should-fix and 4 nice-to-have items. Its verdict of "UNCONDITIONAL GO" is appropriate — none of the findings are blockers. The one thing it missed (Y-1: `Infinity`) is a should-fix, not a must-fix.

**Internal Review Grade: A-**

Strong, thorough review. The `Number()` / `Infinity` edge case is the kind of thing that requires running actual JavaScript evaluation to discover, which the internal review didn't do. The sub-agent did.

---

## Phase 11 Readiness

**Status: GO**

Phase 10 is clean, self-contained, and well-tested. No interface changes affect other modules. No new dependencies. The two should-fix items (Y-1 `isFinite` guard, Y-2 counter reset) are minor and can be addressed at the start of Phase 11 or as a quick fix pass before it.

Phase 11 (RealOpcuaClient adapter) is completely independent — it works on OPC-UA, not MQTT. No blockers.

---

## Test Results (verified by sub-agent)

```
MQTT consumer tests: 52 pass, 0 fail
Full test suite:     1003 pass, 0 fail (per internal review — sub-agent timed out on full run)
```
