# Phase 11 Progress — Real OPC-UA Client Adapter

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 11.0 | PRD & Backlog Updates | ✅ |
| 11.1 | RealOpcuaClient adapter | ✅ |
| 11.2 | Wire into plugin factory | ✅ |
| 11.3 | Unit tests for RealOpcuaClient | ✅ |
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

### Task 11.3 (2026-02-26)
- Created `test/unit/core/opcua-client.test.ts` — 33 tests for RealOpcuaClient adapter against in-process OPCUAServer
- **Test server setup**: `OPCUAServer` on port 0 (OS-assigned), custom namespace `http://collatr-edge.test/UA/TestData`, 4 variable nodes (Int32, Float, Double, Boolean) under a `Dynamic` folder
- **Connect/disconnect tests**: connect to in-process server, unreachable endpoint throws with descriptive message, double disconnect is safe
- **Session tests**: anonymous session creation, session without auth arg defaults to anonymous, throws if not connected
- **Subscription tests**: subscription creation, throws if session not active
- **Data change tests**: initial value on subscribe, value mutation triggers callback, multiple nodes monitored simultaneously with correct data types
- **Error handling**: unparseable node ID (e.g., `"totally-invalid-garbage!!!"`) throws via `coerceNodeId`; non-existent but parseable node ID (`ns=99;i=99999`) silently resolves with no events (valid OPC-UA behavior)
- **Browse tests**: discovers nodes under ObjectsFolder, respects maxDepth, filters by nodeClass, throws if session not active
- **Namespace resolution**: resolves known URI to index, throws on unknown URI
- **Lifecycle**: closeSession terminates subscription and session, double closeSession is safe
- **Connection loss**: isolated server shutdown triggers `onClose` callback, `isConnected` becomes `false`
- **Certificate fingerprint**: SHA-256 fingerprint available after connect (colon-separated uppercase hex)
- **Transfer subscriptions**: returns `false` when no session/subscription exists
- **Security mapping**: `mapSecurityPolicy` and `mapSecurityMode` map all supported values correctly, throw on unknown values
- All 1039 tests pass (33 new + 1006 existing)
