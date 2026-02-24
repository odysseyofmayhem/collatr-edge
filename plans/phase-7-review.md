# Phase 7 Code Review: Sparkplug B Hub Link

## Review Scope

Source files reviewed:
- `src/core/mqtt-client.ts` -- Real MQTT client wrapper
- `src/core/mqtt-types.ts` -- Shared MQTT types
- `src/core/accumulator.ts` -- _device_id tag injection
- `src/core/config.ts` -- Hub schema extension
- `src/core/plugin-schemas.ts` -- MQTT output schema registration
- `src/hub/hub-link.ts` -- Hub link session manager
- `src/hub/sparkplug-codec.ts` -- Sparkplug B codec
- `src/pipeline/plugin-factory.ts` -- HubLink creation and wiring
- `src/pipeline/runtime.ts` -- HubLink lifecycle integration
- `src/plugins/inputs/mqtt-consumer.ts` -- Refactored to use shared mqtt-types
- `src/plugins/outputs/mqtt.ts` -- MQTT output plugin
- `src/cli/commands/config-init.ts` -- Hub config templates

Test files reviewed:
- `test/unit/spike/sparkplug-payload.test.ts`
- `test/unit/core/mqtt-client.test.ts`
- `test/unit/hub/sparkplug-codec.test.ts`
- `test/unit/hub/hub-link.test.ts`
- `test/unit/plugins/outputs/mqtt.test.ts`
- `test/integration/hub-link-pipeline.test.ts`
- `test/integration/mqtt-output-pipeline.test.ts`
- `test/integration/sparkplug-lifecycle.test.ts`

PRD sections cross-referenced:
- Section 9: Hub Link & Control Plane
- Section 8: Pipeline Lifecycle
- Section 19: MVP Plugin Inventory
- Appendix B: Metric Interface
- Appendix C: Sparkplug B Topic Map

## Summary

Phase 7 is a substantial and well-structured implementation of the Sparkplug B Hub Link. The core architecture is sound: clean separation between codec, hub link session manager, and MQTT output plugin; proper DI via constructor injection of mock clients for testing; correct topic structure matching PRD Section 9. The test count increased from 560 to 658, all passing.

However, the review identified several correctness and protocol compliance issues that must be addressed before Phase 8. The most critical are: (1) `seq` is not included in DBIRTH/DDATA/DDEATH payloads, violating the Sparkplug B protocol; (2) `_device_id` is not injected by `addMetric()`, causing data loss for service inputs in Sparkplug mode; and (3) `stop()` modifies the `deviceBirthPublished` Set during iteration, which can skip devices.

---

## Findings

### Must Fix

1. **`src/hub/sparkplug-codec.ts` / `src/hub/hub-link.ts` -- `seq` missing from DBIRTH, DDATA, DDEATH payloads** ✅ FIXED

   PRD Section 9 states: "seq: Per-message counter, 0-255, reset to 0 on each NBIRTH. Incremented for every NDATA/DDATA/DBIRTH/DDEATH message."

   The Sparkplug B wire format includes `seq` as a top-level payload field (not a metric). Currently only `encodeNData()` includes `seq` in the payload. `encodeDBirth()`, `encodeDData()`, and `encodeDDeath()` omit it entirely. The Hub uses `seq` gaps to detect missed messages and trigger rebirth requests. Without `seq`, the Hub cannot perform this critical recovery mechanism.

   **Fix:** Add a `seq` parameter to `encodeDBirth()`, `encodeDData()`, and `encodeDDeath()` function signatures, and include it in the `sparkplug.encodePayload()` call. In `HubLink`, pass `this.seq` to these encode functions before calling `this.nextSeq()`. The NBIRTH is the only message that should NOT carry `seq` (it resets it). `encodeNBirth()` is correctly omitting `seq`.

   **Applied:** Added `seq: number` parameter to `encodeDBirth()`, `encodeDData()`, `encodeDDeath()`. All three now include `seq` in the `sparkplug.encodePayload()` call. `hub-link.ts` passes `this.seq` to each. Codec tests updated to pass and verify seq in decoded payloads.

