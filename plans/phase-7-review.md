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

1. **`src/hub/sparkplug-codec.ts` / `src/hub/hub-link.ts` -- `seq` missing from DBIRTH, DDATA, DDEATH payloads**

   PRD Section 9 states: "seq: Per-message counter, 0-255, reset to 0 on each NBIRTH. Incremented for every NDATA/DDATA/DBIRTH/DDEATH message."

   The Sparkplug B wire format includes `seq` as a top-level payload field (not a metric). Currently only `encodeNData()` includes `seq` in the payload. `encodeDBirth()`, `encodeDData()`, and `encodeDDeath()` omit it entirely. The Hub uses `seq` gaps to detect missed messages and trigger rebirth requests. Without `seq`, the Hub cannot perform this critical recovery mechanism.

   **Fix:** Add a `seq` parameter to `encodeDBirth()`, `encodeDData()`, and `encodeDDeath()` function signatures, and include it in the `sparkplug.encodePayload()` call. In `HubLink`, pass `this.seq` to these encode functions before calling `this.nextSeq()`. The NBIRTH is the only message that should NOT carry `seq` (it resets it). `encodeNBirth()` is correctly omitting `seq`.

2. **`src/core/accumulator.ts:65` -- `addMetric()` does not inject `_device_id` tag**

   `ChannelAccumulator.addFields()` correctly injects `_device_id` when `this._deviceId` is set (lines 46-48). However, `addMetric()` (line 65) passes the metric directly to the channel without injecting `_device_id`. Any input plugin that uses `addMetric()` (e.g., a service input forwarding transformed metrics, or processors that call `acc.addMetric()`) will produce metrics without `_device_id`, causing them to be routed to the "unknown" device in the MQTT Sparkplug output.

   While the current polling inputs (Modbus, Internal) use `addFields()`, this is a latent correctness bug that will surface as soon as a service input or processor-generated metric flows through the Sparkplug pipeline.

   **Fix:** In `addMetric()`, inject `_device_id` if `this._deviceId` is set and the metric doesn't already have it:
   ```typescript
   addMetric(metric: Metric): void {
     if (this._deviceId && !metric.hasTag("_device_id")) {
       metric.addTag("_device_id", this._deviceId);
     }
     void this.channel.send(metric).then((ok) => {
       if (!ok) this._droppedCount++;
     });
   }
   ```

3. **`src/hub/hub-link.ts:269` -- `stop()` modifies Set during iteration (concurrent modification)**

   `stop()` iterates over `this.deviceBirthPublished` with `for...of` (line 269), and inside the loop calls `publishDeviceDeath()` (line 271) which calls `this.deviceBirthPublished.delete(deviceId)` (line 223). Per the ECMAScript spec, deleting an entry from a Set during `for...of` iteration that has not yet been visited causes that entry to be skipped. This means some devices may NOT receive DDEATH during shutdown, leaving the Hub in an inconsistent state (it sees the device as alive even though the edge node is shutting down).

   **Fix:** Snapshot the Set before iterating:
   ```typescript
   const devicesToClose = [...this.deviceBirthPublished];
   for (const deviceId of devicesToClose) {
     // ...
   }
   ```

4. **`src/hub/hub-link.ts:100-131` -- `start()` publishes NBIRTH before MQTT connection is established**

   `this.client.connect()` (line 123) is synchronous (it initiates the connection, does not wait). The `onConnect` callback (line 109) fires asynchronously when the connection succeeds. However, `publishNBirth()` (line 131) is called immediately after `connect()`, before `onConnect` has fired. With the real `mqtt` npm package, this works because the library internally queues messages before the connection completes. But this introduces a timing dependency on an internal implementation detail of the `mqtt` library.

   More importantly, the mock client in tests sets `_isConnected = true` synchronously in `connect()`, which masks this race condition. If the `mqtt` library changes its queuing behavior, or if the code is later changed to check `this._connected` before publishing, this will break silently.

   **Fix:** Either (a) await the connection by wrapping `connect()` in a Promise that resolves on the `onConnect` event, or (b) document this dependency and add a test that verifies NBIRTH is published even when `_connected` is false (to catch regressions). Option (a) is more robust:
   ```typescript
   await new Promise<void>((resolve, reject) => {
     this.client.onConnect(() => {
       this._connected = true;
       resolve();
     });
     this.client.onError((err) => reject(err));
     this.client.connect([this.config.broker], { ... });
   });
   ```

