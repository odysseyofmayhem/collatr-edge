# Phase 10 Code Review -- MQTT Data Format Hardening

**Reviewer:** Independent review context (not the implementing agent)
**Date:** 2026-02-26
**Scope:** All commits from `4dfc699` through `4b0d2aa` (5 commits, tasks 10.0--10.4)
**Verdict:** UNCONDITIONAL GO

---

## Summary

Phase 10 adds two new `data_format` modes (`"auto"` and `"string"`) to the MQTT consumer input plugin and implements parse error throttling to prevent log flooding from wildcard subscriptions on public brokers receiving heterogeneous payloads. The PRD was updated to document the new capabilities. A total of 19 new tests were added (52 total for the file, 1022 project-wide), all passing.

This is a well-scoped, cleanly implemented phase. The code quality is high. The implementation matches the plan closely, with one justified deviation documented in the progress notes. No must-fix issues were found.

---

## Files Changed

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `prd/19-mvp-plugin-inventory.md` | PRD update | +1 line (expanded mqtt_consumer description) |
| `prd/appendix-a-full-config-example.md` | PRD update | +1 line (inline comment on data_format) |
| `src/plugins/inputs/mqtt-consumer.ts` | Feature + bugfix | +75 net lines |
| `test/unit/plugins/inputs/mqtt-consumer.test.ts` | Tests | +423 lines |
| `configs/smoke-test-public.toml` | Config update | +6/-18 net lines |
| `plans/phase-10-progress.md` | Status tracking | Updated |
| `plans/phase-10-tasks.json` | Status tracking | Updated |

---

## Module: `src/plugins/inputs/mqtt-consumer.ts`

### PRD Compliance

| Requirement (Plan + PRD) | Status | Notes |
|--------------------------|--------|-------|
| `data_format` schema: `z.enum(["json", "value", "string", "auto"]).default("json")` | PASS | Line 39. Exactly matches plan. Default remains `"json"`. |
| `"auto"` tries JSON first, falls back to `"value"` on failure | PASS | Lines 339-358. Inner try/catch around JSON.parse with silent fallback to Number-then-string. |
| `"auto"` does not log errors or call `acc.addError()` on JSON parse failure | PASS | The inner catch block has no logging or error reporting. |
| `"string"` treats payload as a single string field (no numeric coercion) | PASS | Lines 361-363. Simple `{ value: payloadStr }`. |
| `"json"` parse errors throttled: first 5 at warn with full context | PASS | Lines 386-394. Condition `<= PARSE_ERROR_VERBOSE_LIMIT`. Includes topic, error message, and count. |
| `"json"` parse errors after threshold: periodic summary every 60s | PASS | Lines 396-407. Time-based check with `PARSE_ERROR_SUMMARY_INTERVAL_MS`. |
| Parse errors downgraded from `error` to `warn` | PASS | Lines 388, 400. Both use `getLogger().warn()`. |
| `acc.addError()` only for first 5 and once per 60s summary | PASS | Called in both verbose and summary branches; silent between summaries. |
| Binary/non-UTF8 payloads handled gracefully | PASS | `isBinary` detection via `\uFFFD` and `\0` at line 323. Each format handles binary explicitly. |
| Throttling per-instance, not global (Rule 13) | PASS | `parseErrorCount` and `lastParseErrorLogTime` are instance fields. `PARSE_ERROR_VERBOSE_LIMIT` and `PARSE_ERROR_SUMMARY_INTERVAL_MS` are `static readonly` constants (shared but immutable). |

### Rules Compliance

| Rule | Status | Notes |
|------|--------|-------|
| Rule 1: No hand-waving | PASS | No dismissed test failures. All 1022 tests pass. |
| Rule 2: Tests prove behaviour | PASS | 19 new tests covering all formats, throttling, binary, per-instance isolation, and config validation. |
| Rule 5: PRD is the spec | PASS | PRD updated first (task 10.0), implementation follows. |
| Rule 7: No premature abstraction | PASS | No plugin hooks, no configurable throttle thresholds. Static constants per plan. |
| Rule 8: Interface compliance | PASS | Schema matches PRD exactly. No interface drift. |
| Rule 9: Test hard paths first | PASS | Binary handling, throttling boundaries (6th error, 60s interval), per-instance isolation all tested. |
| Rule 10: No hardcoded config overrides | PASS | `data_format` read from config. Throttle thresholds are static constants as specified in plan (YAGNI). |
| Rule 11: Handle return values in async | PASS | `handleMessage` is synchronous. Error handling wraps entire body. `acc.addError()` calls are guarded by `if (this.acc)`. |
| Rule 12: Lifecycle ordering | N/A | No lifecycle changes in Phase 10. |
| Rule 13: Per-instance, not global | PASS | Explicitly documented in code comment (line 199). Tested in "per-instance counter isolation" test. |