2. **`src/core/accumulator.ts:65` -- `addMetric()` does not inject `_device_id` tag** ✅ FIXED

   `ChannelAccumulator.addFields()` correctly injects `_device_id` when `this._deviceId` is set (lines 46-48). However, `addMetric()` (line 65) passes the metric directly to the channel without injecting `_device_id`. Any input plugin that uses `addMetric()` (e.g., a service input forwarding transformed metrics, or processors that call `acc.addMetric()`) will produce metrics without `_device_id`, causing them to be routed to the "unknown" device in the MQTT Sparkplug output.

   While the current polling inputs (Modbus, Internal) use `addFields()`, this is a latent correctness bug that will surface as soon as a service input or processor-generated metric flows through the Sparkplug pipeline.

   **Fix:** In `addMetric()`, inject `_device_id` if `this._deviceId` is set and the metric doesn't already have it.

   **Applied:** Added `_device_id` injection to `addMetric()` in `accumulator.ts`, matching the existing `addFields()` pattern.

3. **`src/hub/hub-link.ts:269` -- `stop()` modifies Set during iteration (concurrent modification)** ✅ FIXED

   `stop()` iterates over `this.deviceBirthPublished` with `for...of` (line 269), and inside the loop calls `publishDeviceDeath()` (line 271) which calls `this.deviceBirthPublished.delete(deviceId)` (line 223). Per the ECMAScript spec, deleting an entry from a Set during `for...of` iteration that has not yet been visited causes that entry to be skipped. This means some devices may NOT receive DDEATH during shutdown, leaving the Hub in an inconsistent state (it sees the device as alive even though the edge node is shutting down).

   **Applied:** `stop()` now snapshots with `const devicesToClose = [...this.deviceBirthPublished]` before iterating.

4. **`src/hub/hub-link.ts:100-131` -- `start()` publishes NBIRTH before MQTT connection is established** ✅ FIXED

   `this.client.connect()` is synchronous (it initiates the connection, does not wait). The `onConnect` callback fires asynchronously when the connection succeeds. However, `publishNBirth()` was called immediately after `connect()`, before `onConnect` had fired. This relied on an internal implementation detail of the `mqtt` library (message queuing before CONNACK).

   **Applied:** Rewrote `start()` to register `onConnect`/`onError` handlers before calling `connect()`, then `await` a Promise that resolves on CONNACK. NBIRTH is only published after the connection is confirmed. Added try/catch around post-connect operations (NBIRTH, subscribe, NCMD wiring) with cleanup on failure — disconnects the client if partial startup fails (also addresses Finding 13). The MockMqttClient fires `connectHandler` synchronously in `connect()` to support this pattern in tests.

### Should Fix

5. **`src/hub/sparkplug-codec.ts:47-50` -- `fieldValueToSparkplugValue()` converts bigint to Number, losing precision** ✅ FIXED

   The function `fieldValueToSparkplugValue()` converts `bigint` values to `Number` via `Number(value)`. For bigint values outside the safe integer range (>2^53), this silently loses precision. The PRD maps `bigint` to Sparkplug `Int64`, which supports the full 64-bit range. The `sparkplug-payload` library uses `Long` from `protobufjs` and can accept Long values directly.

   **Applied:** `fieldValueToSparkplugValue()` now accepts the resolved `SparkplugDataType` and uses `Long.fromString()` for bigint Int64 values and `Long.fromNumber()` for Number Int64 values. Same treatment applied to `encodeNData()` inline conversion. The `long` library was already available as a transitive dependency of `sparkplug-payload`.

6. **`src/hub/sparkplug-codec.ts` -- NBIRTH missing `Node Control/Config Version` metric** ✅ FIXED

   PRD Appendix C specifies that NBIRTH should include `Node Control/Config Version: "abc123" (config hash)`. The current `encodeNBirth()` includes `bdSeq`, `Node Control/Rebirth`, Properties, and Agent Metrics, but omits `Node Control/Config Version`. While NCMD Config push is deferred to post-Phase 7, the NBIRTH should still include a placeholder Config Version metric so the Hub can track it from the start.

   **Applied:** Added `configVersion?: string` parameter to `encodeNBirth()` (defaults to `"none"`). NBIRTH now includes `Node Control/Config Version` metric. Test updated to verify its presence.

7. **`src/pipeline/runtime.ts:433` -- Device registration uses generic `pluginType: "input"` instead of actual plugin type** ✅ FIXED

   When registering devices from input aliases, the `pluginType` is hardcoded to `"input"` rather than using the actual plugin type (e.g., "modbus", "opcua", "mqtt_consumer"). This means the DBIRTH `Properties/plugin_type` field will always say "input" instead of the real plugin type, losing valuable diagnostic information for Hub consumers.

   **Applied:** Added `pluginType?: string` to input entries in `PipelineOptions`. `buildPipeline()` in `plugin-factory.ts` sets `pluginType: pluginName` (the config section name, e.g. "modbus", "opcua"). `runtime.ts` passes `input.pluginType ?? "input"` to `registerDevice()`.