### Should Fix

5. **`src/hub/sparkplug-codec.ts:47-50` -- `fieldValueToSparkplugValue()` converts bigint to Number, losing precision**

   The function `fieldValueToSparkplugValue()` converts `bigint` values to `Number` via `Number(value)`. For bigint values outside the safe integer range (>2^53), this silently loses precision. The PRD maps `bigint` to Sparkplug `Int64`, which supports the full 64-bit range. The `sparkplug-payload` library uses `Long` from `protobufjs` and can accept Long values directly.

   **Fix:** Convert bigint to Long instead of Number for Int64 values:
   ```typescript
   import Long from "long";
   if (typeof value === "bigint") {
     return Long.fromString(value.toString());
   }
   ```

6. **`src/hub/sparkplug-codec.ts` -- NBIRTH missing `Node Control/Config Version` metric**

   PRD Appendix C specifies that NBIRTH should include `Node Control/Config Version: "abc123" (config hash)`. The current `encodeNBirth()` includes `bdSeq`, `Node Control/Rebirth`, Properties, and Agent Metrics, but omits `Node Control/Config Version`. While NCMD Config push is deferred to post-Phase 7, the NBIRTH should still include a placeholder Config Version metric so the Hub can track it from the start.

   **Fix:** Add `Node Control/Config Version` to `encodeNBirth()`. Accept it as a parameter (with default `"none"` or a hash of the current config).

7. **`src/pipeline/runtime.ts:433` -- Device registration uses generic `pluginType: "input"` instead of actual plugin type**

   When registering devices from input aliases, the `pluginType` is hardcoded to `"input"` rather than using the actual plugin type (e.g., "modbus", "opcua", "mqtt_consumer"). This means the DBIRTH `Properties/plugin_type` field will always say "input" instead of the real plugin type, losing valuable diagnostic information for Hub consumers.

   **Fix:** Track the plugin type name alongside the plugin instance in `PipelineOptions.inputs` and pass it through to `registerDevice()`. This requires adding an optional `pluginType?: string` to the input entry in `PipelineOptions`, set in `buildPipeline()`.

8. **`src/hub/hub-link.ts:192-206` -- DBIRTH re-publish on new metric discovery may cause excessive DBIRTHs**

   `publishDeviceData()` checks if all current metric names have aliases and triggers a full DBIRTH re-publish if any new metric is discovered (lines 199-206). This is correct per the Sparkplug B spec, but the implementation checks and re-publishes DBIRTH before every DDATA when new metrics appear. If an input produces metrics with varying field names across gather cycles (e.g., dynamic tags or computed fields), this will cause a DBIRTH on every DDATA, flooding the Hub.

   **Fix:** After the re-publish DBIRTH (line 205), the new metric names should be added to the alias map so the next DDATA doesn't trigger another DBIRTH. Currently `publishDeviceBirth()` does call `resolveAliases()` which updates the alias map, so this should already work. However, the `break` on line 205 means only one missing metric triggers the re-publish -- verify that all new metrics are covered by the fresh `resolveAliases()` call in `publishDeviceBirth()`. This appears correct on closer inspection, but add a test for this edge case.

