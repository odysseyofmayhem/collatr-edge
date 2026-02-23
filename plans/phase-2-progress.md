# Phase 2: Inputs — Progress

## Status: NOT STARTED

## Pre-Phase Fixes
- [ ] ServiceInput support in runtime (task 2.0)
- [ ] metric_batch_size in output flush (task 2.0)

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 2.0 | ServiceInput runtime support + metric_batch_size | ⬜ |
| 2.1 | Modbus TCP input | ⬜ |
| 2.1i | Modbus → pipeline integration | ⬜ |
| 2.2 | OPC-UA input | ⬜ |
| 2.2i | OPC-UA → pipeline integration | ⬜ |
| 2.3 | MQTT consumer input | ⬜ |
| 2.3i | MQTT → pipeline integration | ⬜ |
| 2.4 | Internal metrics input | ⬜ |
| 2.4i | Internal metrics integration | ⬜ |

## Notes

### Dependencies
- `modbus-serial` — validated in Bun spike, use `--external=@serialport/bindings-cpp` at compile
- `node-opcua` — validated in Bun spike, pure JS v4.x
- MQTT library — needs validation before task 2.3

### Test Infrastructure
- Modbus: stub/mock modbus-serial client or lightweight mock TCP server
- OPC-UA: use node-opcua server module for test fixtures
- MQTT: use aedes or similar in-process broker for tests
