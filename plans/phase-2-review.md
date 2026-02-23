# Phase 2 Code Review: Inputs

**Reviewer:** Claude Opus 4.6 (independent context -- not the implementing agent)
**Date:** 2026-02-23
**Scope:** All source and test files created or modified in Phase 2 (Tasks 2.0--2.4i)
**Test status:** 251/251 pass, 0 fail, 863 expect() calls (post-fix)

---

## Executive Summary

Phase 2 delivers four input plugins (Modbus TCP, OPC-UA, MQTT Consumer, Internal Metrics) plus ServiceInput runtime support. The implementation is solid: all four plugins have DI-based testable architectures, comprehensive config schemas, and well-structured error handling. Test coverage is strong on happy paths and moderately good on error paths.

There are **5 Must Fix** findings (3 resolved: F-02, F-03, F-05), **9 Should Fix** findings, and **6 Nice to Have** findings. Remaining Must Fix items: missing Sparkplug B payload support (F-01, deferred), missing PRD-specified internal metrics (F-04, deferred — depends on subsystems not yet built).

Phase 3 readiness: **GO** -- the 3 blocking Must Fix items (F-02, F-03, F-05) are resolved. F-01 and F-04 are deferred per review guidance.

---

## Findings

### Must Fix

#### F-01. MQTT Consumer: Sparkplug B payload support missing
**Severity:** Must Fix
**File:** `src/plugins/inputs/mqtt-consumer.ts`
**Rule:** Rule 5 (PRD Is the Spec)
**PRD ref:** SS19

PRD SS19 states: "mqtt_consumer: Subscribe to MQTT topics. **Plain and Sparkplug B payloads.**" The current implementation supports `data_format: "json" | "value"` but has no `"sparkplug_b"` option. Sparkplug B is a binary protobuf format -- it cannot be parsed by the JSON or value parsers.

**Impact:** Sparkplug B is the primary protocol for Hub communication (PRD SS17). An MQTT consumer that cannot parse Sparkplug B payloads cannot ingest data from other Sparkplug B devices on the same broker -- a core IIoT scenario.

**Recommendation:** Add `data_format: "sparkplug_b"` option. This requires the `sparkplug-payload` library (or equivalent protobuf decoder). If deferred to a later phase, add an explicit TODO with phase reference and update the phase plan to document the deferral.

---

#### F-02. ~~MQTT Consumer: Only connects to first server, ignores failover list~~ RESOLVED
**Severity:** Must Fix → **Fixed**
**File:** `src/plugins/inputs/mqtt-consumer.ts`

**Resolution:** Changed `MqttClientInterface.connect()` to accept `servers: string[]` instead of single `brokerUrl: string`. Plugin now passes the full `config.servers` array to the client. Test added verifying all servers are passed through. The real mqtt.js wrapper can use this array for broker failover.

---

#### F-03. ~~OPC-UA: reconnect() is public but never called automatically~~ RESOLVED
**Severity:** Must Fix → **Fixed**
**File:** `src/plugins/inputs/opcua.ts`

**Resolution:** Added `onClose(handler: () => void)` to `OpcuaClient` interface. Registered handler in `connectAndSubscribe()` that calls `this.reconnect()` on connection loss. Test verifies: connection loss → auto-reconnect → data flows again. Note: `transferSubscriptions` per PRD D.7 is deferred (F-10, Should Fix).

---

#### F-04. Internal Metrics: Missing 10+ PRD-specified metrics
**Severity:** Must Fix
**File:** `src/plugins/inputs/internal.ts`, `src/core/stats.ts`
**Rule:** Rule 8 (Interface Compliance Check)
**PRD ref:** SS15 Observability

PRD SS15 defines 18 metrics in the agent self-metrics table. The implementation emits 9 of them. Missing metrics:

| PRD Metric | Status |
|---|---|
| `agent.event_loop_lag_ms` | Missing |
| `agent.buffer_length` (per output, tagged) | Missing |
| `agent.buffer_overflow_count` (per output) | Missing |
| `agent.gather_timeout_count` (per input, tagged) | Missing |
| `agent.config_version` | Missing |
| `agent.config_reload_count` | Missing |
| `agent.local_store.used_bytes` | Missing |
| `agent.local_store.available_bytes` | Missing |
| `agent.local_store.days_remaining` | Missing |
| `agent.local_store.retention_evictions` | Missing |
| `agent.local_store.backup_last_success` | Missing |
| `agent.network_policy.mode` | Missing |
| `agent.network_policy.blocked_connections` | Missing |

**Mitigation:** Several of these depend on subsystems not yet built (local_store, network_policy, config reload). However, `event_loop_lag_ms`, `buffer_length`, `buffer_overflow_count`, and `gather_timeout_count` are pipeline-level metrics that could be implemented now. The StatsCollector interface needs corresponding fields.

**Recommendation:** At minimum, add `event_loop_lag_ms` and `gather_timeout_count` now (these are observable at the pipeline runtime level). Add TODO comments with phase references for the local_store and network_policy metrics. Update StatsCollector interface to include the fields that are implementable today.

---

#### F-05. ~~MQTT Consumer: reconnect max_delay and max_retry not wired~~ RESOLVED
**Severity:** Must Fix → **Fixed**
**File:** `src/plugins/inputs/mqtt-consumer.ts`

**Resolution:** All three reconnect config values now wired:
- `initial_delay` → `MqttClientOptions.reconnectPeriod` (was already working)
- `max_delay` → `MqttClientOptions.maxReconnectDelay` (new field)
- `max_retry` → `MqttClientOptions.maxReconnectAttempts` (new field) + plugin-level enforcement via `onReconnect` handler that tracks attempts and disconnects when limit exceeded. Counter resets on successful connect. Tests verify: max_retry caps attempts, counter resets on reconnect, max_retry=0 means unlimited.

---

### Should Fix

#### F-06. OPC-UA: handleDataChange uses O(n) linear scan per event
**Severity:** Should Fix (Priority 1)
**File:** `src/plugins/inputs/opcua.ts`, line 674
**Rule:** Performance concern

```typescript
const node = this.expandedNodes.find((n) => n.node_id === event.nodeId);
```

This is called on every data change notification. With 500+ monitored nodes (realistic for a large OPC-UA server), this becomes a bottleneck at high notification rates.

**Recommendation:** Build a `Map<string, ExpandedNode>` during `expandNodes()` and use `this.nodeMap.get(event.nodeId)` for O(1) lookup.

---

#### F-07. Runtime: gather timeout creates orphan Promise (documented but unfixed)
**Severity:** Should Fix (Priority 1)
**File:** `src/pipeline/runtime.ts`, lines 115-126
**Rule:** Rule 11 (Handle Return Values and Errors in Async Code)

The TODO on line 115 acknowledges this: when `Promise.race` picks the timeout, the original `gather()` call continues running in the background. On resource-constrained devices (Pi 4), accumulated orphan gather calls can exhaust memory.

**Recommendation:** Add `AbortSignal` support to the Input interface for cooperative cancellation. This is an interface-level change that should be considered for Phase 3 or as a follow-up. At minimum, track concurrent orphan count and log a warning if it exceeds a threshold.

---

#### F-08. MQTT Consumer: createDefaultMqttClient() throws unconditionally
**Severity:** Should Fix (Priority 1)
**File:** `src/plugins/inputs/mqtt-consumer.ts`, lines 370-376

The factory function always throws with a message directing users to inject a mock. This means the plugin cannot be used in a real pipeline without custom wiring code -- it has no production-ready MQTT client adapter.

**Recommendation:** Implement the real `mqtt.js` wrapper (the `mqtt` package). This is needed before the plugin can be used outside of tests.

---

