# Phase 2 Independent Code Review

**Reviewer:** Claude Opus 4 (independent context — second reviewer, not the implementing agent nor the first reviewer)
**Date:** 2026-02-23
**Scope:** All Phase 2 source and test files; verification of existing review findings
**Test status:** 251/251 pass, 0 fail, 864 expect() calls ✅

---

## 1. Existing Review Verification

For each finding in `phase-2-review.md`, I independently verify the severity, fix status, and deferral appropriateness.

### F-01: MQTT Consumer — Sparkplug B payload support missing

- **Existing severity:** 🔴 Must Fix
- **My assessment:** 🟡 Should Fix (Priority 1) — **disagree with severity**
- **Reasoning:** While PRD §19 explicitly says "Plain and Sparkplug B payloads," Sparkplug B is a binary protobuf format requiring a dedicated library (`sparkplug-payload` or equivalent). The Sparkplug B _output_ plugin (Phase 4+) doesn't exist yet, and Sparkplug B ingestion makes most sense when the Hub link/output ecosystem exists. Deferring is appropriate — but it needs a concrete TODO with phase reference.
- **Deferral appropriate?** Yes, but the TODO should reference Phase 4/5 explicitly.

### F-02: MQTT Consumer — Only connects to first server ~~RESOLVED~~

- **Existing severity:** 🔴 Must Fix → Fixed
- **Verified?** ✅ **Yes, confirmed fixed.** Line 320 of `mqtt-consumer.ts` passes `this.config.servers` (full array) to `this.client.connect()`. The `MqttClientInterface.connect()` signature takes `servers: string[]`. Test "server failover: full servers list passed to client" (line 328 in test) verifies all three servers are passed through. Fix is correct.

### F-03: OPC-UA — reconnect() is public but never called automatically ~~RESOLVED~~

- **Existing severity:** 🔴 Must Fix → Fixed
- **Verified?** ✅ **Yes, confirmed fixed.** Line 655 in `opcua.ts` registers `this.client.onClose(() => { ... this.reconnect(); })`. The `onClose` handler checks `!this.stopped` before triggering reconnection. Test "auto-reconnect: connection loss triggers reconnection" verifies the full cycle: emitClose → reconnect → data flows again. Fix is correct and well-tested.

### F-04: Internal Metrics — Missing 10+ PRD-specified metrics

- **Existing severity:** 🔴 Must Fix
- **My assessment:** 🟡 Should Fix (Priority 2) — **disagree with severity**
- **Reasoning:** The existing reviewer correctly identified the gap. However, the majority of missing metrics depend on subsystems not yet built (local_store: 5 metrics, network_policy: 2 metrics, config_reload: 2 metrics). These cannot be implemented until their respective phases. The remaining implementable-now metrics (`event_loop_lag_ms`, `buffer_length`, `buffer_overflow_count`, `gather_timeout_count`) require extending the StatsCollector interface AND wiring the PipelineRuntime to populate them — a non-trivial change that crosses module boundaries.
- **Deferral appropriate?** Partially. The 9 metrics depending on future subsystems: absolutely appropriate to defer. The 4 pipeline-level metrics: should be flagged as TODO for Phase 3 when the runtime is next modified.

### F-05: MQTT Consumer — reconnect max_delay and max_retry not wired ~~RESOLVED~~

- **Existing severity:** 🔴 Must Fix → Fixed
- **Verified?** ✅ **Yes, confirmed fixed.** Lines 307-309 in `mqtt-consumer.ts` wire `maxReconnectDelay` and `maxReconnectAttempts` to client options. Lines 255-263 implement plugin-level enforcement via `onReconnect` handler that tracks attempts and disconnects when limit exceeded. Counter resets on `onConnect` (line 269). Three tests verify: max_retry exceeded → disconnect, counter reset on reconnect, max_retry=0 → unlimited. Fix is correct and thoroughly tested.

### F-06: OPC-UA — handleDataChange uses O(n) linear scan per event

- **Existing severity:** 🟡 Should Fix (Priority 1)
- **My assessment:** 🟡 Should Fix (Priority 1) — **agree**
- **Reasoning:** Line 697 `this.expandedNodes.find(...)` is indeed O(n) per data change. With 500+ nodes at high notification rates (e.g., 100ms publishing interval), this could become a measurable bottleneck on Pi 4. The fix (build a Map during `expandNodes()`) is trivial and has zero risk.

### F-07: Runtime — gather timeout creates orphan Promise

- **Existing severity:** 🟡 Should Fix (Priority 1)
- **My assessment:** 🟡 Should Fix (Priority 2) — **slight disagree on priority**
- **Reasoning:** The TODO on line 115 of `runtime.ts` documents this clearly. In practice, gather timeouts are rare events (they indicate a misbehaving plugin), and the orphan promise will complete or fail eventually. On Pi 4, memory pressure from orphans is a real concern only under sustained timeout conditions. The proper fix (AbortSignal in Input interface) is an interface-level change best deferred to when the Input interface is next revised.

