# Phase 2: Inputs — Progress

## Status: IN PROGRESS

## Pre-Phase Fixes
- [x] ServiceInput support in runtime (task 2.0)
- [x] metric_batch_size in output flush (task 2.0)

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 2.0 | ServiceInput runtime support + metric_batch_size | ✅ |
| 2.1 | Modbus TCP input | ✅ |
| 2.1i | Modbus → pipeline integration | ✅ |
| 2.2 | OPC-UA input | ✅ |
| 2.2i | OPC-UA → pipeline integration | ✅ |
| 2.3 | MQTT consumer input | ⬜ |
| 2.3i | MQTT → pipeline integration | ⬜ |
| 2.4 | Internal metrics input | ⬜ |
| 2.4i | Internal metrics integration | ⬜ |

## Task 2.0: ServiceInput Runtime Support + metric_batch_size

### What was built
1. **`isServiceInput()` type guard** in `src/core/plugin-types.ts` — duck-type check for `start` and `stop` methods
2. **ServiceInput lifecycle in PipelineRuntime** — `start()` detects ServiceInput vs polling Input:
   - ServiceInput: calls `start(acc)` during startup, stores reference for shutdown
   - Polling Input: creates gather loop with Ticker (unchanged)
3. **Shutdown ordering** — `stop()` calls `ServiceInput.stop()` BEFORE closing the input channel, per PRD §8
4. **ServiceInput error handling** — `start()` errors are logged but don't crash the pipeline; other inputs continue
5. **`metricBatchSize` on output options** — output flush loop splits large batches into chunks before calling `write()`

