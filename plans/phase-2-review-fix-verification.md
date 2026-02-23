# Phase 2 — Fix Verification Report

**Verifier:** Claude Opus 4 (independent sub-agent — third context, not the implementer nor the reviewer)
**Date:** 2026-02-23
**Test status:** 251/251 pass, 0 fail, 864 expect() calls ✅
**Fix commit:** `d817825 phase-2: fix I-01, F-13, F-14 from second code review`
**Earlier fix commit:** `64ebb5b phase-2: fix F-02, F-03, F-05 — server failover, auto-reconnect, reconnect config`

---

## Fix Verification

### Resolved Findings (marked ~~RESOLVED~~ in review)

| Finding | Status | Verification |
|---------|--------|-------------|
| **F-02** MQTT: Only connects to first server | ✅ Verified | `mqtt-consumer.ts` line 305 passes `this.config.servers` (full array) to `this.client.connect()`. Test "server failover: full servers list passed to client" asserts all 3 servers are passed through. |
| **F-03** OPC-UA: reconnect() never called automatically | ✅ Verified | `opcua.ts` line 655 registers `this.client.onClose(...)` handler that calls `this.reconnect()` when `!this.stopped`. Test "auto-reconnect: connection loss triggers reconnection" exercises the full cycle. |
| **F-05** MQTT: reconnect max_delay and max_retry not wired | ✅ Verified | Lines 283–291 wire `maxReconnectDelay` and `maxReconnectAttempts` to client options. Lines 255–263 enforce at plugin level via `onReconnect` handler with attempt counter. Counter resets on `onConnect` (line 269). Three dedicated tests cover: max_retry exceeded → disconnect, counter reset on reconnect, max_retry=0 → unlimited. |
| **F-13** MQTT: QoS default is 0, should be 1 | ✅ Verified | Diff shows `default(0)` → `default(1)` at `mqtt-consumer.ts` line 28. Two test assertions updated from `.toBe(0)` to `.toBe(1)`. |
| **F-14** Runtime: startup order deviates from PRD §8 | ✅ Verified | Diff shows flush loops moved from step 3 (right after output connect) to step 7 (after all inputs started). Comment now reads "PRD §8 step 16: last — after all inputs are running". Numbering of intermediate steps updated to match. Correct. |
| **I-01** OPC-UA: handleDataChange uses `node.name` instead of `node.measurement` | ✅ Verified | Diff shows `this.acc.addFields(node.name, ...)` → `this.acc.addFields(node.measurement, ...)` at line 715. `ExpandedNode.measurement` is set to `group.name` for grouped nodes (line 424) and `node.name` for standalone nodes (line 400), so the fix correctly uses group name as measurement for grouped nodes. New test assertion `expect(acc.metrics[0]!.measurement).toBe("conveyor_drives")` covers this. |

**All 6 resolved findings: ✅ Verified correct and complete.**

---

### Deferred / Open Findings

| Finding | Severity | Deferral Reasonable? | Notes |
|---------|----------|---------------------|-------|
| **F-01** MQTT: Sparkplug B payload missing | 🟡 (reclassified from 🔴) | ✅ Yes | Sparkplug B requires dedicated protobuf library + output ecosystem (Phase 4/5). Not a Phase 3 blocker. |
| **F-04** Internal Metrics: Missing 10+ PRD-specified metrics | 🟡 (reclassified from 🔴) | ✅ Yes | Most missing metrics (local_store, network_policy, config_reload) depend on subsystems not yet built. Reclassification to 🟡 is appropriate. |
| **F-06** OPC-UA: O(n) linear scan in handleDataChange | 🟡 P1 | ✅ Yes | `expandedNodes.find()` is O(n). Trivial Map fix, should be done when touching opcua.ts. Not a regression risk. |
| **F-07** Runtime: gather timeout creates orphan Promise | 🟡 P2 | ✅ Yes | TODO at line 115 of runtime.ts documents this. Proper fix requires extending Input interface with AbortSignal — interface-level change best deferred. |
| **F-08** MQTT: createDefaultMqttClient() throws unconditionally | 🟡 P1 | ✅ Yes | Blocks real E2E but not Phase 3 (processors). |
| **F-09** OPC-UA: TOFU and certificate generation not implemented | 🟡 P2 | ✅ Yes | Deployment-time feature needing real `node-opcua` adapter. |
| **F-10** OPC-UA: subscription transfer not implemented | 🟡 P2 | ✅ Yes | `transferSubscriptions()` method exists in interface but unused. Creates data gap during reconnect but works. |
| **F-11** Modbus: disabled registers not in self-metrics | 🟡 P2 | ✅ Yes | Needs stats system extension. Low priority. |
| **F-12** Runtime: output channels hardcoded to 10,000 | 🟢 (reclassified from 🟡) | ✅ Yes | 10,000 **is** the PRD-specified default (§4). No config field defined in PRD. Reclassification correct. |
| **I-02** Runtime: PipelineRuntime has zero StatsCollector integration | 🟡 P1 | ✅ Yes (for Phase 3) | Confirmed: `runtime.ts` has zero references to StatsCollector/stats. Internal metrics plugin emits zeros for pipeline counters in real deployments. Should be addressed during Phase 3 when runtime is next modified. |
| **I-03** OPC-UA: security auto-negotiation reconnect leak | 🟡 P1 | ✅ Yes | Only affects `security_policy = "auto"` with real adapter. Mock resets state, so tests pass. Fix when real adapter implemented. |
| **I-04** Modbus: `null as unknown as ModbusClient` fallback | 🟡 P2 | ✅ Yes | Latent bug — no guard in `gather()` if `init()` not called. Low risk since lifecycle enforces ordering. |
| **I-05** MQTT: JSON array payload → string coercion | 🟡 P2 (review says 🟢) | ✅ Yes | Array falls through to `toFieldValue()` which stringifies. `flattenJson` supports arrays. Minor; no real-world factory MQTT source sends bare JSON arrays. |
| **F-15–F-20, I-06–I-10** | 🟢 | ✅ Yes | All Nice to Have. None are correctness issues. |

