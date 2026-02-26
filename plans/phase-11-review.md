# Phase 11 Code Review -- Real OPC-UA Client Adapter

**Reviewer:** Quality review agent (separate context from implementing agent)
**Date:** 2026-02-26
**Test suite status:** 1065 pass, 2 skip (Milo server unreachable), 0 fail

## Summary

Phase 11 delivers the `RealOpcuaClient` adapter that bridges the `OpcuaClient` interface to the `node-opcua` library, wires it into the plugin factory via lazy `require()`, and includes thorough unit, integration, and smoke tests. The implementation is clean, well-structured, and correctly thin -- it delegates all subscription lifecycle, reconnection, security negotiation, and data mapping logic to the existing `OpcuaInput` class (Phase 7).

The adapter implements all 13 methods of the `OpcuaClient` interface plus an additional `getServerCertificateFingerprint()` helper. All existing OPC-UA tests (mock-based) are unaffected. The factory wiring is correct.

There are two issues worth fixing (one medium-priority, one low-priority) and several minor observations.

## PRD Compliance Table

| Module | Interface Match | Behaviour Match | Notes |
|--------|----------------|-----------------|-------|
| RealOpcuaClient | ✅ | ⚠️ | All 13 interface methods + 2 getters. Deadband filter trigger hardcoded (see finding S-1). |
| plugin-factory opcua entry | ✅ | ✅ | Lazy `require()` correct. Stats param unused but signature-compatible. |
| OpcuaInput changes | ✅ | ✅ | Header comment updated. Safety assertion replaces stale TODO. No logic changes. |
| PRD Appendix D update | ✅ | ✅ | Adapter architecture note added at D.1. |
| Post-MVP backlog update | ✅ | ✅ | Item #12 marked DONE. Description corrected. |

## Findings

### No Must-Fix Issues Found

There are no critical blockers preventing Phase 12 work. The findings below are improvement items.

### 🟡 Should Fix

**S-1. Deadband filter trigger hardcoded to StatusValue, ignoring config `data_change_filter.trigger`**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/opcua-client.ts`, lines 321-327.

The PRD Appendix D defines `data_change_filter.trigger` with three values: `status`, `status_value`, `status_value_timestamp`. The Zod schema correctly parses this. However, when `RealOpcuaClient.addMonitoredItem()` creates a `DataChangeFilter` for deadband items, it hardcodes the trigger:

```typescript
monitoringParams.filter = new DataChangeFilter({
  trigger: DataChangeTrigger.StatusValue,  // <-- hardcoded, ignores config
  deadbandType: DEADBAND_TYPE_MAP[item.deadbandType] ?? DeadbandType.None,
  deadbandValue: item.deadbandValue,
});
```

The `OpcuaMonitoredItemParams` interface does not include a `trigger` field, so the config value is never passed from `OpcuaInput` to the adapter. The `TRIGGER_MAP` constant (lines 120-124) is defined in the adapter but never read.

**Impact:** For most deployments, `status_value` (the default) is correct and this causes no issue. But users who explicitly set `trigger = "status_value_timestamp"` or `trigger = "status"` in config will find the setting silently ignored. This violates Rule 10 (no hardcoded config overrides).

**Fix:**
1. Add `trigger: "status" | "status_value" | "status_value_timestamp"` to `OpcuaMonitoredItemParams` interface in `opcua.ts`
2. Pass the trigger value through from `OpcuaInput.connectAndSubscribe()` (it has access to `config.data_change_filter.trigger`)
3. Use `TRIGGER_MAP[item.trigger]` in `addMonitoredItem()` instead of the hardcoded `DataChangeTrigger.StatusValue`
4. Add a test exercising a non-default trigger value

**Priority:** 2 (fix when the context arises -- the default is correct for most cases, and the deadband filter is itself only applied when `deadbandType !== "none"`)

**S-2. Dead code: `nodeClassMap` parameter threaded through browse but never read**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/opcua-client.ts`, lines 396-400, 407, 419, 481.

The `nodeClassMap` object maps string class names to `NodeClass` enum values. It is created in `browse()`, passed to `browseRecursive()`, accepted as a parameter, and threaded through recursive calls -- but is never actually referenced in the filtering logic. Filtering uses `allowedClasses` (a `Set<string>`) and `NodeClass[ref.nodeClass]` (reverse enum lookup) instead.