### Key decisions
- `PipelineOptions.outputs` now accepts `{ plugin: Output; metricBatchSize?: number }` — per-output batch size (Rule 13: per-instance, not global)
- ServiceInput references stored in `this.serviceInputs` for shutdown ordering
- On ServiceInput `start()` failure: error logged, plugin NOT added to serviceInputs (won't get `stop()` called), pipeline continues with remaining inputs

### Tests added (11 new, 120 total)
- `test/unit/pipeline/service-input.test.ts`
- 4 tests for `isServiceInput()` type guard (ServiceInput, plain Input, partial cases)
- 5 tests for ServiceInput lifecycle in PipelineRuntime
- 2 tests for `metric_batch_size` batch splitting

### Files changed
- `src/core/plugin-types.ts` — added `isServiceInput()` export
- `src/pipeline/runtime.ts` — ServiceInput detection in start/stop, metricBatchSize in flush loop, updated PipelineOptions
- `test/unit/pipeline/service-input.test.ts` — new test file

## Task 2.1: Modbus TCP Input Plugin

### What was built
1. **`src/plugins/inputs/modbus.ts`** — full Modbus TCP polling Input implementation (~300 lines)
2. **Zod config schema** — `ModbusConfigSchema` and `ModbusRegisterSchema` matching PRD §6 field-by-field
3. **Register reading** — FC01 (coils), FC02 (discrete inputs), FC03 (holding registers), FC04 (input registers)
4. **Multi-register types** — uint32, int32, float32 with 4 byte order variants (ABCD, CDAB, BADC, DCBA)
5. **Scaling and bit extraction** — `output = raw * scale + offset`, single-bit boolean extraction
6. **Batch reads** — contiguous same-type registers grouped into single requests, respecting `max_batch_size` and `max_gap`
7. **Shared connection mode** — `connection_mode: "shared"` with `slaves` config, `setID()` per slave
8. **Modbus exception handling** — per PRD §6 table: exceptions 01/02/03 disable register, 04/05/06/08/0A/0B retry
9. **Reconnection** — auto-reconnect on connection loss during gather()
10. **Dependency injection** — `ModbusClient` interface + optional client injection for testing

### Key decisions
- `ModbusClient` interface extracted for testability — tests inject `MockModbusClient` instead of real modbus-serial
- Batch read fallback: on batch failure, retries individual registers to isolate the bad one (PRD §6)
- `disabledRegisters` set is public readonly for observability (future: exposed in self-metrics and Web UI)
- Per-register byte order override works: `config.byte_order` is the plugin-level default, `register.byte_order` overrides per-register
- Connection errors during shared mode abort all remaining slaves (can't switch slave on dead TCP connection)

### Dependencies added
- `modbus-serial@8.0.23` — verified import works with Bun

### Tests added (31 new, 151 total)
- `test/unit/plugins/inputs/modbus.test.ts`
- 18 tests matching all task requirements (FC01-04, byte orders, scaling, batch, shared mode, exceptions, reconnection, config validation)
- 6 batch grouping unit tests
- 6 byte order decoding unit tests
- 1 additional config validation test

### Files changed
- `src/plugins/inputs/modbus.ts` — new file
- `test/unit/plugins/inputs/modbus.test.ts` — new file
- `package.json` — added modbus-serial dependency

## Task 2.1i: Modbus → Pipeline Integration Test

### What was built
1. **`test/integration/modbus-pipeline.test.ts`** — 3 integration tests wiring ModbusInput → PipelineRuntime → MockOutput
2. **MockModbusClient** — minimal mock implementing `ModbusClient` interface with per-slave holding register storage
3. **MockOutput** — captures written metrics for assertion

### Tests added (3 new, 154 total)
- `test/integration/modbus-pipeline.test.ts`
- **"metrics have correct register names and values"** — 2 registers (temperature with scale 0.1, pressure), verifies correct metric names and scaled values through full pipeline
- **"global tags and slave_id tag present on output metrics"** — verifies `slave_id` tag from Modbus input AND `globalTags` applied by PipelineRuntime both appear on output metrics
- **"multiple registers produce multiple fields per gather cycle"** — 3 registers, verifies all 3 metric names appear, values are correct, and multiple gather cycles produce consistent metric counts

### Key design decisions
- Reused `MockModbusClient` pattern from unit tests but kept it minimal (no error injection, no call tracking)
- Used `gatherIntervalMs: 50` and `flushIntervalMs: 50` with 300ms run duration to get multiple gather cycles
- Tests assert `>=` counts rather than exact counts to avoid timing sensitivity (Rule 1: no timing hacks)

### Files changed
- `test/integration/modbus-pipeline.test.ts` — new file

## Task 2.2: OPC-UA Input Plugin

### What was built
1. **`src/plugins/inputs/opcua.ts`** — full OPC-UA ServiceInput implementation (~450 lines)
2. **Zod config schema** — `OpcuaConfigSchema`, `OpcuaNodeSchema`, `OpcuaGroupSchema` matching PRD Appendix D §D.1 field-by-field
3. **ServiceInput lifecycle** — `start(acc)` connects → creates session → creates subscription → adds monitored items; `stop()` closes session → disconnects
4. **Security auto-negotiation** — tries 5 fallback policies (Basic256Sha256+SignAndEncrypt → None+None) per PRD D.1
5. **Data type mapping** — 22+ OPC-UA types → FieldValue per PRD D.3 table (Boolean, Int/UInt 16/32/64, Float, Double, String, DateTime, ByteString, Guid, NodeId, StatusCode, LocalizedText, QualifiedName, Array, ExtensionObject)
6. **Quality mapping** — StatusCode → "good" / "uncertain" / "bad" tag; bad-quality values still emitted per PRD D.3
7. **Timestamp source selection** — source (device PLC), server (OPC-UA server), gather (local)
8. **Node groups** — `groups` config expands to flat node list with inherited defaults; per-node overrides win
9. **Subscription parameters** — publishing_interval, queue_size, max_keep_alive_count, lifetime_count, max_notifications_per_publish from config
10. **Data change filter (deadband)** — absolute/percent/none, configurable per-node and globally
11. **Reconnection with exponential backoff** — initial_delay, max_delay, max_retry (0=forever)
12. **Namespace URI resolution** — `nsu=` → `ns=` at connect time via `resolveNamespaceUri()`
13. **Browse mode** — discovers nodes, writes TOML snippet to output_file
14. **Authentication** — anonymous, username/password
15. **Error handling** — bad NodeID skipped (logged, others continue), connection refused → retry, auth failure → throw (config error)
16. **Dependency injection** — `OpcuaClient` interface + mock injection for testing

### Key decisions
- `OpcuaClient` interface abstracts node-opcua for testability — same DI pattern as Modbus
- Zod v4 `.default({})` does NOT apply inner field defaults. Fixed by providing full default objects explicitly. This is a Zod v4 behaviour difference from v3.
- Zod v4 `z.record()` requires both key and value schemas: `z.record(z.string(), z.string())`
- `gather()` is a no-op — OPC-UA is subscription-based (push), not polling. All data flows through `onDataChange` callback.
- Array values unpacked to `name[0]`, `name[1]`, `name.length` per PRD D.3
- ExtensionObject/Structure flattened with dot notation, max 3 levels deep per PRD D.3
- Int64/UInt64 values beyond MAX_SAFE_INTEGER log a warning but still emit as number (PRD D.3: precision loss noted)

### Dependencies added
- `node-opcua@2.163.1` — verified import works with Bun (pure JS in v4.x)

### Tests added (42 new, 196 total)
- `test/unit/plugins/inputs/opcua.test.ts`
- **Connection/lifecycle**: connect + read single node, subscription data change, stop() cleanup, stop() suppresses further events
- **Data types**: Boolean, Int32, Float, Double, String, DateTime, ByteString, LocalizedText, QualifiedName, Guid, Int64 (precision warning), Array (unpacking), null/undefined, unknown type fallback
- **Quality**: good → tag "good" + value emitted, bad → tag "bad" + value STILL emitted
- **Timestamps**: source, server, gather modes
- **Node groups**: group defaults inherited, per-node overrides win, tags merged
- **Certificate config**: paths passed through to client
- **TOFU config**: server certificate path passed through
- **Reconnection**: exponential backoff with max_retry limit
- **Browse mode**: discovers nodes, passes params to client
- **Auth**: anonymous (no credentials), username/password
- **Error handling**: bad NodeID skipped + others continue, connection refused → throws, auth failure → throws
- **Deadband**: absolute config passed to monitored item params
- **Security auto-negotiation**: fallback order until success, all fail → clear error
- **Subscription params**: config values passed through correctly
- **Namespace URI**: nsu= resolved to ns= at connect time
- **Per-node tags**: included in emitted metrics

### Files changed
- `src/plugins/inputs/opcua.ts` — new file
- `test/unit/plugins/inputs/opcua.test.ts` — new file
- `package.json` — added node-opcua dependency

## Task 2.2i: OPC-UA → Pipeline Integration Test

### What was built
1. **`test/integration/opcua-pipeline.test.ts`** — 4 integration tests wiring OpcuaInput (ServiceInput) → PipelineRuntime → MockOutput
2. **MockOpcuaClient** — minimal mock implementing `OpcuaClient` interface with `emitDataChange()` to simulate server notifications
3. **MockOutput** — captures written metrics for assertion (same pattern as Modbus integration)

### Tests added (4 new, 200 total)
- `test/integration/opcua-pipeline.test.ts`
- **"OPC-UA subscription → pipeline → output: value changes produce metrics"** — 2 nodes (temperature, pressure), emits data changes, verifies correct metric names and values flow through full pipeline
- **"Data types preserved through pipeline (number, string, boolean)"** — 3 nodes with Double, String, Boolean data types, verifies each type arrives correctly at the output
- **"Quality tags present on output metrics"** — emits good and bad quality data, verifies quality tags flow through and bad-quality values are NOT dropped (PRD D.3)
- **"Global tags applied to OPC-UA metrics"** — sets globalTags on pipeline, verifies they appear alongside OPC-UA quality tag on output metrics

### Key design decisions
- OPC-UA is a ServiceInput (push-based), so tests emit data via `mockClient.emitDataChange()` rather than relying on a gather loop
- Used `Bun.sleep(200)` between data emission and stop() to allow flush cycle to deliver metrics
- Used explicit `security_policy: "None"` to skip auto-negotiation in integration tests (avoids 5 connect attempts)

### Files changed
- `test/integration/opcua-pipeline.test.ts` — new file

## Notes

### Dependencies
- `modbus-serial` — validated in Bun spike, use `--external=@serialport/bindings-cpp` at compile
- `node-opcua` — validated in Bun spike, pure JS v4.x, installed v2.163.1
- MQTT library — needs validation before task 2.3

### Test Infrastructure
- Modbus: stub/mock modbus-serial client or lightweight mock TCP server
- OPC-UA: use node-opcua server module for test fixtures
- MQTT: use aedes or similar in-process broker for tests