9. **`test/unit/core/mqtt-client.test.ts` -- Tests only exercise MockMqttClient, not RealMqttClient**

   The unit tests for the MQTT client wrapper test only the `MockMqttClient` implementation, verifying the interface contract. There are zero tests for `RealMqttClient` behavior (deferred handler wiring, `setWill()` guard, `disconnect()` cleanup, TLS option passing to `mqtt.connect()`, Will message inclusion in MQTT options). While integration with a real broker belongs in E2E tests, the deferred handler pattern and Will configuration logic in `RealMqttClient` have complex internal state that should be unit-tested.

   **Fix:** Add unit tests for `RealMqttClient` that mock the `mqtt` npm package (e.g., via a factory function or jest.mock equivalent) to verify:
   - `setWill()` throws if called after `connect()`
   - Deferred handlers are wired after `connect()`
   - TLS options are passed correctly
   - Will message is included in MQTT connect options

10. **`src/hub/hub-link.ts:130-131` -- NBIRTH published at seq=0 but seq not explicitly included in payload**

    Looking at the Sparkplug B specification more carefully: NBIRTH should include `seq` = 0 in the payload to signal the start of a new sequence. The current `encodeNBirth()` does not include `seq`. While some implementations omit `seq` from NBIRTH (since seq resets to 0 implicitly), including it explicitly makes the protocol state unambiguous for Hub implementations.

    **Fix:** Add `seq: 0` to the `encodeNBirth()` payload call. This aligns with the Sparkplug B TCK (Test Compliance Kit) expectations.

11. **`src/plugins/outputs/mqtt.ts:142` -- `_device_id` tag is removed from shared metric object (mutation side effect)**

    In `writeSparkplug()`, `metric.removeTag(DEVICE_ID_TAG)` (line 142) mutates the original metric object. If the same metric batch flows to multiple outputs (e.g., stdout + mqtt sparkplug), the second output will see metrics without `_device_id`. This violates Rule 13 (per-instance semantics) since a side effect in one output affects others.

    **Fix:** Either (a) operate on copies: `const copy = metric.copy(); copy.removeTag(DEVICE_ID_TAG);` or (b) strip the tag only within the hub link encoder rather than in the output plugin. Option (a) is simpler and safer.

12. **`src/hub/hub-link.ts` -- No test for NCMD messages on wrong topic being ignored**

    The `onMessage` handler (line 138) filters by checking `event.topic === ncmdTopic`. However, there is no test verifying that messages on other topics (e.g., DCMD or arbitrary topics) are silently ignored. This is a negative test that confirms the filter works.

    **Fix:** Add a test that sends a message on a non-NCMD topic and verifies no rebirth is triggered.

13. **`src/hub/hub-link.ts` -- No error handling if `publishNBirth()` or `subscribe()` fails during `start()`**

    If `publishNBirth()` or `client.subscribe()` throws during `start()`, the error propagates up to the caller. However, `_started` is only set to `true` at line 153, meaning a partial startup leaves the hub link in an inconsistent state (Will is set, connection is initiated, but NBIRTH may not have been published). The heartbeat timer is not started, but the MQTT connection is left dangling.

    **Fix:** Wrap the startup sequence in try/catch. On failure, clean up (disconnect, cancel any timers) and re-throw with context:
    ```typescript
    try {
      await this.publishNBirth();
      await this.client.subscribe([ncmdTopic], 1);
      // ... rest of start
    } catch (err) {
      await this.client.disconnect().catch(() => {});
      throw new Error(`Hub link start failed: ${err}`);
    }
    ```

14. **`src/hub/sparkplug-codec.ts:266` -- Timestamp conversion from nanoseconds to milliseconds uses integer division on bigint**

    The expression `Number(metric.timestamp / 1_000_000n)` performs integer division (BigInt division truncates), then converts to Number. For nanosecond timestamps, this is correct and won't lose precision since the result is milliseconds. However, if `metric.timestamp` is 0n or negative, the behavior should be tested. A `timestamp` of 0n produces 0 (epoch), which is valid but may cause issues with some Hub implementations that treat 0 as "no timestamp."

    **Fix:** Add a guard or test for zero-timestamp metrics. Consider using `Date.now()` as a fallback when timestamp is 0n.

### Nice to Have