**Impact:** No functional impact. This is dead code that adds noise and confusion.

**Fix:** Remove `nodeClassMap` from `browse()`, remove the parameter from `browseRecursive()`.

**Priority:** 2 (cleanup when touching this code next)

**S-3. `TRIGGER_MAP` and `DEADBAND_TYPE_MAP` defined but `TRIGGER_MAP` is never used**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/opcua-client.ts`, lines 120-124.

`TRIGGER_MAP` is defined at module scope but never referenced anywhere in the module. This is a leftover from the implementation -- it was intended for use in `addMonitoredItem()` but was replaced by the hardcoded `DataChangeTrigger.StatusValue`. Fixing S-1 would resolve this.

**Impact:** Dead code.

### 🟢 Nice to Have

**N-1. `getServerCertificateFingerprint()` is not part of the `OpcuaClient` interface**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/opcua-client.ts`, line 173.

The `OpcuaClient` interface (defined in `opcua.ts`) has 13 methods and 2 readonly properties. `getServerCertificateFingerprint()` is an additional method on `RealOpcuaClient` that is not part of the interface. This is acceptable for now because:
- The TOFU fingerprint logic in `OpcuaInput` already uses it conditionally via type narrowing
- Adding it to the interface would require all mock implementations to implement it
- The phase plan explicitly calls this out as an adapter-specific method

However, if TOFU persistence is implemented (post-MVP), consider whether to add this to the interface so `OpcuaInput` can use it generically.

**N-2. Certificate fingerprint test is conditional (may not assert on all servers)**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/test/unit/core/opcua-client.test.ts`, lines 719-734.

The fingerprint test guards the assertion with `if (fp !== null)`, meaning if the in-process server doesn't provide a certificate via `getEndpoints()`, the test passes without asserting. This is reasonable defensiveness, but the `node-opcua` `OPCUAServer` generates a self-signed cert by default, so the `if` guard is likely always true. Consider making this a strict assertion if the test reliably produces a fingerprint.

**N-3. `waitForCondition` utility duplicated across test files**

Files: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/test/unit/core/opcua-client.test.ts`, `/Users/leemcneil/Projects/DoublyGood/collatr-edge/test/integration/opcua-real-client.test.ts`.

The same `waitForCondition` polling helper is defined in both test files. This is a minor duplication. Could be extracted to a shared test utility, though the function is small enough that the duplication is not harmful.