#### F-09. OPC-UA: TOFU and certificate generation not implemented
**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/opcua.ts`
**Rule:** Rule 8 (Interface Compliance Check)
**PRD ref:** Appendix D SS D.4

PRD D.4 specifies Trust-On-First-Use (TOFU) certificate pinning and self-signed certificate generation as core security features. The implementation has the config fields (`trust_on_first_use`, `certificate`, `private_key`) but TOFU logic is not implemented -- the `trustedFingerprint` field is declared but never assigned or checked.

**Recommendation:** TOFU and certificate generation likely require the real `node-opcua` client. Document clearly that these are deferred to the real client adapter phase with explicit TODO references. Verify the OPC-UA client interface exposes the needed certificate information.

---

#### F-10. OPC-UA: subscription transfer not implemented
**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/opcua.ts`
**Rule:** Rule 8 (Interface Compliance Check)
**PRD ref:** Appendix D SS D.7 -- "Session timeout: Reconnect, attempt subscription transfer"

The OPC-UA client interface includes `transferSubscriptions()` but it is never called during reconnection. The `reconnect()` method calls `connectAndSubscribe()` which creates a new subscription from scratch.

**Impact:** Without subscription transfer, reconnection is slower (must re-add all monitored items) and may miss data points during the gap. Subscription transfer is an OPC-UA standard feature that preserves queued notifications from the server.

**Recommendation:** In `reconnect()`, attempt `transferSubscriptions()` first. If it fails (server may not support it), fall back to full `connectAndSubscribe()`.

---

