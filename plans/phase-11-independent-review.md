# Phase 11 Independent Review — Real OPC-UA Client Adapter

**Reviewer:** Independent sub-agent (Dex-spawned)  
**Date:** 2026-02-26  
**Scope:** All Phase 11 commits  
**Verdict:** CONDITIONAL GO

---

## Summary

Phase 11 delivers a solid, well-structured `RealOpcuaClient` adapter (529 lines) that correctly bridges the `OpcuaClient` interface to `node-opcua`. The implementation is appropriately thin — it delegates subscription lifecycle, reconnection, security negotiation, and data mapping to the already-tested `OpcuaInput` class. The factory wiring via lazy `require()` is correct and preserves mock-based test isolation.

The internal review's S-1 finding (hardcoded deadband trigger) was correctly identified and has been fixed: `OpcuaMonitoredItemParams` now includes `trigger`, `connectAndSubscribe()` passes `config.data_change_filter.trigger`, and `addMonitoredItem()` uses `TRIGGER_MAP[item.trigger]`. However, the fix was incomplete — several unit test call sites omit the now-required `trigger` field, producing TypeScript compilation errors.

Overall quality is high. The adapter covers all 13 interface methods + 2 getters, handles errors consistently, and is well-tested against an in-process OPC-UA server. Two issues require attention before Phase 12, and several minor improvements are recommended.

---

## Code Review Findings

### 🔴 Must Fix

**(R-1) Three unit test call sites omit the required `trigger` field on `OpcuaMonitoredItemParams`**

**File:** `test/unit/core/opcua-client.test.ts`, lines 341, 389, 412

The S-1 fix added `trigger` as a required field to `OpcuaMonitoredItemParams`. Three test calls (`monitors multiple nodes simultaneously`, `throws if subscription not active`, `throws on unparseable node ID format`) were not updated and omit the field. This produces TypeScript compilation errors:

```
error TS2345: Argument of type '{ nodeId: ...; samplingInterval: ...; ... }' is not
assignable to parameter of type 'OpcuaMonitoredItemParams'.
  Property 'trigger' is missing in type '...' but required in type 'OpcuaMonitoredItemParams'.
```

Tests still pass at runtime because Bun transpiles without strict checking, but this violates TypeScript strict mode (CLAUDE.md Technical Standards: "Strict mode. `"strict": true` in tsconfig.").

**Fix:** Add `trigger: "status_value"` to the three test call sites.

**Impact:** Compilation correctness. If the project ever enforces `tsc --noEmit` in CI, these will block.

---

### 🟡 Should Fix

**(S-1) Deadband filter path has no dedicated test**

The `addMonitoredItem` code path at lines 321–326 (creating a `DataChangeFilter` when `deadbandType !== "none"`) is exercised only via the existing mock-based OpcuaInput tests. No unit test in `opcua-client.test.ts` calls `addMonitoredItem` with `deadbandType: "absolute"` or `deadbandType: "percent"` to verify the adapter correctly constructs a `DataChangeFilter` with the right `trigger`, `deadbandType`, and `deadbandValue`.

This matters because:
- The deadband filter is the most complex parameter construction in the adapter
- The `TRIGGER_MAP` fallback (`?? DataChangeTrigger.StatusValue`) means a typo in the trigger field would silently degrade to the default rather than throwing — only a test would catch this
- The `DEADBAND_TYPE_MAP` similarly has a fallback to `DeadbandType.None`

**Fix:** Add a test that monitors a node with `deadbandType: "absolute", deadbandValue: 1.0, trigger: "status_value_timestamp"` and verifies events are filtered correctly (or at minimum, that no error is thrown and events still arrive).

**Priority:** 1 — should be fixed before Phase 12 if it touches OPC-UA.

**(S-2) Dead code: `nodeClassMap` parameter in `browseRecursive`**

**File:** `src/core/opcua-client.ts`, lines 396–400, 407, 419

The `nodeClassMap` object is created in `browse()`, threaded through `browseRecursive()` as a parameter, but never referenced. Filtering uses `allowedClasses` (a `Set<string>`) and `NodeClass[ref.nodeClass]` instead. This was identified by the internal review and remains unfixed.

**Fix:** Remove `nodeClassMap` from `browse()` and the parameter from `browseRecursive()`. Wait — I re-read the code. The `nodeClassMap` is **not actually present** in the current code. The internal review's S-2 referenced path-based line numbers that don't match. Let me verify...

After re-reading `browse()` (lines 390–406) and `browseRecursive()` (lines 408–490): the internal review's S-2 was **incorrect**. There is no `nodeClassMap` in the current code. The `browseRecursive` signature takes `allowedClasses: Set<string>` directly. The internal review appears to have been referring to an earlier revision or was mistaken. **This finding is retracted.**