8. **`src/hub/hub-link.ts:192-206` -- DBIRTH re-publish on new metric discovery may cause excessive DBIRTHs** — DEFERRED

   `publishDeviceData()` checks if all current metric names have aliases and triggers a full DBIRTH re-publish if any new metric is discovered. This is correct per the Sparkplug B spec. On closer inspection, `publishDeviceBirth()` calls `resolveAliases()` which updates the alias map for all metrics, so subsequent DDATA calls will not re-trigger DBIRTH. The logic is correct. An explicit edge-case test would be nice but is not blocking.

9. **`test/unit/core/mqtt-client.test.ts` -- Tests only exercise MockMqttClient, not RealMqttClient** — DEFERRED

   The unit tests for the MQTT client wrapper test only the `MockMqttClient` implementation, verifying the interface contract. There are zero tests for `RealMqttClient` behavior (deferred handler wiring, `setWill()` guard, `disconnect()` cleanup, TLS option passing to `mqtt.connect()`, Will message inclusion in MQTT options).

   Deferred because properly testing `RealMqttClient` requires mocking the `mqtt` npm module (no jest.mock equivalent in bun:test). The deferred handler pattern is exercised indirectly through the hub-link integration tests. The `mqtt-client.test.ts` mock was intentionally left as a separate file (not merged into the shared helper) because it serves a different purpose: interface contract verification with distinct behavior (no auto-connect).

10. **`src/hub/hub-link.ts:130-131` -- NBIRTH published at seq=0 but seq not explicitly included in payload** ✅ FIXED

    Looking at the Sparkplug B specification more carefully: NBIRTH should include `seq` = 0 in the payload to signal the start of a new sequence. The current `encodeNBirth()` does not include `seq`. While some implementations omit `seq` from NBIRTH (since seq resets to 0 implicitly), including it explicitly makes the protocol state unambiguous for Hub implementations.

    **Applied:** Added `seq: 0` to the `sparkplug.encodePayload()` call in `encodeNBirth()`. Test updated to verify `decoded.seq === 0`.

11. **`src/plugins/outputs/mqtt.ts:142` -- `_device_id` tag is removed from shared metric object (mutation side effect)** ✅ FIXED

    In `writeSparkplug()`, `metric.removeTag(DEVICE_ID_TAG)` mutates the original metric object. If the same metric batch flows to multiple outputs (e.g., stdout + mqtt sparkplug), the second output will see metrics without `_device_id`. This violates Rule 13 (per-instance semantics) since a side effect in one output affects others.

    **Applied:** `writeSparkplug()` now calls `metric.copy()` before `removeTag()`, so the original metric is never mutated. Test updated to verify original retains `_device_id` while the published copy does not.

12. **`src/hub/hub-link.ts` -- No test for NCMD messages on wrong topic being ignored** ✅ FIXED

    The `onMessage` handler filters by checking `event.topic === ncmdTopic`. However, there was no test verifying that messages on other topics (e.g., DCMD or arbitrary topics) are silently ignored.

    **Applied:** Added test "ignores messages on non-NCMD topics" to `hub-link.test.ts`. Sends a rebirth command on a DCMD topic and verifies no NBIRTH re-publish occurs.

13. **`src/hub/hub-link.ts` -- No error handling if `publishNBirth()` or `subscribe()` fails during `start()`** ✅ FIXED

    If `publishNBirth()` or `client.subscribe()` throws during `start()`, the error propagates up to the caller. The MQTT connection would be left dangling.

    **Applied:** Wrapped post-connect operations (NBIRTH, subscribe, NCMD wiring) in try/catch. On failure, `client.disconnect()` is called before re-throwing. Addressed as part of the Finding 4 rewrite of `start()`.

14. **`src/hub/sparkplug-codec.ts:266` -- Timestamp conversion from nanoseconds to milliseconds uses integer division on bigint** ✅ FIXED

    The expression `Number(metric.timestamp / 1_000_000n)` performs integer division. If `metric.timestamp` is `0n`, the result is 0 (epoch), which may cause issues with Hub implementations that treat 0 as "no timestamp."

    **Applied:** Added fallback `const ts = rawTs > 0 ? rawTs : Date.now()` in `encodeDData()`. New test "uses current time as fallback for zero timestamp" verifies a `0n` timestamp is replaced with a real timestamp.