### Error Handling Analysis

| Path | Handled? | Notes |
|------|----------|-------|
| JSON parse failure in `"json"` mode | YES | Caught by outer try/catch, throttled. |
| JSON parse failure in `"auto"` mode | YES | Caught by inner try/catch, silent fallback. |
| Binary payload in `"json"` mode | YES | Detected before JSON.parse, explicit error thrown. |
| Binary payload in `"auto"` mode | YES | Detected before JSON.parse, immediate string fallback. |
| Binary payload in `"string"` mode | YES | Direct string assignment, replacement chars preserved. |
| Binary payload in `"value"` mode | YES | Number() returns NaN, falls back to string. |
| `this.acc` null during error handling | YES | Guarded with `if (this.acc)` at lines 394 and 404. |
| Empty string payload | YES | Each format handles it: auto/value produce `{ value: "" }` (empty string fails Number check), string produces `{ value: "" }`. |

---

## Module: `test/unit/plugins/inputs/mqtt-consumer.test.ts`

### Test Coverage Matrix

| Feature | Tests | Coverage Assessment |
|---------|-------|---------------------|
| `data_format = "auto"`: JSON object | 1 | PASS -- flattenJson path |
| `data_format = "auto"`: JSON primitive | 1 | PASS -- toFieldValue path |
| `data_format = "auto"`: non-JSON fallback to string | 1 | PASS -- NMEA sentence |
| `data_format = "auto"`: non-JSON fallback to number | 1 | PASS -- "+42" |
| `data_format = "auto"`: binary fallback | 1 | PASS -- non-UTF8 bytes |
| `data_format = "auto"`: silent (no acc.addError) | 1 | PASS -- multiple non-JSON payloads |
| `data_format = "string"`: text | 1 | PASS |
| `data_format = "string"`: numeric text (no coercion) | 1 | PASS -- asserts string type |
| `data_format = "string"`: empty string | 1 | PASS |
| Throttling: first 5 verbose | 1 | PASS -- asserts 5 acc.addError() calls |
| Throttling: 6th triggers summary | 1 | PASS -- Date.now mock, verifies "throttled" message |
| Throttling: 7th-10th silent | (same test) | PASS -- asserts error count unchanged |
| Throttling: 60s interval new summary | 1 | PASS -- advances mockTime by 61s |
| Throttling: valid messages after errors | 1 | PASS -- 10 bad then 1 good |
| Throttling: per-instance isolation | 1 | PASS -- two independent instances |
| Binary: json mode | 1 | PASS -- error reported |
| Binary: auto mode | 1 | PASS -- silent fallback |
| Binary: string mode | 1 | PASS -- replacement chars |
| Binary: value mode | 1 | PASS -- NaN fallback to string |
| Config validation: all 4 formats + invalid | 1 | PASS |

**Total new tests: 19** (across 5 describe groups + 1 standalone)

---

## Findings

### No Must Fix Items

There are no blocking issues. The implementation is correct, well-tested, and matches the plan.

---

### 🟡 SF-1: Parse error counter never resets on reconnect

**File:** `src/plugins/inputs/mqtt-consumer.ts`, lines 200-201
**Rule:** Observation / design consideration

The `parseErrorCount` and `lastParseErrorLogTime` fields are initialized at construction and never reset. After a reconnection (possibly to a different broker via failover), the error counter carries over from the previous connection's lifetime. This means:

- If the plugin hit 100 errors on the old connection, the new connection starts with a 100 error count already past the verbose threshold.
- The first parse error on the new connection will be silent (between summaries) unless 60s has elapsed since the last summary.

This is arguably correct behavior for the stated goal (throttle log flooding), and the plan's acceptance criteria do not require a reset on reconnect. However, after a reconnect, the first few errors from a new broker/topic set may be operationally interesting and worth logging verbosely.