**(S-3) `as any` casts — mostly safe, one worth documenting**

Three `as any` casts exist in the adapter:

1. **Line 262:** `this.client.createSession(userIdentity as any)` — The `node-opcua` `createSession()` overloads accept `UserIdentityInfo` which uses discriminated union types. Casting the config object is pragmatic since the structure matches at runtime. **Safe.**

2. **Line 271:** `this.session.on("session_closed" as any, ...)` — The `session_closed` event exists on `ClientSession` implementations but may not be in the TypeScript type definition. **Safe but fragile** — if `node-opcua` renames this event, it will silently stop working with no compilation error. A comment explaining this would help.

3. **Line 364:** `const session = this.session as any` for `transferSubscriptions()` — The method exists on the implementation but not the TS interface. **Safe and documented** in the code comment. This is the standard pattern for accessing `transferSubscriptions`.

**Fix:** Add a comment on line 271 noting the event name may not be in TS typings.

**Priority:** 2

**(S-4) No test for non-default `trigger` value end-to-end**

The S-1 fix correctly wires `config.data_change_filter.trigger` through to the adapter, but no test exercises a non-default trigger value (e.g., `"status_value_timestamp"` or `"status"`) to verify the wiring works end-to-end. The mock-based tests in `opcua.test.ts` only test with the default `"status_value"`.

**Priority:** 2 — fix when deadband testing is added (S-1 above).

---

### 🟢 Nice to Have

**(N-1) `getServerCertificateFingerprint()` not on `OpcuaClient` interface**

This is by design (documented in the phase plan) and acceptable for MVP. When TOFU persistence is implemented post-MVP, consider adding it to the interface.

**(N-2) Certificate fingerprint test uses conditional assertion**

`test/unit/core/opcua-client.test.ts` line 723: `if (fp !== null)` guards the format assertion. Since `node-opcua` `OPCUAServer` always generates a self-signed cert, this guard is always true in practice. Could be a strict assertion.

**(N-3) `waitForCondition` utility duplicated**

Same polling helper is defined in both `opcua-client.test.ts` and `opcua-real-client.test.ts`. Could be extracted to a shared test utility like `test/helpers/wait.ts`.

**(N-4) `require()` in factory is untyped**

Inherent trade-off of lazy loading. Mitigated by integration tests exercising the factory path. Acceptable.

**(N-5) Browse only recurses into `NodeClass.Object` nodes**

Correct for the PRD use case. Other container types (`ObjectType`, `View`) are not relevant for discovering monitoring targets.

**(N-6) TypeScript strict-mode errors in `opcua-client.ts` (lines 230, 231, 425)**

Three `Object is possibly 'undefined'` errors from array indexing with prior length checks. TypeScript doesn't narrow types from length checks. Could be fixed with non-null assertions (`!`) or explicit checks. These are pre-existing patterns in the codebase, not unique to Phase 11.

---

## Interface Compliance

| Method / Property | Present | Correct | Notes |
|---|---|---|---|
| `connect(endpointUrl, options)` | ✅ | ✅ | Creates OPCUAClient, wires events, extracts TOFU fingerprint |
| `createSession(auth?)` | ✅ | ✅ | Supports anonymous + username. Certificate auth deferred. |
| `createSubscription(params)` | ✅ | ✅ | Uses `createSubscription2()`, stores subscription ID |
| `addMonitoredItem(item)` | ✅ | ✅ | Deadband filter, trigger mapping, data change callback |
| `onDataChange(handler)` | ✅ | ✅ | Stores callback, dispatched from monitored item events |
| `onClose(handler)` | ✅ | ✅ | Wired to both `close` and `connection_lost` events |
| `transferSubscriptions()` | ✅ | ✅ | Uses `as any` cast — documented, acceptable |
| `browse(rootNodeId, maxDepth, nodeClasses)` | ✅ | ✅ | Recursive, depth-limited, class-filtered, reads DataType/value |
| `resolveNamespaceUri(uri)` | ✅ | ✅ | Uses `readNamespaceArray()` |
| `closeSession()` | ✅ | ✅ | Terminates subscription + session, idempotent |
| `disconnect()` | ✅ | ✅ | Nulls client, idempotent |
| `isConnected` (getter) | ✅ | ✅ | Tracked via internal flag, updated on events |
| `sessionActive` (getter) | ✅ | ✅ | Tracked via internal flag |
| Extra: `getServerCertificateFingerprint()` | ✅ | ✅ | Not on interface — adapter-specific for TOFU |