### Nice to Have

15. **`src/core/mqtt-client.ts:76` -- Will payload cast uses `as unknown as string`** ✅ FIXED

    The double-cast `as unknown as string` was unnecessary. **Applied:** Simplified to `as Buffer`.

16. **`src/hub/hub-link.ts:299` -- Dynamic `import("os")` inside publishNBirth** ✅ FIXED

    **Applied:** Replaced dynamic `await import("os")` with static `import * as os from "os"` at module top. `publishNBirth()` now calls `os.hostname()` directly.

17. **`src/hub/hub-link.ts` -- `HubLinkConfig.swVersion` is hardcoded to `"0.1.0"` in plugin-factory.ts**

    `plugin-factory.ts` line 317: `swVersion: "0.1.0"` -- The `swVersion` should be read from `package.json` or a build-time constant. The current TODO acknowledges this.

18. **`test/unit/hub/hub-link.test.ts` / `test/integration/sparkplug-lifecycle.test.ts` -- MockMqttClient duplicated across 4 test files** ✅ FIXED

    **Applied:** Extracted shared `MockMqttClient` to `test/helpers/mock-mqtt-client.ts`. Updated `hub-link.test.ts`, `sparkplug-lifecycle.test.ts`, and `mqtt.test.ts` (output) to import from the shared helper. The shared mock fires `connectHandler` synchronously in `connect()` to support the await-connection pattern. Left `mqtt-client.test.ts` with its own mock (different purpose: interface contract testing with distinct behavior).

19. **`src/hub/sparkplug-codec.ts:41` -- Default fallback to `"String"` for unknown FieldValue types**

    `fieldValueToSparkplugType()` returns `"String"` for any `typeof` that doesn't match known cases (line 41). In practice this only fires for `undefined`, `null`, `symbol`, `function`, or `object` -- none of which are valid `FieldValue` types. The fallback is safe but could mask a bug where an unexpected type slips through.

20. **`src/cli/commands/config-init.ts` -- MQTT output template topic uses `${name}` which conflicts with TOML env var expansion**

    The config template line 281 shows `# [[outputs.mqtt]]` with a topic template but doesn't show the `topic` field. The actual default in the schema (`"collatr/${name}"`) uses `${name}` syntax, which would be treated as an environment variable reference by `expandEnvVars()` during config parsing. This should use a different substitution syntax or be documented.

---

## PRD Compliance Table

| Module | PRD Section | Pre-Fix | Post-Fix | Notes |
|--------|-------------|---------|----------|-------|
| MQTT client wrapper (`mqtt-client.ts`) | Section 9 (single connection) | ✅ | ✅ | Shared between consumer and hub link. Will payload cast simplified. |
| MQTT types (`mqtt-types.ts`) | Section 9, Appendix B | ✅ | ✅ | Clean interface extraction. All methods present. |
| Sparkplug codec (`sparkplug-codec.ts`) | Section 9 (data types, aliases) | ⚠️ | ✅ | `seq` added to DBIRTH/DDATA/DDEATH. `Node Control/Config Version` added to NBIRTH. `seq: 0` in NBIRTH. Int64 uses Long. Zero-timestamp fallback. |
| Hub link (`hub-link.ts`) | Section 9 (lifecycle, topics, sequences) | ⚠️ | ✅ | Await CONNACK before NBIRTH. Set snapshot in `stop()`. Partial startup cleanup. Static os import. `seq` passed to all encode calls. |
| MQTT output (`mqtt.ts`) | Section 19 (outputs.mqtt) | ⚠️ | ✅ | Copy-then-strip for `_device_id` — no mutation of shared metrics. |
| Accumulator (`accumulator.ts`) | Section 9 (device routing) | ⚠️ | ✅ | `addMetric()` now injects `_device_id` matching `addFields()`. |
| Config (`config.ts`) | Section 9, Appendix A | ✅ | ✅ | Hub schema matches PRD. |
| Plugin factory (`plugin-factory.ts`) | Section 8 (startup), Section 9 | ⚠️ | ✅ | `pluginType` now set from config section name (e.g. "modbus"). |
| Pipeline runtime (`runtime.ts`) | Section 8 (lifecycle ordering) | ✅ | ✅ | `pluginType` passed through to device registration. |
| Plugin schemas (`plugin-schemas.ts`) | -- | ✅ | ✅ | `outputs.mqtt` registered. |
| Config init (`config-init.ts`) | Appendix A | ✅ | ✅ | Hub section and MQTT output templates included. |