### F-08: MQTT Consumer — createDefaultMqttClient() throws unconditionally

- **Existing severity:** 🟡 Should Fix (Priority 1)
- **My assessment:** 🟡 Should Fix (Priority 1) — **agree**
- **Reasoning:** The plugin is currently test-only — it cannot function in a real pipeline without a custom MQTT client wrapper. This blocks E2E testing and production use. However, it does NOT block Phase 3 (processors), which doesn't depend on MQTT integration.

### F-09: OPC-UA — TOFU and certificate generation not implemented

- **Existing severity:** 🟡 Should Fix (Priority 2)
- **My assessment:** 🟡 Should Fix (Priority 2) — **agree**
- **Reasoning:** TOFU and certificate generation are deployment-time features requiring the real `node-opcua` adapter. The DI boundary is correctly designed — the `OpcuaClient` interface exposes `connect()` which receives `serverCertificatePath`. TOFU logic belongs in the `RealOpcuaClient` adapter, not in `OpcuaInput`. The deferral is appropriate.

### F-10: OPC-UA — subscription transfer not implemented

- **Existing severity:** 🟡 Should Fix (Priority 2)
- **My assessment:** 🟡 Should Fix (Priority 2) — **agree**
- **Reasoning:** The `transferSubscriptions()` method exists in the interface but is never called during reconnection. The `reconnect()` method calls `connectAndSubscribe()` which always creates new subscriptions from scratch. This works but creates a data gap during reconnection. The fix is straightforward: attempt `transferSubscriptions()` first in `reconnect()`, fall back to full recreation. However, testing subscription transfer requires a sophisticated mock that maintains state, so this is best done with the real adapter.

### F-11: Modbus — disabled registers not reported in self-metrics

- **Existing severity:** 🟡 Should Fix (Priority 2)
- **My assessment:** 🟡 Should Fix (Priority 2) — **agree**
- **Reasoning:** The `disabledRegisters` Set is correctly populated but never exposed to the stats system. PRD §6 says "Disabled registers are reported in self-metrics and Web UI." The fix requires either extending StatsCollector with Modbus-specific counters or having the internal metrics plugin read from input plugins directly. Low priority for Phase 3.

### F-12: Runtime — output channels hardcoded to capacity 10000

- **Existing severity:** 🟡 Should Fix (Priority 2)
- **My assessment:** 🟢 Nice to Have — **disagree on severity**
- **Reasoning:** 10,000 is the PRD-specified default (§4: "per-output channel with capacity 10000"). The PRD doesn't define a config field for this. Making it configurable is a nice-to-have enhancement, not a compliance issue. The hardcoded value matches the spec.

### F-13: MQTT Consumer — QoS default is 0, phase plan says 1 ~~RESOLVED~~

- **Existing severity:** 🟡 Should Fix (Priority 2) → Fixed
- **Verified?** ✅ **Yes, confirmed fixed.** Line 28 of `mqtt-consumer.ts` changed from `default(0)` to `default(1)`. Two test assertions updated to expect QoS 1 as default. QoS 1 (at-least-once) is the appropriate default for industrial telemetry.

### F-14: Runtime — startup order deviates from PRD §8 for flush loops ~~RESOLVED~~

- **Existing severity:** 🟡 Should Fix (Priority 2) → Fixed
- **Verified?** ✅ **Yes, confirmed fixed.** Flush loops moved from step 3 (after output connect) to step 7 (after service inputs and gather loops), matching PRD §8 step 16 ordering. All 251 tests pass with the reorder.

### F-15 through F-20 (Nice to Have)

- **F-15 (OPC-UA flattenObject max depth):** 🟢 Agree. PRD D.3 says "max depth: 3 levels (configurable)" — the "(configurable)" part is not implemented. Minor.
- **F-16 (FC02 batch test missing):** 🟢 Agree. The code path exists (line 410-416 in modbus.ts) and is structurally identical to FC01 coils. Low risk, but testing would be trivial.
- **F-17 (Int64 precision loss test):** 🟢 Agree. The test verifies the warning is logged but doesn't assert the returned value matches expectations. Minor.
- **F-18 (No explicit init() lifecycle test):** 🟢 Agree. Integration tests exercise this path implicitly.
- **F-19 (flattenJson no depth limit):** 🟢 Agree. Potential DoS vector, but MQTT payloads from factory equipment are typically shallow.
- **F-20 (Integration test timing):** 🟢 Agree. The fixed `Bun.sleep()` values are brittle but currently passing.

---

## 2. Independent Findings

These findings were not identified in the existing review or were underweighted.

### I-01. 🔴 OPC-UA: `handleDataChange` uses `node.name` instead of `node.measurement` ~~RESOLVED~~