**Verdict:** Full interface compliance. All 13 methods + 2 getters implemented.

---

## PRD Appendix D Compliance

| Section | Requirement | Status | Notes |
|---|---|---|---|
| D.1 Connection | Endpoint URL, security policy, connection strategy | ✅ | `maxRetry: 0`, `endpointMustExist: false` |
| D.2 Security | Policy mapping, mode mapping, auto-negotiation | ✅ | All 4 policies + 3 modes mapped. Unknown → throws. Auto handled by OpcuaInput. |
| D.3 Data Types | 22+ OPC-UA data types mapped | ✅ | DataType enum → string name. Extraction via `value.value`. Null handling. |
| D.4 Subscriptions | Publishing interval, queue, deadband, trigger | ✅ | S-1 fix applied. `TRIGGER_MAP` now used. |
| D.5 Browse | Recursive traversal, depth limit, class filter, output | ✅ | Reads DataType + current value for Variables. |
| D.6 Reconnection | Connection loss → callback → OpcuaInput handles | ✅ | `close` + `connection_lost` events fire `closeHandler`. |
| D.7 Error Handling | Descriptive messages, non-fatal errors logged | ✅ | All catch blocks wrap with context. Browse/fingerprint non-fatal. |

**Data Type Coverage:** The adapter delegates DataType → string mapping to `DataType[dt]` (node-opcua's enum reverse lookup), which covers all 25+ built-in types. The `OpcuaInput.mapOpcuaValue()` function (Phase 7) handles the JS value conversion. This separation is correct.

**Security Policy Mapping:** All policies listed in Appendix D are covered:
- `None` → `SecurityPolicy.None`
- `Basic256Sha256` → `SecurityPolicy.Basic256Sha256`
- `Aes128_Sha256_RsaOaep` → `SecurityPolicy.Aes128_Sha256_RsaOaep`
- `Aes256_Sha256_RsaPss` → `SecurityPolicy.Aes256_Sha256_RsaPss`
- Unknown → throws `Error` with valid options list ✅
- `"auto"` → handled by `OpcuaInput` fallback loop, not by adapter ✅

**Security Mode Mapping:**
- `None`, `Sign`, `SignAndEncrypt` → correct enum values ✅
- Unknown → throws ✅

---

## Test Coverage Assessment

### Unit tests (33 tests) — STRONG

| Area | Tests | Coverage |
|---|---|---|
| Connect/disconnect | 4 | Happy path, unreachable, double disconnect ✅ |
| Session | 3 | Anonymous, no-arg, pre-connect error ✅ |
| Subscription | 2 | Happy path, pre-session error ✅ |
| Monitored items | 6 | Initial value, mutation, multi-node, bad ID, non-existent ID, no subscription ✅ |
| DataChangeEvent | 2 | Timestamps, Boolean type ✅ |
| Browse | 4 | Discovery, depth limit, class filter, pre-session error ✅ |
| Namespace | 3 | Found, not found, pre-session error ✅ |
| Lifecycle | 2 | Close session, double close ✅ |
| Connection loss | 1 | Server shutdown → onClose ✅ |
| Fingerprint | 1 | Available after connect ✅ |
| Transfer | 1 | No session → false ✅ |
| Security mapping | 4 | All policies, all modes, unknown throws ✅ |

**Gaps identified:**
1. No test for `deadbandType !== "none"` path (see S-1)
2. No test for username authentication
3. No test for `createSession` error path (hard to trigger)
4. No test for transfer subscriptions success path (requires reconnection scenario)
5. Three calls omit required `trigger` field (see R-1)

### Integration tests (7 tests) — STRONG

End-to-end pipeline coverage is excellent. Tests verify data flows correctly from in-process OPC-UA server through PipelineRuntime to MockOutput. Browse mode and security auto-negotiation are both tested.

**Gap:** No reconnection scenario test (acknowledged in internal review as complex to automate).

### Milo smoke test (2 tests) — WELL DESIGNED

Skip-if-offline guard at module load time (`describe.skipIf(!miloReachable)`) is the correct pattern. Tests are thorough when they run — verify data types, timestamps, status codes, quality, and fingerprint format. The 5-second probe timeout is reasonable.

**Note:** Both tests are currently skipped (server unreachable from this environment). This is expected.

### Existing tests — UNAFFECTED ✅

1046 existing tests pass unchanged. The lazy `require()` pattern correctly isolates mock-based tests from the real adapter.

---

## Internal Review Quality Assessment

**Internal Review Grade: A-**

**Justification:**

The internal review was thorough and identified the most significant issue in Phase 11 — the hardcoded deadband trigger (S-1). This was a genuine Rule 10 violation (no hardcoded config overrides) that could cause user-configured trigger values to be silently ignored. The fix was correctly designed (add `trigger` to interface, wire through from config, use `TRIGGER_MAP`).

**Strengths:**
- Correctly identified the hardcoded trigger as the top finding
- PRD compliance table was accurate
- Test coverage assessment was thorough and honest about gaps
- Rules compliance check was systematic
- Phase 12 readiness assessment was well-reasoned

**Weaknesses:**
- S-2 (dead code: `nodeClassMap`) appears to reference code that doesn't exist in the final version. Either the finding was based on an intermediate commit that was subsequently cleaned up, or it was a misread. In either case, the finding is incorrect against the final code.
- Did not catch that the S-1 fix was incomplete — three test call sites were not updated to include the required `trigger` field (R-1 in this review). This is the most significant miss.
- S-3 (unused `TRIGGER_MAP`) was correctly identified as a consequence of S-1, but after S-1 was fixed, `TRIGGER_MAP` **is** now used. The internal review should have verified the fix resolved S-3.
- Did not flag the TypeScript compilation errors in the adapter (lines 230, 231, 425)

**The A- reflects:**
- Found the right top-priority issue (S-1) → +
- Missed the incomplete fix (R-1) → −
- One phantom finding (S-2 nodeClassMap) → −
- Stale finding (S-3 TRIGGER_MAP after fix) → −
- Otherwise thorough and well-structured → +

---

## Memory Leak & Race Condition Analysis

### Memory Leaks

**Event listener cleanup:** The adapter registers event listeners on:
1. `this.client.on("close")` and `this.client.on("connection_lost")` in `connect()`
2. `this.session.on("session_closed")` in `createSession()`
3. `monitoredItem.on("changed")` in `addMonitoredItem()`

**Are they cleaned up?** 
- On `disconnect()`, `this.client` is set to `null` after `client.disconnect()`. The old `OPCUAClient` instance (and its listeners) become eligible for GC. ✅
- On `closeSession()`, `this.session` is set to `null` after `session.close()`. Same GC pattern. ✅
- `MonitoredItem` listeners: these are on items that belong to the subscription. When `subscription.terminate()` is called in `closeSession()`, the subscription (and its items) are cleaned up. ✅
- On reconnection: `OpcuaInput.reconnect()` calls `client.disconnect()` (which nulls the old adapter's client) then `connectAndSubscribe()` (which creates a fresh client). Old listeners GC with old objects. ✅

**Verdict:** No memory leaks detected. The nulling pattern after disconnect/close ensures old objects and their listeners are GC'd.

### Race Conditions

**1. `onClose` callback during `closeSession`/`disconnect`:** If the server closes the connection while `closeSession()` is executing, the `close` event could fire and call `closeHandler()` concurrently with the `closeSession()` logic. Since both operations set `_sessionActive = false` and `_isConnected = false`, and since JS is single-threaded (no true concurrency), this is safe — the close handler will run between await points, but the state flags are idempotent.

**2. `dataChangeHandler` after `closeSession`:** A monitored item's `changed` event could fire just before the subscription is terminated. The handler checks `if (this.dataChangeHandler)` and dispatches. This is benign — at worst, one extra data change event is delivered to `OpcuaInput.handleDataChange()`, which checks `if (!this.acc || this.stopped)`. ✅

**3. Multiple `onDataChange`/`onClose` registrations:** `connectAndSubscribe()` calls `client.onDataChange()` and `client.onClose()` on every connection (including reconnections). Since these methods overwrite instance fields (not additive listeners), there's no handler stacking. ✅

**Verdict:** No race conditions detected. The single-threaded JS event loop and the overwrite-not-stack callback pattern are safe.

---

## Phase 12 Readiness

**Conditional GO.** Phase 11 is functionally complete and ready to build upon, with one condition:

1. **R-1 must be fixed first** — the three test call sites missing `trigger` are TypeScript compilation errors. This is a 30-second fix (add `trigger: "status_value"` to three objects) but violates the project's TypeScript strict mode standard.

**Recommended before Phase 12:**
- Fix R-1 (required — TypeScript errors)
- Fix S-1 (add deadband filter test — strengthens coverage of the most complex adapter code path)

**Acceptable to defer:**
- S-3 (`as any` cast comments)
- S-4 (non-default trigger end-to-end test)
- All N-* items

The core adapter is sound, the factory wiring is correct, existing tests are preserved, and the architecture (interface → adapter → library) is clean. Phase 12 can safely build on this foundation once R-1 is addressed.