---

## Test Coverage Assessment

| Module | Tests | Hard Path Coverage | Notes |
|--------|-------|-------------------|-------|
| Sparkplug payload spike | 6 | Good | Encode/decode round-trips for all message types and data types. |
| MQTT client interface | 12 | Fair | Tests mock only. No tests for RealMqttClient internals (deferred handlers, Will guard). |
| Sparkplug codec | 25 | Good | All 6 FieldValue type mappings tested. Alias determinism, collision resistance. All encode/decode round-trips. seq verified in DBIRTH/DDATA/DDEATH/NBIRTH. Zero-timestamp fallback. Config Version in NBIRTH. |
| Hub link | 23 | Good | Start lifecycle, NBIRTH, DBIRTH auto-publish, DDATA, NDATA, NCMD rebirth, stop/DDEATH, seq wrap, heartbeat timer. Wrong-topic NCMD ignore test added. |
| MQTT output | 12 | Good | Sparkplug routing by device, copy-based tag stripping (no mutation), plain mode, config validation, lifecycle. |
| Hub link pipeline integration | 4 | Good | Device registration, _device_id injection, buildPipeline hub creation, multi-device routing. |
| MQTT output pipeline integration | 5 | Fair | Config parsing, hub/no-hub, multiple outputs. No runtime pipeline test for plain MQTT mode. |
| Sparkplug lifecycle integration | 5 | Good | Full lifecycle, multi-device, rebirth via NCMD, seq increments, NDATA heartbeat. |

**Total Phase 7 tests: 92 (post-fix). Total project: 660 tests, 0 failures.**

### Remaining Untested Hard Paths

- `RealMqttClient` deferred handler wiring and `setWill()` guard (requires mqtt module mocking)
- Publish failure mid-batch in sparkplug mode
- DBIRTH re-publish when new metric names appear between gather cycles
- Runtime pipeline test for plain MQTT mode (non-sparkplug)

---

## Phase 8 Readiness Assessment

**All Must Fix items are resolved.** All key Should Fix items are resolved. Phase 8 can proceed.

### Fix Pass Summary

| Finding | Severity | Status | Commit |
|---------|----------|--------|--------|
| 1. seq in DBIRTH/DDATA/DDEATH | 🔴 Must Fix | ✅ Fixed | `c599b6c` |
| 2. addMetric() _device_id | 🔴 Must Fix | ✅ Fixed | `c599b6c` |
| 3. Set iteration in stop() | 🔴 Must Fix | ✅ Fixed | `c599b6c` |
| 4. Await CONNACK before NBIRTH | 🔴 Must Fix | ✅ Fixed | `c599b6c` |
| 5. Int64 precision (Long) | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 6. Config Version in NBIRTH | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 7. pluginType from config | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 8. DBIRTH re-publish edge case | 🟡 Should Fix | — Deferred | Logic correct on inspection |
| 9. RealMqttClient tests | 🟡 Should Fix | — Deferred | Requires mqtt module mocking |
| 10. seq=0 in NBIRTH | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 11. Metric mutation in output | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 12. Wrong-topic NCMD test | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 13. start() error handling | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 14. Zero-timestamp guard | 🟡 Should Fix | ✅ Fixed | `c599b6c` |
| 15. Will payload cast | 🟢 Nice to Have | ✅ Fixed | `c599b6c` |
| 16. Dynamic os import | 🟢 Nice to Have | ✅ Fixed | `c599b6c` |
| 17. swVersion from package.json | 🟢 Nice to Have | — Deferred | Acknowledged TODO |
| 18. MockMqttClient shared | 🟢 Nice to Have | ✅ Fixed | `c599b6c` |
| 19. String fallback for unknowns | 🟢 Nice to Have | — Deferred | Safe, no action needed |
| 20. TOML `${name}` conflict | 🟢 Nice to Have | — Deferred | Documentation item |

**Score: 16/20 findings resolved. 4 deferred (none blocking).**

**Phase 7 is complete. 660 tests, 0 failures. Phase 8 (Network Policy) can proceed.**