15. **`src/core/mqtt-client.ts:76` -- Will payload cast uses `as unknown as string`**

    Line 76: `payload: this.willPayload as unknown as string` -- The `mqtt` library's `IConnectPacket.will.payload` type accepts both `string` and `Buffer`. The double-cast is unnecessary and obscures intent. Direct `Buffer` should be accepted.

16. **`src/hub/hub-link.ts:299` -- Dynamic `import("os")` inside publishNBirth**

    Line 299: `hostname: (await import("os")).hostname()` -- This performs a dynamic import on every NBIRTH publish (including rebirth). The `os` module should be imported statically at the top of the file, and `hostname()` called once during construction.

17. **`src/hub/hub-link.ts` -- `HubLinkConfig.swVersion` is hardcoded to `"0.1.0"` in plugin-factory.ts**

    `plugin-factory.ts` line 317: `swVersion: "0.1.0"` -- The `swVersion` should be read from `package.json` or a build-time constant. The current TODO acknowledges this.

18. **`test/unit/hub/hub-link.test.ts` / `test/integration/sparkplug-lifecycle.test.ts` -- MockMqttClient duplicated across 4 test files**

    The `MockMqttClient` class is copied verbatim (with minor variations) across 4 test files: `mqtt-client.test.ts`, `hub-link.test.ts`, `mqtt.test.ts` (output), and `sparkplug-lifecycle.test.ts`. This violates DRY and makes maintenance harder.

    **Fix:** Extract to a shared `test/helpers/mock-mqtt-client.ts` module.

19. **`src/hub/sparkplug-codec.ts:41` -- Default fallback to `"String"` for unknown FieldValue types**

    `fieldValueToSparkplugType()` returns `"String"` for any `typeof` that doesn't match known cases (line 41). In practice this only fires for `undefined`, `null`, `symbol`, `function`, or `object` -- none of which are valid `FieldValue` types. The fallback is safe but could mask a bug where an unexpected type slips through.

20. **`src/cli/commands/config-init.ts` -- MQTT output template topic uses `${name}` which conflicts with TOML env var expansion**

    The config template line 281 shows `# [[outputs.mqtt]]` with a topic template but doesn't show the `topic` field. The actual default in the schema (`"collatr/${name}"`) uses `${name}` syntax, which would be treated as an environment variable reference by `expandEnvVars()` during config parsing. This should use a different substitution syntax or be documented.

---

## PRD Compliance Table

| Module | PRD Section | Status | Notes |
|--------|-------------|--------|-------|
| MQTT client wrapper (`mqtt-client.ts`) | Section 9 (single connection) | ✅ | Shared between consumer and hub link. Will, TLS, publish, subscribe all present. |
| MQTT types (`mqtt-types.ts`) | Section 9, Appendix B | ✅ | Clean interface extraction. All methods present. |
| Sparkplug codec (`sparkplug-codec.ts`) | Section 9 (data types, aliases) | ⚠️ | Type mapping correct. Alias FNV-1a correct. Missing `seq` in DBIRTH/DDATA/DDEATH payloads. Missing `Node Control/Config Version` in NBIRTH. bigint-to-Number precision loss for Int64. |
| Hub link (`hub-link.ts`) | Section 9 (lifecycle, topics, sequences) | ⚠️ | Topic structure correct. NBIRTH/NDEATH/DBIRTH/DDEATH/DDATA/NDATA/NCMD all implemented. `seq` tracked but not included in payloads. Set modification during iteration in `stop()`. No await on connection before NBIRTH. |
| MQTT output (`mqtt.ts`) | Section 19 (outputs.mqtt) | ⚠️ | Sparkplug and plain modes work. `_device_id` tag mutation affects shared metric objects. |
| Accumulator (`accumulator.ts`) | Section 9 (device routing) | ⚠️ | `addFields()` injects `_device_id`. `addMetric()` does not. |
| Config (`config.ts`) | Section 9, Appendix A | ✅ | Hub schema matches PRD: enabled, group_id, edge_node_id, broker, tls_cert, tls_key, heartbeat_interval. |
| Plugin factory (`plugin-factory.ts`) | Section 8 (startup), Section 9 | ⚠️ | Hub link created when enabled. MQTT output wired with hub link. Device pluginType hardcoded to "input". |
| Pipeline runtime (`runtime.ts`) | Section 8 (lifecycle ordering) | ✅ | Hub link starts after outputs connect, before inputs. Hub link stops after pipeline drains, before plugin close. Matches PRD Section 8. |
| Plugin schemas (`plugin-schemas.ts`) | -- | ✅ | `outputs.mqtt` registered. |
| Config init (`config-init.ts`) | Appendix A | ✅ | Hub section and MQTT output templates included. |