**Recommendation:** Consider resetting `parseErrorCount` and `lastParseErrorLogTime` in the `onConnect` handler (where `reconnectAttempts` is already reset). This would give operators fresh verbose errors after each reconnection. Low priority -- the current behavior is safe and the plan explicitly does not require this.

---

### 🟡 SF-2: Smoke test config comments out topics and entire broker section without documenting why

**File:** `configs/smoke-test-public.toml`, lines 77-80, 94-108

The diff shows that `device/#`, `iot/#`, `collatr/smoke-test/#` topics were commented out for the EMQX broker, and the entire Mosquitto broker section was commented out. The plan (task 10.4) only specified changing `data_format` and adding comments -- it did not mention removing topics or disabling the second broker.

While these changes are likely practical (reducing noise during smoke testing), they are undocumented scope beyond the plan. A brief inline comment explaining why these topics/brokers were disabled would help future readers understand the intent.

**Recommendation:** Add a one-line comment next to the commented-out topics explaining the reason (e.g., "# Disabled: high volume, low signal-to-noise"). Not blocking.

---

### 🟢 NH-1: No test for `data_format = "auto"` with JSON array payload

The auto mode correctly handles JSON arrays via the `!Array.isArray(parsed)` check (line 346), falling through to `toFieldValue` which calls `String(array)`. This produces `{ value: "1,2,3" }` for `[1,2,3]`. The behavior is correct and consistent with the existing `"json"` mode, but there is no explicit test for this path in auto mode.

**Recommendation:** Add a test: `auto mode with JSON array → { value: "1,2,3" }`. Low priority -- the path is covered by the json-mode array tests and the code is shared.

---

### 🟢 NH-2: No test for `data_format = "auto"` with JSON boolean/null literals

`JSON.parse("true")`, `JSON.parse("false")`, and `JSON.parse("null")` all succeed and go through `toFieldValue`. These are valid JSON but not objects. The code handles them correctly (booleans return as-is, null returns `"null"` string). No test coverage for these specific paths in auto mode.

**Recommendation:** Low priority. These are edge cases that work correctly via existing code paths. A test would be nice for completeness.

---

### 🟢 NH-3: `since_last_summary` field omitted from throttled summary log

The plan (task 10.2) specified a `since_last_summary` field in the summary log. The implementation omits it and documents the reason in `phase-10-progress.md`: "the calculation in the plan was incorrect (always subtracted 5, not count at last summary)."

This is a justified deviation, properly documented. The `total_errors` count alone is sufficient for operators. Including it here for completeness of the review record.

---

### 🟢 NH-4: `isBinary` detection heuristic has false positive potential

The binary detection at line 323 checks for `\uFFFD` (Unicode replacement character) or `\0` (null byte). This heuristic has a theoretical false positive: a legitimate UTF-8 payload containing the Unicode replacement character U+FFFD would be incorrectly classified as binary.

In practice, this is extremely unlikely in IIoT data payloads. The heuristic is the same approach used by many text editors and is appropriate for the use case. No action needed.

---

## PRD Compliance Summary

| PRD Section | Compliance | Notes |
|-------------|------------|-------|
| S19: mqtt_consumer description | PASS | Updated to describe all four formats and throttling |
| Appendix A: config example | PASS | Inline comment on data_format field |
| S6: Plugin error handling | PASS | Errors isolated per-plugin, no crash |
| S14: Error handling conventions | PASS | Parse errors at warn (not error), throttled |

---

## Phase 11 Readiness Assessment

**Status: GO**

Phase 10 is clean and self-contained. All changes are confined to the MQTT consumer input plugin and its tests. No interface changes affect other modules. No new dependencies were introduced. The full test suite (1022 tests) passes with 0 failures.

Phase 10's changes do not create any prerequisites or blockers for Phase 11 (RealOpcuaClient adapter). The two phases are completely independent -- Phase 11 works on OPC-UA, Phase 10 on MQTT.

**SF-1 (counter reset on reconnect) is the only should-fix.** It is a minor operational improvement that could be addressed during Phase 11 if MQTT work arises, or deferred to the post-MVP backlog. It does not block Phase 11.

---

## Test Results

```
MQTT consumer tests: 52 pass, 0 fail, 173 expect() calls
Full test suite:   1022 pass, 0 fail, 5833 expect() calls (68 files)
```