**All deferrals are reasonable and documented.**

---

## Sanity Check of Changed Files

### `src/pipeline/runtime.ts`
- **F-14 fix (flush loop reorder):** Steps renumbered 1–7. Flush loops moved to step 7 (last). All intermediate steps shifted correctly. Comments updated with PRD section references.
- **No StatsCollector changes** — confirmed not part of this fix pass (I-02 deferred to Phase 3).
- **No regressions:** All existing pipeline tests pass. The reorder doesn't change functional behavior — only timing of when flush loops begin consuming from output channels.

### `src/plugins/inputs/opcua.ts`
- **I-01 fix:** Single-line change: `node.name` → `node.measurement` at line 715. Correct because `ExpandedNode.measurement` already carries the right value (group name for grouped nodes, node name for standalone).
- **No other changes** in this commit.

### `src/plugins/inputs/mqtt-consumer.ts`
- **F-13 fix:** `default(0)` → `default(1)` for QoS. Single-line change, correct.
- **I-05 (array payload):** NOT fixed in this commit (appropriately deferred as 🟢).

### Test files
- `test/unit/plugins/inputs/mqtt-consumer.test.ts`: Two assertions updated from `toBe(0)` to `toBe(1)` for QoS default. Correct.
- `test/unit/plugins/inputs/opcua.test.ts`: One new assertion `expect(acc.metrics[0]!.measurement).toBe("conveyor_drives")` added to existing group node test. Correct — tests the exact bug that I-01 fixed.

### Regression Check
- **251/251 tests pass** — zero regressions.
- The F-14 reorder is the highest-risk change (startup ordering). All integration tests (modbus-pipeline, opcua-pipeline, mqtt-pipeline, pipeline-e2e, internal-pipeline) pass, confirming no regression in data flow.
- The I-01 fix adds specificity (measurement name) to an existing behavior. Standalone nodes are unaffected (`measurement = node.name` for standalone).

---

## New Issues

**None introduced by the fixes.** The changes are minimal and surgical:
- 1 line in `opcua.ts` (measurement name)
- 1 line in `mqtt-consumer.ts` (QoS default)
- ~26 lines in `runtime.ts` (block move for startup reorder)
- 4 lines in test files (assertion updates)

No new code paths, no new dependencies, no behavioral changes beyond the intended fixes.

---

## Phase 3 Readiness

### Assessment: **GO** ✅

**All 🔴 Must Fix findings are resolved and verified:**
- F-02 (server failover) ✅
- F-03 (auto-reconnect) ✅
- F-05 (reconnect config wiring) ✅
- I-01 (measurement name) ✅

**Pre-Phase-3 priority fixes resolved:**
- F-13 (QoS default) ✅
- F-14 (startup ordering) ✅

**Test suite:** 251/251 pass, 0 regressions.

**Phase 3 dependencies satisfied:**
- Pipeline runtime correctly handles processor chain (sequential execution, CollectingAccumulator, aggregator fork)
- Both polling and push (ServiceInput) input patterns working
- Startup/shutdown ordering matches PRD §8

**Recommended Phase 3 carry-forward:**
1. **I-02 (StatsCollector integration)** — Wire stats counters when runtime is modified for processor concerns
2. **F-06 (O(n) node lookup)** — Convert to Map if touching opcua.ts

**No blockers. Phase 3 can proceed.**