---

## Test Coverage Assessment

| Module | Tests | Hard Path Coverage | Notes |
|--------|-------|-------------------|-------|
| Sparkplug payload spike | 6 | Good | Encode/decode round-trips for all message types and data types. |
| MQTT client interface | 12 | Fair | Tests mock only. No tests for RealMqttClient internals (deferred handlers, Will guard). |
| Sparkplug codec | 16 | Good | All 6 FieldValue type mappings tested. Alias determinism, collision resistance. All encode/decode round-trips. |
| Hub link | 18 | Good | Start lifecycle, NBIRTH, DBIRTH auto-publish, DDATA, NDATA, NCMD rebirth, stop/DDEATH, seq wrap, heartbeat timer. Missing: error during start, wrong-topic NCMD, new metric re-DBIRTH. |
| MQTT output | 9 | Good | Sparkplug routing by device, tag stripping, plain mode, config validation, lifecycle. Missing: publish failure in sparkplug mode. |
| Hub link pipeline integration | 4 | Good | Device registration, _device_id injection, buildPipeline hub creation, multi-device routing. |
| MQTT output pipeline integration | 5 | Fair | Config parsing, hub/no-hub, multiple outputs. No runtime pipeline test for plain MQTT mode. |
| Sparkplug lifecycle integration | 5 | Good | Full lifecycle, multi-device, rebirth via NCMD, seq increments, NDATA heartbeat. |

**Total new tests: 75 (exceeds the 25+ target)**

### Untested Hard Paths

- `addMetric()` path for `_device_id` injection (never tested because current inputs use `addFields()`)
- `RealMqttClient` deferred handler wiring and `setWill()` guard
- `stop()` with Set modification during iteration edge case
- Publish failure mid-batch in sparkplug mode
- NBIRTH failure during `start()` (partial startup cleanup)
- Zero or negative timestamp in DDATA encoding
- NCMD message on wrong topic (verify silent ignore)
- `mqtt` npm library queuing behavior (NBIRTH before connection established)

---

## Phase 8 Readiness Assessment

**Phase 8 CANNOT proceed until the Must Fix items are resolved.** The missing `seq` in Sparkplug B payloads (Finding 1) is a protocol compliance issue that will cause Hub-side problems (missed-message detection failure). The Set modification during iteration (Finding 3) can cause devices to miss DDEATH on shutdown. The `addMetric()` gap (Finding 2) will cause data routing failures for any service input with an alias in Sparkplug mode. The connection race (Finding 4) doesn't cause immediate failure due to MQTT library queuing, but is architecturally fragile.

**Fix priority:**
1. Finding 1 (seq in payloads) -- protocol compliance, affects Hub interop
2. Finding 3 (Set iteration) -- correctness, devices miss DDEATH
3. Finding 2 (addMetric _device_id) -- correctness, data misrouting
4. Finding 11 (metric mutation) -- correctness, multi-output data corruption
5. Finding 4 (connection race) -- robustness, fragile timing assumption

**Should Fix items to address before building on top of affected modules:**
- Finding 5 (bigint precision) -- only matters when Int64 values exceed 2^53
- Finding 7 (pluginType "input") -- diagnostic quality, not blocking
- Finding 13 (start() error handling) -- robustness

**After Must Fix items are resolved and committed, Phase 8 (Network Policy) can proceed.**