#### F-11. Modbus: disabled registers not reported in self-metrics
**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/modbus.ts`
**Rule:** Rule 8 (Interface Compliance Check)
**PRD ref:** SS6 -- "Disabled registers are reported in self-metrics and Web UI"

When a register receives a DISABLE_EXCEPTION (0x01, 0x02, 0x03), it is permanently disabled and added to `this.disabledRegisters`. However, this set is never exposed to the stats system or self-metrics. Users have no way to know which registers are disabled without reading logs.

**Recommendation:** Add a method (e.g., `getDisabledRegisters(): string[]`) or emit the count via the stats collector. The internal metrics plugin should report this.

---

#### F-12. Runtime: output channels hardcoded to capacity 10000
**Severity:** Should Fix (Priority 2)
**File:** `src/pipeline/runtime.ts`, line 341
**Rule:** Rule 10 (No Hardcoded Config Overrides)
**PRD ref:** SS4 -- "per-output channel with capacity 10000"

```typescript
const ch = new Channel<Metric>({ capacity: 10_000 });
```

While 10,000 matches the PRD default, it is hardcoded. The PRD mentions this as a default, not a fixed value. If an output needs a larger buffer (e.g., store-and-forward over a slow network), there is no way to configure it.

**Recommendation:** Add an optional `bufferCapacity` field to the output configuration in `PipelineOptions`, defaulting to 10,000. Similarly, line 371 hardcodes the input channel capacity.

---

#### F-13. MQTT Consumer: QoS default is 0, phase plan says 1
**Severity:** Should Fix (Priority 2)
**File:** `src/plugins/inputs/mqtt-consumer.ts`, line 28
**Rule:** Rule 10 (No Hardcoded Config Overrides)

The config schema defaults `qos` to `0`:
```typescript
qos: z.number().int().min(0).max(2).default(0)
```

The phase plan (`plans/phase-2-inputs.md`) for task 2.3 specifies QoS 1 as the default for industrial MQTT to avoid data loss. QoS 0 (fire-and-forget) is inappropriate as the default for manufacturing data collection where every reading matters.

**Recommendation:** Change default to `1` per the phase plan rationale.

---

#### F-14. Runtime: startup order deviates from PRD SS8 for flush loops
**Severity:** Should Fix (Priority 2)
**File:** `src/pipeline/runtime.ts`, lines 346-358
**Rule:** Rule 12 (Lifecycle Ordering Matches the PRD)

PRD SS8 specifies: Step 11 connect outputs, Step 12 build processor chain, Step 13 start aggregators, Step 14 start service inputs, Step 15 begin gather loops, **Step 16 begin flush loops**.

The implementation starts flush loops (step 3 in code, line 351) immediately after connecting outputs, before starting inputs. While this is not functionally broken (flush loops idle until data arrives), it deviates from the PRD sequence which starts flush loops last.

**Recommendation:** Reorder to match PRD: start flush loops after gather loops and service inputs, not before. This ensures the timing of the first flush aligns with data availability.

---

### Nice to Have

#### F-15. OPC-UA: flattenObject max depth hardcoded to 3
**Severity:** Nice to Have
**File:** `src/plugins/inputs/opcua.ts`

The `flattenObject()` utility for ExtensionObject values has `maxDepth = 3` hardcoded. Deeply nested OPC-UA structures (e.g., complex event types) would be silently truncated.

**Recommendation:** Consider making this configurable, or at minimum document the limitation.

---

#### F-16. Modbus: no test for FC02 (discrete input) in batch mode
**Severity:** Nice to Have
**File:** `test/unit/plugins/inputs/modbus.test.ts`
**Rule:** Rule 9 (Test the Hard Paths First)

Tests cover FC01 (coils), FC03 (holding), FC04 (input) reads well. FC02 (discrete inputs) is tested for single reads but not in batch mode scenarios. The `readBatch()` method has a dedicated code path for `registerType === "discrete"` (line 410) that should be explicitly tested.

---

#### F-17. OPC-UA: no test for Int64 precision loss warning path
**Severity:** Nice to Have
**File:** `test/unit/plugins/inputs/opcua.test.ts`

The OPC-UA test for Int64 verifies the log message appears, but does not assert what value is returned when precision loss occurs. The `mapOpcuaValue()` function for Int64 should either return the truncated Number or a string -- the test should verify which.

---

#### F-18. All plugins: no explicit init() lifecycle test
**Severity:** Nice to Have
**File:** `test/unit/plugins/inputs/*.test.ts`

The Modbus plugin has `init()` which loads the modbus-serial library dynamically and connects. While the integration tests exercise this path, there is no unit test specifically for `init()` behaviour (e.g., what happens when `init()` is called twice, or when the connection fails during `init()`).

---

#### F-19. MQTT Consumer: flattenJson has no depth limit
**Severity:** Nice to Have
**File:** `src/plugins/inputs/mqtt-consumer.ts`, line 126

`flattenJson()` recurses without a depth limit. A malicious or buggy MQTT publisher sending deeply nested JSON could cause a stack overflow.

**Recommendation:** Add a max depth parameter (e.g., 10) with a sensible default.

---

#### F-20. Test timing sensitivity in integration tests
**Severity:** Nice to Have
**Files:** `test/integration/*.test.ts`

Several integration tests use `Bun.sleep(300)` to wait for gather/flush cycles. While these are currently passing, the fixed sleep values are sensitive to system load:
- `modbus-pipeline.test.ts`: 300ms sleep, 50ms intervals (6 cycles expected)
- `internal-pipeline.test.ts`: 300ms sleep, 50ms intervals
- `mqtt-pipeline.test.ts`: 200ms sleep, 50ms intervals

On a heavily loaded CI machine or a slow Pi 4, these could become flaky.

**Recommendation:** Consider using condition-based waits (poll until expected metrics arrive, with a maximum timeout) instead of fixed sleeps.

---

## PRD Compliance Tables

### Modbus TCP Input (`src/plugins/inputs/modbus.ts`)

| PRD Requirement | Status | Notes |
|---|---|---|
| Config schema (SS6) | PASS | All fields present: controller, connection_mode, slave_id, registers, slaves, byte_order, optimization, max_batch_size, max_gap, timeout |
| Register schema (SS6) | PASS | address, name, type, data_type, byte_order, scale, offset, bit |
| FC01 (coils) | PASS | Tested |
| FC02 (discrete inputs) | PASS | Implemented; batch test missing (F-16) |
| FC03 (holding registers) | PASS | Tested |
| FC04 (input registers) | PASS | Tested |
| Write FCs not implemented | PASS | Safety comment at top of file |
| Byte order: ABCD/CDAB/BADC/DCBA | PASS | All 4 tested for float32 |
| Scaling and offset | PASS | Tested |
| Bit extraction | PASS | Tested |
| Batch reads with fallback | PASS | Tested |
| Exception handling (disable: 01,02,03) | PASS | Tested |
| Exception handling (retry: 04,05,06,08,0A,0B) | PASS | Tested |
| Connection timeout | PASS | Tested |
| Reconnection | PASS | Tested |
| Shared/dedicated connection mode | PASS | Shared mode tested |
| Multi-slave support | PASS | Tested via slaves config |
| Disabled register reporting | FAIL | Not exposed to self-metrics (F-11) |
| DI for testing | PASS | ModbusClient interface |

### OPC-UA Input (`src/plugins/inputs/opcua.ts`)

| PRD Requirement | Status | Notes |
|---|---|---|
| Config schema (App D SS D.1) | PASS | All fields present |
| Security auto-negotiation | PASS | Tested with fallback order |
| Security: Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss | PASS | Config enum matches |
| Certificate trust - TOFU (D.4) | DEFER | Config field exists, logic not implemented (F-09) |
| Certificate trust - explicit pin (D.4) | DEFER | server_certificate field exists |
| Self-signed certificate generation (D.4) | DEFER | Not implemented |
| Browse mode (D.5) | PASS | Tested |
| Node groups with inheritance (D.1) | PASS | Tested |
| nsu= namespace URI resolution | PASS | Tested |
| Data type mapping (D.3, 22+ types) | PASS | Boolean, integers, floats, strings, DateTime, ByteString, LocalizedText, QualifiedName, Guid, Int64, arrays, ExtensionObject |
| Quality mapping (top 2 bits) | PASS | Tested |
| Timestamp: source/server/gather | PASS | Tested |
| Deadband: none/absolute/percent | PASS | Config and monitored item setup tested |
| Reconnection with backoff (D.7) | PARTIAL | Logic correct but not auto-triggered (F-03) |
| Subscription transfer | FAIL | Interface method exists, never called (F-10) |
| Per-node tags | PASS | Tested |
| Monitored item error handling (D.7) | PASS | Bad NodeID logged, skipped |
| Authentication: anonymous/username | PASS | Config and session creation tested |
| Authentication failure handling (D.7) | PASS | Not retried (config error) |
| DI for testing | PASS | OpcuaClient interface |

### MQTT Consumer Input (`src/plugins/inputs/mqtt-consumer.ts`)

| PRD Requirement | Status | Notes |
|---|---|---|
| Subscribe to MQTT topics | PASS | Tested |
| Plain payloads | PASS | JSON and value format tested |
| Sparkplug B payloads (SS19) | FAIL | Not implemented (F-01) |
| Server failover (servers array) | FAIL | Only first server used (F-02) |
| QoS 0/1/2 support | PASS | Config accepts 0-2 |
| Topic tag extraction | PASS | Pattern-based extraction tested |
| Wildcard topics (+, #) | PASS | Tested |
| Reconnection config | PARTIAL | initial_delay used; max_delay, max_retry discarded (F-05) |
| TLS support | PASS | Config and option wiring present |
| Authentication | PASS | Username/password passed to client |
| Nested JSON flattening | PASS | Tested with dot-notation |
| Measurement name override | PASS | Tested |
| Static tags | PASS | Tested |
| Topic tag disable (empty string) | PASS | Tested |
| DI for testing | PASS | MqttClientInterface |
| Real MQTT client | FAIL | createDefaultMqttClient() throws (F-08) |

### Internal Metrics Input (`src/plugins/inputs/internal.ts`)

| PRD Requirement | Status | Notes |
|---|---|---|
| agent.uptime_seconds | PASS | Tested |
| agent.metrics_gathered | PASS | Tested |
| agent.metrics_written | PASS | Tested |
| agent.metrics_dropped | PASS | Tested |
| agent.event_loop_lag_ms | FAIL | Not implemented (F-04) |
| agent.buffer_length | FAIL | Not implemented (F-04) |
| agent.buffer_overflow_count | FAIL | Not implemented (F-04) |
| agent.gather_errors | PASS | Global counter only, not per-input tagged |
| agent.write_errors | PASS | Global counter only, not per-output tagged |
| agent.gather_timeout_count | FAIL | Not implemented (F-04) |
| agent.config_version | FAIL | Depends on config system (F-04) |
| agent.config_reload_count | FAIL | Depends on config system (F-04) |
| agent.local_store.* (5 metrics) | FAIL | Depends on local_store (future phase) |
| agent.network_policy.* (2 metrics) | FAIL | Depends on network_policy (future phase) |
| agent.memory_usage | PASS | heap_used, heap_total, rss, external |
| agent.input (per-input) | PASS | gather_time_ms, metrics_count tagged |
| agent.output (per-output) | PASS | write_time_ms, buffer_size tagged |
| Host tag on all metrics | PASS | Tested |
| collect_memstats config | PASS | Tested |

### Pipeline Runtime ServiceInput Support (`src/pipeline/runtime.ts`)

| PRD Requirement | Status | Notes |
|---|---|---|
| ServiceInput detection (isServiceInput) | PASS | Duck-typing type guard |
| ServiceInput.start(acc) called | PASS | During pipeline start |
| ServiceInput.stop() during shutdown | PASS | Before channel close |
| Polling Input gather loop | PASS | With Ticker |
| Per-input interval | PASS | PipelineOptions.inputs[].interval |
| Per-input timeout | PASS | Promise.race with gather |
| metric_batch_size per-output | PASS | Splits batches in flush loop |
| Output connect before flush | PASS | PRD SS8 step 11 |
| Shutdown drains channels | PASS | Main loop drains then closes outputs |
| drop_original per-aggregator | PARTIAL | Uses .every() -- correct for "drop only if ALL want drop"; comment explains limitation |

### StatsCollector (`src/core/stats.ts`)

| PRD Requirement | Status | Notes |
|---|---|---|
| startTimeMs | PASS | |
| metricsGathered | PASS | |
| metricsWritten | PASS | |
| metricsDropped | PASS | |
| gatherErrors | PASS | Global only (PRD says per-input tagged) |
| writeErrors | PASS | Global only (PRD says per-output tagged) |
| Per-input stats | PASS | InputStats: name, gatherTimeMs, metricsCount |
| Per-output stats | PASS | OutputStats: name, writeTimeMs, bufferSize |
| event_loop_lag | FAIL | Not in interface |
| buffer_overflow_count | FAIL | Not in interface |
| gather_timeout_count | FAIL | Not in interface |

---

## Rules 1-13 Compliance

| Rule | Status | Notes |
|---|---|---|
| 1. No Hand-Waving | PASS | All tests pass. No skipped tests. No flaky test workarounds. |
| 2. Tests Prove Behaviour | PASS | Tests focus on data correctness, failure modes, contracts. Good coverage of error paths in Modbus and OPC-UA. |
| 3. Small Verified Steps | PASS | Phase progress shows 9 incremental tasks, each committed separately. |
| 4. One Thing at a Time | PASS | Each plugin built and tested independently. |
| 5. PRD Is the Spec | PARTIAL | Sparkplug B requirement missed (F-01). Internal metrics missing several PRD entries (F-04). |
| 6. Commit Discipline | PASS | Commits are well-structured per phase-2-progress.md. |
| 7. No Premature Abstraction | PASS | Clean DI interfaces without over-engineering. |
| 8. Interface Compliance Check | PARTIAL | OPC-UA and MQTT configs match PRD well. Internal metrics interface incomplete (F-04). TOFU fields declared but unimplemented (F-09). |
| 9. Test the Hard Paths First | PARTIAL | Modbus exception handling well-tested. OPC-UA reconnection tested but never auto-triggered (F-03). FC02 batch path untested (F-16). |
| 10. No Hardcoded Config Overrides | PARTIAL | MQTT servers[0] hardcoded (F-02). Channel capacity 10000 hardcoded (F-12). MQTT reconnect params discarded (F-05). |
| 11. Handle Return Values in Async | PARTIAL | Gather timeout orphan promise (F-07). MQTT subscribe uses .catch() appropriately. |
| 12. Lifecycle Ordering | PARTIAL | Startup order deviates for flush loops (F-14). Shutdown sequence correct. |
| 13. Per-Instance, Not Global | PASS | Per-input intervals, per-output batch sizes, per-aggregator dropOriginal all correctly per-instance. |

---

## Phase 3 Readiness Assessment

### Verdict: GO

Phase 2 provides a solid foundation for Phase 3 (Processors). The core pipeline runtime, accumulator, and plugin lifecycle are working correctly. All 251 tests pass.

### Resolved Before Phase 3:

1. **F-02 (MQTT servers failover)** — RESOLVED. Full servers list now passed to client interface.
2. **F-03 (OPC-UA auto-reconnect)** — RESOLVED. `onClose` handler triggers `reconnect()` automatically.
3. **F-05 (MQTT reconnect params)** — RESOLVED. `max_delay` and `max_retry` wired to client options + plugin-level enforcement.

### Can Defer to Phase 3 or Later:

- **F-01 (Sparkplug B)** -- Can be added as a separate task in Phase 3 or Phase 4 (outputs), since Sparkplug B output must be built first anyway.
- **F-04 (Internal metrics gaps)** -- local_store and network_policy metrics naturally come when those subsystems are built. Pipeline-level metrics (event_loop_lag, gather_timeout_count) should be added when the runtime is next touched.
- **F-08 (Real MQTT client)** -- Needed before E2E testing, not before Phase 3 processors.
- **F-09 and F-10 (TOFU, subscription transfer)** -- Need real OPC-UA library integration.

### Phase 3 Dependencies on Phase 2:

- Processors read metrics from the input channel and write to the output broadcaster via `CollectingAccumulator`. This path is tested and working.
- Processor chain runs in `runMainLoop()` which correctly handles metric copying and aggregator forking.
- Global tags are correctly merged at the accumulator level.
- The `Processor` interface (`process(metric, acc)`) is defined in `plugin-types.ts` and matches PRD Appendix B.

### Risks for Phase 3:

1. **Accumulator addError() only logs** -- processor errors are logged but not counted in stats. The stats system needs `processorErrors` before Phase 3 processors can report failures.
2. **No processor ordering guarantees** -- PRD SS6 says processors run in config order. The runtime iterates the processors array sequentially which is correct, but there is no test proving order matters.
3. **No processor-level timeout** -- Only gather has a timeout mechanism. A slow processor blocks the main loop indefinitely.

---

## Test Coverage Summary

| Module | Unit Tests | Integration Tests | Total | Hard Path Coverage |
|---|---|---|---|---|
| ServiceInput runtime | 11 | -- | 11 | Good (failure, batch) |
| Modbus TCP | 31 | 3 | 34 | Good (exceptions, reconnect, batch fallback) |
| OPC-UA | 42 | 4 | 46 | Moderate (reconnect tested but not auto-triggered) |
| MQTT Consumer | 29 | 3 | 32 | Moderate (reconnect handler tested, no Sparkplug B) |
| Internal Metrics | 12 | 2 | 14 | Good (config toggle, counters, per-plugin stats) |
| **Total** | **125** | **12** | **137** | |

Note: Total project test count is 246 (includes Phase 1 core tests: channel, ticker, metric, accumulator, config, runtime).

---

*Review complete. 251/251 tests passing. 5 Must Fix (3 resolved), 9 Should Fix, 6 Nice to Have findings identified.*
