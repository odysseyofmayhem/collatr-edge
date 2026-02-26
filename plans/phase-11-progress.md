# Phase 11 Progress — Real OPC-UA Client Adapter

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 11.0 | PRD & Backlog Updates | ✅ |
| 11.1 | RealOpcuaClient adapter | ✅ |
| 11.2 | Wire into plugin factory | ✅ |
| 11.3 | Unit tests for RealOpcuaClient | ⬜ |
| 11.4 | Integration test: full pipeline with in-process OPC-UA server | ⬜ |
| 11.5 | Smoke test: live connection to Eclipse Milo demo server | ⬜ |
| 11.6 | Cleanup stale TODOs | ⬜ |

## Decisions & Notes

### Task 11.0 (2026-02-26)
- Updated Appendix D §D.1 with adapter architecture note explaining the `OpcuaClient` interface → `RealOpcuaClient` → `node-opcua` layering
- Updated post-MVP backlog item #12: marked as DONE by Phase 11, corrected description to reflect that this is a functional adapter (not just a testability improvement)
- All 1006 existing tests pass unchanged

### Task 11.1 (2026-02-26)
- Created `src/core/opcua-client.ts` — RealOpcuaClient adapter implementing all 13 OpcuaClient interface methods
- **Security policy mapping**: Config strings ("None", "Basic256Sha256", etc.) mapped to `node-opcua` `SecurityPolicy` and `MessageSecurityMode` enums via exported `mapSecurityPolicy()` / `mapSecurityMode()` functions
- **DataValue → DataChangeEvent conversion**: Extracts `value.value` from `Variant`, maps `DataType` enum to string name, copies timestamps and status code, derives quality category
- **Deadband filter**: Maps config deadband type/value to `node-opcua` `DataChangeFilter` with `DataChangeTrigger` and `DeadbandType` enums
- **TOFU fingerprint**: After connect, reads server endpoints and computes SHA-256 fingerprint of server certificate (colon-separated uppercase hex)
- **Browse**: Recursive traversal with depth limit, reads Variable node DataType and current value, filters by node class
- **Namespace resolution**: Uses `session.readNamespaceArray()` to resolve URI → index
- **Transfer subscriptions**: Uses low-level `session.transferSubscriptions()` (cast required — not on TS interface type but exists on implementation)
- **Connection state**: Tracked internally via `_isConnected` / `_sessionActive` flags, updated on connect/disconnect and close/connection_lost events
- **Error handling**: All node-opcua errors wrapped with descriptive messages, non-fatal errors (browse value read, fingerprint extraction) caught and logged
- **connectionStrategy.maxRetry = 0**: Reconnection managed by `OpcuaInput.reconnect()`, not node-opcua's internal retry
- All 1006 existing tests pass unchanged

### Task 11.2 (2026-02-26)
- Updated `INPUT_FACTORIES.opcua` in `src/pipeline/plugin-factory.ts` to lazy-load `RealOpcuaClient` via `require("../core/opcua-client")` and pass it to `OpcuaInput` constructor
- Lazy `require()` ensures `node-opcua` (~50MB) is only loaded when an OPC-UA input is actually configured — MQTT-only or Modbus-only deployments stay fast
- Replaced the stale TODO/throw block in `OpcuaInput.start()` (lines 530-537) with a safety assertion: `"OPC-UA client not initialized — this is a bug"` — should never trigger since factory always provides a client and tests always inject a mock
- All 1006 existing tests pass unchanged — mock-based OPC-UA tests unaffected because they inject the client directly via constructor
