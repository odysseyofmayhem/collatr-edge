# Phase 2: Inputs — Progress

## Status: IN PROGRESS

## Pre-Phase Fixes
- [x] ServiceInput support in runtime (task 2.0)
- [x] metric_batch_size in output flush (task 2.0)

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 2.0 | ServiceInput runtime support + metric_batch_size | ✅ |
| 2.1 | Modbus TCP input | ⬜ |
| 2.1i | Modbus → pipeline integration | ⬜ |
| 2.2 | OPC-UA input | ⬜ |
| 2.2i | OPC-UA → pipeline integration | ⬜ |
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

## Notes

### Dependencies
- `modbus-serial` — validated in Bun spike, use `--external=@serialport/bindings-cpp` at compile
- `node-opcua` — validated in Bun spike, pure JS v4.x
- MQTT library — needs validation before task 2.3

### Test Infrastructure
- Modbus: stub/mock modbus-serial client or lightweight mock TCP server
- OPC-UA: use node-opcua server module for test fixtures
- MQTT: use aedes or similar in-process broker for tests