**N-4. `require()` in the factory is untyped**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/pipeline/plugin-factory.ts`, line 184.

```typescript
const { RealOpcuaClient } = require("../core/opcua-client");
```

This `require()` returns `any`, so there is no compile-time type checking on `RealOpcuaClient`. If the export name changes, this would fail at runtime rather than compile time. This is an inherent trade-off of the lazy-loading pattern and is documented in the phase plan. Not a problem in practice since the unit/integration tests exercise this path.

**N-5. Browse recursion only enters Object nodes, not other container types**

File: `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/opcua-client.ts`, line 475.

The browse only recurses into nodes with `NodeClass.Object`. OPC-UA also has `NodeClass.ObjectType`, `NodeClass.View`, and other container-like types. For the PRD's stated use case (discovering Variable tags for monitoring), recursing into Objects only is correct. This matches PRD Appendix D which specifies `node_classes: ["Variable", "Object"]` as the filter set.

## Test Coverage Assessment

### Unit tests (`test/unit/core/opcua-client.test.ts`) -- 33 tests

**Strong coverage of:**
- Connect/disconnect lifecycle (including error cases, double disconnect)
- Session creation (anonymous, no-arg, pre-connect error)
- Subscription creation (including pre-session error)
- Data change reception (initial value, value mutation, multiple nodes)
- Error handling (unparseable node ID, non-existent node ID)
- Browse (discovery, depth limit, class filtering, pre-session error)
- Namespace URI resolution (found, not-found, pre-session error)
- Session/subscription termination (including double-close safety)
- Connection loss detection (isolated server shutdown)
- Certificate fingerprint availability
- Transfer subscriptions (no-session case)
- Security policy/mode enum mapping (all valid values + unknown value errors)

**Missing or thin coverage:**
- No test for deadband filter creation (the path through lines 321-326 where `item.deadbandType !== "none"`). The test suite only exercises `deadbandType: "none"`. Consider adding a test with `deadbandType: "absolute"` to verify the `DataChangeFilter` is constructed correctly.
- No test for username authentication (`auth.type === "username"`). Only anonymous auth is tested. This is reasonable since the in-process test server doesn't configure user authentication, but it leaves lines 250-256 untested.
- No test for the `createSession` error path catch block (lines 264-268). Would require forcing `client.createSession()` to throw, which is hard to trigger against a healthy in-process server.
- Transfer subscriptions success path (line 370-376) is not tested (only the no-session failure path). Would require reconnection scenario with subscription IDs.

### Integration tests (`test/integration/opcua-real-client.test.ts`) -- 7 tests

**Strong coverage of:**
- Full pipeline data flow (OpcuaInput + RealOpcuaClient + PipelineRuntime + MockOutput)
- All four data types (Int32, Float, Double, Boolean)
- Value mutation propagation
- Global tags + quality tag
- Clean shutdown
- Browse mode with TOML output file
- Security auto-negotiation fallback

**Missing:**
- Reconnection scenario (connection loss + automatic recovery). This is the most complex hard path and is tested at the `OpcuaInput` level with mocks (Phase 7), but the integration of `RealOpcuaClient` reconnection with `OpcuaInput.reconnect()` is not tested end-to-end. This is understandable given the complexity of reliably simulating connection loss in automated tests.

### Smoke test (`test/integration/opcua-milo-smoke.test.ts`) -- 2 tests (skipped when offline)

**Well designed:**
- Skip-if-offline guard at module load time prevents CI flakiness
- `describe.skipIf(!miloReachable)` is the correct pattern
- Verifies data types, timestamps, status codes, quality tags
- Tests certificate fingerprint format
- Clean shutdown in `finally` block ensures no resource leak even on failure

**Observation:** Both tests correctly skipped in current environment. The probe timeout (5s) is reasonable.

### Existing OPC-UA tests -- unaffected

The existing mock-based OPC-UA tests (`test/unit/plugins/inputs/opcua.test.ts`, `test/integration/opcua-pipeline.test.ts`) continue to pass without modification. The factory change uses lazy `require()`, so mock-based tests that inject clients directly never trigger the `require("../core/opcua-client")` path. This is correct by design.

## Rules Compliance Check

| Rule | Status | Notes |
|------|--------|-------|
| R1: No Hand-Waving | ✅ | No dismissed failures. All tests pass. |
| R2: Tests Prove Behaviour | ✅ | Tests focus on data correctness and contracts. |
| R3: Small Verified Steps | ✅ | Each task committed after tests pass. |
| R4: One Thing at a Time | ✅ | Adapter, factory, tests in clear sequence. |
| R5: PRD Is the Spec | ✅ | Implementation follows Appendix D. |
| R6: Commit Discipline | ✅ | Clear commit messages with phase prefix. |
| R7: No Premature Abstraction | ✅ | Thin adapter, no unnecessary layers. |
| R8: Interface Compliance | ⚠️ | All 13 methods + 2 getters present. `OpcuaMonitoredItemParams` missing trigger field (S-1). |
| R9: Test Hard Paths First | ⚠️ | Deadband filter path untested. Username auth untested. Transfer success path untested. See assessment above. |
| R10: No Hardcoded Config | ⚠️ | Deadband trigger hardcoded (S-1). |
| R11: Handle Return Values | ✅ | All async errors caught and re-thrown or logged. |
| R12: Lifecycle Ordering | ✅ | connect -> createSession -> createSubscription -> addMonitoredItems. Matches PRD D.2. |
| R13: Per-Instance | ✅ | Each OpcuaInput gets its own RealOpcuaClient instance. |

## Phase 12 Readiness Assessment

**Phase 11 is ready to build upon.** There are no blockers.

The core adapter works correctly, the factory wiring is sound, existing tests are unaffected, and the test coverage is strong for an adapter of this scope. The findings are all improvement items, not blockers:

- **S-1 (deadband trigger)** affects a rarely-changed config option and only matters when deadband is explicitly enabled. The default behavior is correct. Fix before any Phase that exercises non-default triggers.
- **S-2/S-3 (dead code)** are cleanup items with no functional impact.
- The nice-to-have items are quality polish.

**Recommendation:** Fix S-1 during Phase 12 if that phase touches OPC-UA subscription parameters, or add it to the post-MVP backlog if Phase 12 is unrelated to OPC-UA. Remove the dead code (S-2, S-3) at the same time.