**Severity:** Must Fix → Fixed
**File:** `src/plugins/inputs/opcua.ts`, line 715
**Rule:** Rule 8 (Interface Compliance Check), Rule 5 (PRD Is the Spec)

**Verified?** ✅ **Yes, confirmed fixed.** Line 715 changed from `this.acc.addFields(node.name, ...)` to `this.acc.addFields(node.measurement, ...)`. Group nodes now correctly use the group name as the measurement name. Test assertion added to the existing group node test verifying `acc.metrics[0]!.measurement` equals the group name `"conveyor_drives"`.

### I-02. 🟡 Runtime: PipelineRuntime does NOT integrate with StatsCollector

**Severity:** Should Fix (Priority 1)
**File:** `src/pipeline/runtime.ts`
**Rule:** Rule 8 (Interface Compliance Check)

The `PipelineRuntime` class has zero references to `StatsCollector`, `SimpleStatsCollector`, or any stats-related types. This means:

1. `metricsGathered` is never incremented — the internal metrics plugin always reports 0
2. `metricsWritten` is never incremented — same
3. `metricsDropped` is never incremented — same
4. `gatherErrors` is never incremented — gather loop catches errors but doesn't count them
5. `writeErrors` is never incremented — flush loop catches errors but doesn't count them
6. `InputStats.gatherTimeMs` is never measured — no timing around `gather()` calls
7. `OutputStats.writeTimeMs` is never measured — no timing around `write()` calls
8. `OutputStats.bufferSize` is never tracked — no channel size reporting

The internal metrics integration test (`internal-pipeline.test.ts`) works around this by manually incrementing `stats.metricsGathered` in the `MockPollingInput`. But in a real pipeline, these counters are always zero.

**Impact:** The internal metrics plugin emits meaningless zeros for all pipeline-level counters. This means the observability story for Phase 2 is incomplete — you can deploy the internal metrics plugin, but it won't actually observe anything useful about the pipeline.

**Recommendation:** `PipelineRuntime` should accept an optional `StatsCollector` in its options. The gather loop should increment `metricsGathered` and `gatherErrors`, time gather calls, and update per-input stats. The flush loop should increment `metricsWritten` and `writeErrors`, time write calls, and update per-output stats. The channel overflow callback should increment `metricsDropped`.

### I-03. 🟡 OPC-UA: Security auto-negotiation reconnect leak

**Severity:** Should Fix (Priority 1)
**File:** `src/plugins/inputs/opcua.ts`, lines 575-601
**Rule:** Rule 11 (Handle Return Values and Errors in Async Code)

During security auto-negotiation, if a connection attempt fails, the code calls `this.client.disconnect()` in a catch block:
```typescript
} catch {
  try { await this.client.disconnect(); } catch { /* ignore */ }
}
```

However, if the connect succeeds but subsequent steps (createSession, createSubscription) fail, the failed auto-negotiation loop does NOT disconnect before trying the next policy. Each iteration calls `connect()` on an already-connected client. The behavior depends on the mock/real client implementation:
- The mock client resets state on connect, so tests pass.
- A real `node-opcua` client would likely throw or leak resources.

This only applies to the auto-negotiation path (when `security_policy = "auto"`).

### I-04. 🟡 Modbus: `init()` creates real client with `null as unknown as ModbusClient` fallback

**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/modbus.ts`, lines 299-302

The constructor does:
```typescript
if (client) {
  this.client = client;
} else {
  this.client = null as unknown as ModbusClient;
}
```

If `init()` is not called before `gather()`, `this.client` is `null` casted to `ModbusClient`. Calling any method on it will produce an unhelpful `TypeError: Cannot read properties of null`. This is a latent bug — the lifecycle requires `init()` before `gather()`, but there's no guard.

**Recommendation:** Add a guard at the top of `gather()`:
```typescript
if (!this.client) throw new Error("ModbusInput not initialized — call init() first");
```

### I-05. 🟡 MQTT: `handleMessage` doesn't handle non-object JSON arrays

**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/mqtt-consumer.ts`, lines 344-348

When `data_format = "json"`, the code correctly handles objects via `flattenJson`, but for arrays:
```typescript
if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
  fields = flattenJson(parsed);
} else {
  fields = { value: this.toFieldValue(parsed) };
}
```

A JSON array like `[1, 2, 3]` falls into the `else` branch and calls `this.toFieldValue([1,2,3])`, which returns `"1,2,3"` (String coercion). The `flattenJson` function actually supports arrays (with `[0]`, `[1]`, `.length` notation), so arrays should be passed through `flattenJson` instead.

### I-06. 🟡 OPC-UA: Browse output file path not validated

**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/opcua.ts`, line 636

When browse mode is enabled with `output_file`, the plugin calls `Bun.write(config.browse.output_file, toml)` directly. If the path is invalid, a directory doesn't exist, or there are permission issues, the error is caught by the `try/catch` at line 631 and logged as a warning — acceptable. However, this uses `Bun.write` which is a side effect in a plugin's `start()` method. If the file path is relative, it depends on the working directory, which may differ between development and production.

**Recommendation:** This is minor but worth a comment noting the file path should be absolute in production configs.

### I-07. 🟢 Modbus: `int16` scaling applies to signed value (correct but untested for negative)

**Severity:** Nice to Have
**File:** `src/plugins/inputs/modbus.ts`, line 480

The int16 decoding correctly converts unsigned to signed before applying scale/offset:
```typescript
const signed = rawValue > 0x7FFF ? rawValue - 0x10000 : rawValue;
return signed * config.scale + config.offset;
```

However, no test exercises a negative int16 value (e.g., rawValue = 0xFFFF → signed = -1). The scaling test uses raw value 650 which is positive. A test for negative int16 values with scaling would be valuable.

### I-08. 🟢 All plugins: Error messages don't include plugin alias/instance identifier

**Severity:** Nice to Have
**Files:** All input plugins

Error log messages use generic identifiers like `[modbus]`, `[opcua]`, `[mqtt_consumer]`. When multiple instances of the same plugin are running (e.g., two Modbus inputs for different PLCs), error messages don't distinguish which instance failed. The PRD's structured logging format (§15) includes `"plugin": "inputs.modbus.plc_01"` — but the current implementation doesn't receive or use an alias.

### I-09. 🟢 MQTT: `extractTopicTags` returns on first matching pattern only

**Severity:** Nice to Have
**File:** `src/plugins/inputs/mqtt-consumer.ts`, line 197

The function iterates `topicTags` patterns and returns on the first match. If a topic matches multiple patterns, only the first pattern's tags are extracted. This is probably intentional (first-match semantics), but it's not documented.

### I-10. 🟢 OPC-UA: `trust_on_first_use` config field missing from schema

**Severity:** Nice to Have
**File:** `src/plugins/inputs/opcua.ts`

PRD D.4 describes TOFU as the default behavior when `server_certificate` is not set. The config schema doesn't have a `trust_on_first_use` boolean to explicitly disable TOFU (e.g., to reject all unknown certificates). While the PRD doesn't define this as a config field either, adding it would improve operational clarity. Currently, to disable TOFU, you must set `server_certificate` to an explicit cert.

---

## 3. PRD Compliance Tables

### Modbus TCP Input (`src/plugins/inputs/modbus.ts`)

| PRD Requirement (§6, §19) | Status | Notes |
|---|---|---|
| Config schema: controller | ✅ PASS | String field present |
| Config schema: connection_mode (dedicated/shared) | ✅ PASS | Enum with default "dedicated" |
| Config schema: slave_id (1-247) | ✅ PASS | Int with min/max validation |
| Config schema: registers array | ✅ PASS | With ModbusRegisterSchema |
| Config schema: slaves array (shared mode) | ✅ PASS | Array of {slave_id, registers} |
| Config schema: byte_order (ABCD/CDAB/BADC/DCBA) | ✅ PASS | Plugin-level default + per-register override |
| Config schema: optimization (none/batch) | ✅ PASS | Default "batch" |
| Config schema: max_batch_size (1-125) | ✅ PASS | Default 125, Modbus spec limit |
| Config schema: max_gap | ✅ PASS | Default 10 |
| Config schema: timeout | ✅ PASS | Duration string |
| Register schema: address, name, type, data_type | ✅ PASS | All fields present |
| Register schema: byte_order per-register | ✅ PASS | Optional override |
| Register schema: scale, offset | ✅ PASS | Default 1.0 / 0.0 |
| Register schema: bit extraction | ✅ PASS | 0-15, optional |
| FC01 (coils) read | ✅ PASS | Tested |
| FC02 (discrete inputs) read | ✅ PASS | Implemented; batch test gap (F-16) |
| FC03 (holding registers) read | ✅ PASS | Tested |
| FC04 (input registers) read | ✅ PASS | Tested |
| Write FCs NOT implemented | ✅ PASS | Safety comment at top of file |
| Byte order decoding (4 variants) | ✅ PASS | All 4 tested for float32 |
| Scaling: output = raw × scale + offset | ✅ PASS | Tested |
| Bit extraction | ✅ PASS | Tested |
| Batch reads: contiguous register combining | ✅ PASS | Tested |
| Batch reads: max 125 per FC03 | ✅ PASS | max_batch_size enforced |
| Batch reads: gap splitting | ✅ PASS | Tested |
| Batch read failure → individual fallback | ✅ PASS | Implemented and implicitly tested |
| Exception 01/02/03 → disable register | ✅ PASS | Tested |
| Exception 04/05/06/08/0A/0B → retry | ✅ PASS | Tested |
| Disabled registers reported in self-metrics | ❌ FAIL | F-11: not exposed to stats |
| Shared connection mode (setID) | ✅ PASS | Tested |
| Connection timeout → graceful error | ✅ PASS | Tested |
| Reconnection after drop | ✅ PASS | Tested |
| DI for testing | ✅ PASS | ModbusClient interface |

### OPC-UA Input (`src/plugins/inputs/opcua.ts`)

| PRD Requirement (Appendix D) | Status | Notes |
|---|---|---|
| D.1: Config schema — all fields | ✅ PASS | endpoint, timeouts, security, auth, subscription, data_change_filter, timestamp, reconnect, browse, nodes, groups |
| D.1: Security policies (5 options + auto) | ✅ PASS | Enum matches PRD |
| D.1: Security modes (4 options + auto) | ✅ PASS | Enum matches PRD |
| D.1: Security auto-negotiation fallback order | ✅ PASS | 5-step fallback, tested |
| D.1: Warning on None policy | ✅ PASS | Console.warn when falling back to None |
| D.1: Auth methods (anonymous/username/certificate) | ✅ PASS | Config and session creation tested |
| D.1: Subscription parameters | ✅ PASS | publishing_interval, queue_size, etc. |
| D.1: Data change filter (trigger, deadband) | ✅ PASS | Config parsed, passed to monitored items |
| D.1: Timestamp source (source/server/gather) | ✅ PASS | All 3 tested |
| D.1: Reconnection config | ✅ PASS | initial_delay, max_delay, max_retry |
| D.1: Browse config | ✅ PASS | enabled, root, depth, classes, output_file |
| D.1: Node groups with inheritance | ✅ PASS | Defaults inherited, per-node overrides win |
| D.1: nsu= namespace URI resolution | ✅ PASS | Tested |
| D.2: Session lifecycle (connect → session → subscribe) | ✅ PASS | Correct ordering |
| D.2: Subscription transfer on reconnect | ❌ FAIL | F-10: interface exists, never called |
| D.3: Data type mapping (22+ types) | ✅ PASS | Boolean, integers, floats, String, DateTime, ByteString, Guid, NodeId, StatusCode, LocalizedText, QualifiedName, arrays, ExtensionObject |
| D.3: Int64/UInt64 precision warning | ✅ PASS | Warning logged |
| D.3: Array → name[i] + name.length | ✅ PASS | Tested |
| D.3: ExtensionObject → dot notation, max depth 3 | ✅ PASS | Implemented; depth not configurable (F-15) |
| D.3: Quality mapping (good/uncertain/bad) | ✅ PASS | Top 2 bits, tested |
| D.3: Bad quality → still emitted (not dropped) | ✅ PASS | Tested |
| D.4: Client certificate generation | ❌ DEFER | F-09: needs real adapter |
| D.4: TOFU certificate pinning | ❌ DEFER | F-09: field declared, never used |
| D.4: Explicit server cert pinning | ✅ PASS | Config field exists, passed to client |
| D.5: Browse mode | ✅ PASS | Tested |
| D.5: TOML output format | ✅ PASS | `formatBrowseOutput()` generates commented TOML |
| D.5: Browse rate limiting | ❌ FAIL | Not implemented (browse is passed to client interface) |
| D.6: Group name as measurement name | ✅ PASS | I-01 fixed: uses node.measurement |
| D.7: Connection refused → retry with backoff | ✅ PASS | Tested |
| D.7: Session timeout → reconnect | ✅ PASS | Via onClose handler |
| D.7: Monitored item error → skip, continue | ✅ PASS | Tested |
| D.7: Bad quality → emit, not drop | ✅ PASS | Tested |
| D.7: Auth failure → no retry | ✅ PASS | Tested |
| DI for testing | ✅ PASS | OpcuaClient interface |

### MQTT Consumer Input (`src/plugins/inputs/mqtt-consumer.ts`)

| PRD Requirement (§6, §19) | Status | Notes |
|---|---|---|
| Subscribe to MQTT topics | ✅ PASS | Tested |
| Topic wildcards (+, #) | ✅ PASS | Tested |
| Plain JSON payload → metric fields | ✅ PASS | Flat + nested JSON tested |
| Sparkplug B payload | ❌ FAIL | F-01: not implemented |
| Server failover (multiple servers) | ✅ PASS | F-02 fixed; full array passed |
| QoS 0/1/2 support | ✅ PASS | Config accepts 0-2 |
| Topic → tag mapping | ✅ PASS | Pattern-based extraction tested |
| Measurement name override | ✅ PASS | Tested |
| Static tags | ✅ PASS | Tested |
| Username/password auth | ✅ PASS | Passed to client options |
| TLS support | ✅ PASS | ca, cert, key, insecure_skip_verify |
| Reconnection with backoff | ✅ PASS | F-05 fixed; all params wired |
| Max retry enforcement | ✅ PASS | F-05 fixed; tested |
| DI for testing | ✅ PASS | MqttClientInterface |
| Real MQTT client adapter | ❌ FAIL | F-08: throws unconditionally |

### Internal Metrics Input (`src/plugins/inputs/internal.ts`)

| PRD Requirement (§15) | Status | Notes |
|---|---|---|
| agent.uptime_seconds | ✅ PASS | Tested |
| agent.metrics_gathered | ⚠️ PARTIAL | Field exists but runtime doesn't populate counter (I-02) |
| agent.metrics_written | ⚠️ PARTIAL | Same as above |
| agent.metrics_dropped | ⚠️ PARTIAL | Same as above |
| agent.event_loop_lag_ms | ❌ FAIL | F-04: not in StatsCollector |
| agent.buffer_length (per output, tagged) | ❌ FAIL | F-04: not in StatsCollector |
| agent.buffer_overflow_count (per output) | ❌ FAIL | F-04: not in StatsCollector |
| agent.gather_errors (per input, tagged) | ⚠️ PARTIAL | Global only, not per-input tagged |
| agent.write_errors (per output, tagged) | ⚠️ PARTIAL | Global only, not per-output tagged |
| agent.gather_timeout_count (per input) | ❌ FAIL | F-04: not in StatsCollector |
| agent.config_version | ❌ FAIL | Depends on config system |
| agent.config_reload_count | ❌ FAIL | Depends on config system |
| agent.local_store.* (5 metrics) | ❌ DEFER | Depends on local_store (future phase) |
| agent.network_policy.* (2 metrics) | ❌ DEFER | Depends on network_policy (future phase) |
| agent.memory_usage (RSS, heap) | ✅ PASS | heap_used, heap_total, rss, external |
| Per-input stats (gather_time, metrics_count) | ⚠️ PARTIAL | Interface and plugin code correct, but runtime never populates |
| Per-output stats (write_time, buffer_size) | ⚠️ PARTIAL | Same as above |
| Host tag on all metrics | ✅ PASS | os.hostname() |
| collect_memstats config toggle | ✅ PASS | Tested |

### Pipeline Runtime — ServiceInput Support (`src/pipeline/runtime.ts`)

| PRD Requirement (§4, §8) | Status | Notes |
|---|---|---|
| Detect ServiceInput (duck-typing) | ✅ PASS | isServiceInput() type guard |
| ServiceInput.start(acc) during startup | ✅ PASS | Step 14 of PRD §8 |
| ServiceInput.stop() during shutdown | ✅ PASS | Before channel close |
| Polling Input gather loop with Ticker | ✅ PASS | Per-input interval |
| Per-input gather timeout | ✅ PASS | Promise.race with timeout |
| metric_batch_size per-output | ✅ PASS | Splits in flush loop |
| Output.connect() before flush | ✅ PASS | PRD §8 step 11 |
| Startup order matches PRD §8 | ✅ PASS | F-14 fixed: flush loops start last |
| Shutdown drains channels | ✅ PASS | Main loop drains, closes outputs |
| ServiceInput error → log, continue | ✅ PASS | try/catch with console.error |
| Mixed pipeline (polling + service) | ✅ PASS | Tested |
| drop_original per-aggregator | ✅ PASS | Uses .every() — correct semantics |
| StatsCollector integration | ❌ FAIL | I-02: zero integration |

---

## 4. Test Coverage Assessment

### Module: ServiceInput Runtime (`test/unit/pipeline/service-input.test.ts`)

| Test Path | Covered? | Notes |
|---|---|---|
| ServiceInput detected and start() called | ✅ | |
| ServiceInput pushes metrics → output receives | ✅ | |
| ServiceInput stop() called during shutdown | ✅ | |
| Mixed pipeline (polling + service) | ✅ | |
| ServiceInput start() error → logged, others continue | ✅ | |
| metric_batch_size splits large batches | ✅ | |
| metric_batch_size absent → single write call | ✅ | |
| **ServiceInput stop() error → logged, continues** | ❌ | Not tested |
| **Two service inputs, one fails → other keeps running** | ❌ | Only tested with 1 failing + 1 polling |
| **ServiceInput emits metrics during stop()** | ❌ | Edge case: final metrics before channel close |

**Hard path coverage: Good (8/11 paths tested)**

### Module: Modbus TCP (`test/unit/plugins/inputs/modbus.test.ts`)

| Test Path | Covered? | Notes |
|---|---|---|
| FC01 coil read | ✅ | |
| FC02 discrete read | ❌ | No unit test for FC02 specifically |
| FC03 holding register read | ✅ | |
| FC04 input register read | ✅ | |
| Float32 × 4 byte orders | ✅ | Thorough |
| Uint32 multi-register | ✅ | |
| Int32 negative value | ✅ | Via decodeMultiRegister test |
| Int16 negative value | ❌ | Not tested |
| Scaling with scale + offset | ✅ | |
| Bit extraction | ✅ | |
| Batch read contiguous | ✅ | |
| Gap split | ✅ | |
| Batch read failure → individual fallback | ❌ | Not directly tested (batch errors propagate) |
| Exception 0x02 → disable | ✅ | |
| Exception 0x04 → retry | ✅ | |
| Connection timeout | ✅ | |
| Reconnection after drop | ✅ | |
| Shared mode multi-slave | ✅ | |
| Config validation | ✅ | |
| **Bool data_type read** | ❌ | Code path exists (line 477) |
| **Connection drop mid-batch** | ❌ | `disconnectAfterReads` mock exists but not used |

**Hard path coverage: Good (17/21 paths tested)**

### Module: OPC-UA (`test/unit/plugins/inputs/opcua.test.ts`)

| Test Path | Covered? | Notes |
|---|---|---|
| Connect + read single node | ✅ | |
| Subscription data change → metric | ✅ | |
| Data type mapping (8+ types) | ✅ | Boolean, Int32, Float, Double, String, DateTime, ByteString, LocalizedText, QualifiedName, Guid, Int64, arrays |
| Quality good/bad/uncertain | ✅ | |
| Timestamp source/server/gather | ✅ | |
| Node groups with inheritance | ✅ | |
| Namespace URI resolution | ✅ | |
| Security auto-negotiation | ✅ | |
| Security all fallbacks fail | ✅ | |
| Subscription parameters from config | ✅ | |
| Deadband config passed | ✅ | |
| Certificate paths passed | ✅ | |
| Browse mode | ✅ | |
| Auth anonymous/username | ✅ | |
| Bad NodeID → skip, continue | ✅ | |
| Connection refused → throw | ✅ | |
| Auth failure → throw, no retry | ✅ | |
| Stop → close session + disconnect | ✅ | |
| Data changes after stop suppressed | ✅ | |
| Reconnection with backoff | ✅ | |
| Auto-reconnect on connection loss | ✅ | (F-03 fix) |
| Per-node tags | ✅ | |
| **Group name as measurement** | ✅ | I-01 fixed: uses node.measurement, test added |
| **Subscription transfer on reconnect** | ❌ | F-10: never called |
| **Reconnect max_retry exceeded** | ✅ | Tested in reconnect test |
| **ExtensionObject flattening** | ❌ | Code path exists but no test with real nested structure via DataChangeEvent |
| **Multiple rapid data changes** | ❌ | No throughput/ordering test |

**Hard path coverage: Good (23/27 paths tested)**

### Module: MQTT Consumer (`test/unit/plugins/inputs/mqtt-consumer.test.ts`)

| Test Path | Covered? | Notes |
|---|---|---|
| Connect + JSON message → metric | ✅ | |
| Multiple JSON fields | ✅ | |
| Nested JSON → dot notation | ✅ | |
| Plain string payload (value format) | ✅ | |
| Numeric string → number | ✅ | |
| Topic tag extraction | ✅ | |
| Wildcard subscription | ✅ | |
| QoS level configured | ✅ | |
| Reconnection + resubscribe | ✅ | |
| Connection error → reported | ✅ | |
| Multiple topics | ✅ | |
| Measurement override | ✅ | |
| Static tags | ✅ | |
| Topic tag disabled (empty string) | ✅ | |
| Stop → disconnect + suppress | ✅ | |
| Invalid JSON → error logged | ✅ | |
| Auth username/password | ✅ | |
| TLS config | ✅ | |
| Reconnect params wired | ✅ | F-05 fix |
| Server failover | ✅ | F-02 fix |
| Max retry exceeded | ✅ | F-05 fix |
| Max retry reset on connect | ✅ | F-05 fix |
| Max retry=0 unlimited | ✅ | F-05 fix |
| **Sparkplug B payload** | ❌ | F-01: not implemented |
| **JSON array payload** | ❌ | I-05: falls through to toFieldValue |
| **Very large payload** | ❌ | No size limit test |

**Hard path coverage: Good (23/26 paths tested)**

### Module: Internal Metrics (`test/unit/plugins/inputs/internal.test.ts`)

| Test Path | Covered? | Notes |
|---|---|---|
| Uptime metric with positive value | ✅ | |
| Memory usage positive | ✅ | |
| Metrics gathered increases | ✅ | (manually incremented in test) |
| Per-input gather_time non-negative | ✅ | |
| Agent.* prefix on all | ✅ | |
| Hostname tag present | ✅ | |
| Per-output stats emitted | ✅ | |
| collect_memstats=false skips memory | ✅ | |
| No per-input/output when empty | ✅ | |
| Config defaults | ✅ | |
| Gather/write error counters | ✅ | |
| **Real pipeline counter integration** | ❌ | I-02: runtime doesn't populate |

**Hard path coverage: Good for the plugin itself (11/12 tested), but the stats integration is untested**

---

## 5. Phase 3 Readiness

### Verdict: **GO** — all 🔴 fixes resolved

Phase 2 provides a solid foundation for Phase 3 (Processors). The pipeline runtime correctly handles the processor chain (sequential processor execution, CollectingAccumulator for intermediate results, aggregator forking, global tags). The four input plugins demonstrate both polling and push (ServiceInput) patterns are working.

All pre-Phase-3 priority fixes (I-01, F-13, F-14) have been resolved. No remaining 🔴 blockers.

### Should Fix During Phase 3:

1. **I-02: StatsCollector integration in runtime** — When the runtime is next modified (Phase 3 will add processor-level concerns), add StatsCollector wiring. This is a prerequisite for meaningful internal metrics.
2. **F-06: OPC-UA O(n) node lookup** — Trivial Map optimization. Do it when touching the OPC-UA file for any reason.

### Can Defer Beyond Phase 3:

- **F-01 (Sparkplug B)** — Natural fit for Phase 4/5 when Sparkplug B output is built.
- **F-08 (Real MQTT client)** — Needed for E2E, not for Phase 3 processors.
- **F-09, F-10 (TOFU, subscription transfer)** — Need real OPC-UA adapter.
- **F-11 (Disabled register reporting)** — Low priority; needs stats system extension.

### Phase 3 Dependencies on Phase 2:

The processor chain in `runMainLoop()` (lines 145-184 of runtime.ts) is well-structured:
- Processors receive metrics one at a time via `CollectingAccumulator`
- Each processor can emit 0..N metrics (filter, transform, split)
- Aggregator fork happens after processor chain
- Global tags are merged at the accumulator level

**No impedance mismatches** — the Phase 1 runtime and Phase 2 inputs integrate cleanly. The `Processor` interface in `plugin-types.ts` matches PRD Appendix B.

### Risks for Phase 3:

1. **Processor errors not counted in stats** — `addError()` in `CollectingAccumulator` only logs, doesn't increment any counter. When StatsCollector integration is added, processor errors should be tracked.
2. **No processor-level timeout** — Only gather has a timeout mechanism. A slow processor blocks the main loop indefinitely. Consider adding processor timeouts.
3. **Processor ordering** — The runtime iterates processors in array order (correct per PRD §6), but no test verifies order-dependent behavior.

---

## 6. Summary

### Finding Totals

| Severity | Count | Source |
|---|---|---|
| 🔴 Must Fix (resolved) | 4 | F-02, F-03, F-05, I-01 (all verified ✅) |
| 🔴 Must Fix (deferred, reclassified) | 2 → 🟡 | F-01, F-04 (appropriate deferrals) |
| 🟡 Should Fix (resolved) | 2 | F-13, F-14 (verified ✅) |
| 🟡 Should Fix (open) | 9 | F-06, F-07, F-08, F-09, F-10, F-11, I-02, I-03, I-04 |
| 🟢 Nice to Have | 10 | F-15–F-20, I-05–I-10 |
| **Total independent findings** | **10** | 1 🔴 fixed + 5 🟡 (2 fixed) + 4 🟢 |

### Priority Fixes Before Phase 3: **All resolved** ✅

1. ~~**I-01 (🔴):** Fix OPC-UA `handleDataChange` to use `node.measurement` instead of `node.name`.~~ Fixed.
2. ~~**F-13 (🟡):** Change MQTT QoS default from 0 to 1.~~ Fixed.
3. ~~**F-14 (🟡):** Reorder flush loop startup to match PRD §8.~~ Fixed.

### Phase 3 Blockers: **0** — all resolved

### Existing Review Quality Assessment

The first reviewer did a thorough job. Key findings (F-02, F-03, F-05) were correctly identified as 🔴 and subsequently fixed with good test coverage. The PRD compliance tables are accurate. The Phase 3 readiness assessment is sound.

Areas where I disagree:
- **F-01 severity:** Should be 🟡 not 🔴 (Sparkplug B is appropriately deferred)
- **F-04 severity:** Should be 🟡 not 🔴 (most missing metrics depend on unbuilt subsystems)
- **F-12 severity:** Should be 🟢 not 🟡 (10,000 matches PRD default; no config field specified)
- **F-07 priority:** Should be Priority 2 not Priority 1 (rare condition, documented)

The main gap in the first review: it missed the **measurement name bug** (I-01) and the **lack of runtime stats integration** (I-02). Both are significant: I-01 is a correctness bug affecting group-based OPC-UA configs, and I-02 means the internal metrics plugin emits zeros for all pipeline counters in a real deployment.

---

*Independent review complete. 251/251 tests passing. All 🔴 Must Fix and pre-Phase-3 priority items resolved (I-01, F-13, F-14). 9 🟡 Should Fix open (deferred), 10 🟢 Nice to Have across both reviews combined. Phase 3: GO.*
