# Phase 11 — Real OPC-UA Client Adapter

## Overview

Phase 11 builds the `RealOpcuaClient` adapter that bridges the `OpcuaClient` interface (defined in `src/plugins/inputs/opcua.ts`) to the `node-opcua` library. This is the last piece needed for CollatrEdge to connect to real OPC-UA servers.

The entire `OpcuaInput` class (subscription handling, data type mapping, reconnection logic, security auto-negotiation, browse mode, topic tag extraction) is already built and tested with mock clients. This phase implements the adapter and wires it into the plugin factory.

**Context:** Discovered during smoke testing (`configs/smoke-test-public.toml`) against Eclipse Milo demo server (`opc.tcp://milo.digitalpetri.com:62541/milo`). The OPC-UA input was configured with 4 dynamic nodes but produced no data because `RealOpcuaClient` doesn't exist. The `start()` method throws: "OPC-UA client not provided."

**Bun compatibility:** Validated in Phase 0 spike. `node-opcua` v4.x is pure JavaScript (crypto moved off native C++ addons). All operations work in Bun including compiled binaries.

## PRD References

- Appendix D — OPC-UA Input Plugin Specification (§D.1 connection, §D.2 security, §D.3 data types, §D.4 subscriptions, §D.5 browse, §D.6 reconnection, §D.7 error handling)
- §6 Plugin System — plugin lifecycle
- §16 Security — TOFU certificate trust
- §19 MVP Plugin Inventory — `opcua` plugin

## Acceptance Criteria

- [ ] `RealOpcuaClient` implements full `OpcuaClient` interface from `opcua.ts`
- [ ] Plugin factory creates `OpcuaInput` with `RealOpcuaClient` when no client injected
- [ ] Connects to Eclipse Milo demo server and receives data changes
- [ ] Security auto-negotiation works (try policies in fallback order)
- [ ] Browse mode discovers nodes and writes TOML output file
- [ ] TOFU certificate trust: accept on first connect, reject on mismatch
- [ ] Data type mapping works for all 22+ types from Appendix D §D.3
- [ ] Reconnection with subscription transfer works (connection loss → automatic recovery)
- [ ] All existing OPC-UA tests still pass (mock client path unchanged)
- [ ] New integration tests verify real client adapter against mock OPC-UA server
- [ ] PRD Appendix D and post-MVP backlog updated

## Tasks

### Task 11.0 — PRD & Backlog Updates

**Files:** `prd/appendix-d-opc-ua-input-plugin-specification.md`, `plans/post-mvp-backlog.md`

1. Update backlog item #12 (OPC-UA Client Wrapper):
   - Change title from "OPC-UA Client Wrapper" to "~~OPC-UA Client Wrapper~~ — DONE (Phase 11)"
   - Update description: the wrapper is not just a testability improvement — it's the adapter that makes OPC-UA work at all. The original description was misleading.
2. In Appendix D, add a note at §D.1 confirming the adapter architecture: `OpcuaClient` interface → `RealOpcuaClient` adapter → `node-opcua` library. Tests use mock `OpcuaClient` implementations; production uses `RealOpcuaClient`.

### Task 11.1 — RealOpcuaClient Adapter

**File:** `src/core/opcua-client.ts`

Implement the `OpcuaClient` interface by wrapping `node-opcua`. This is the core deliverable.

**Interface to implement** (from `src/plugins/inputs/opcua.ts`):

```typescript
interface OpcuaClient {
  connect(endpointUrl: string, options: OpcuaClientOptions): Promise<void>;
  createSession(auth?: OpcuaAuthOptions): Promise<void>;
  createSubscription(params: OpcuaSubscriptionParams): Promise<void>;
  addMonitoredItem(item: OpcuaMonitoredItemParams): Promise<void>;
  onDataChange(handler: (event: DataChangeEvent) => void): void;
  onClose(handler: () => void): void;
  transferSubscriptions(): Promise<boolean>;
  browse(rootNodeId: string, maxDepth: number, nodeClasses: string[]): Promise<BrowseResultNode[]>;
  resolveNamespaceUri(uri: string): Promise<number>;
  closeSession(): Promise<void>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
  readonly sessionActive: boolean;
}
```

**Implementation notes per method:**

#### `connect(endpointUrl, options)`
- Create `node-opcua.OPCUAClient` with:
  - `securityPolicy`: map string → `SecurityPolicy` enum
  - `securityMode`: map string → `MessageSecurityMode` enum
  - `connectionStrategy`: `{ maxRetry: 0 }` (we handle reconnection ourselves in `OpcuaInput.reconnect()`)
  - `endpointMustExist: false` (discovery may fail on some servers)
  - `requestedSessionTimeout`: from `options.sessionTimeout`
  - `clientCertificateManager`: if certificate/key paths provided, load them
- Call `client.connect(endpointUrl)`
- After connect, extract server certificate for TOFU:
  - Get `client.endpoint.serverCertificate`
  - Compute SHA-256 fingerprint
  - Store as `this.serverCertificateFingerprint`

#### `createSession(auth)`
- `auth.type === "anonymous"`: `client.createSession()`
- `auth.type === "username"`: `client.createSession({ type: UserTokenType.UserName, userName: auth.username, password: auth.password })`
- `auth.type === "certificate"`: defer (not common in MVP targets, but interface supports it)

#### `createSubscription(params)`
- `ClientSubscription.create(session, { requestedPublishingInterval, requestedMaxKeepAliveCount, requestedLifetimeCount, maxNotificationsPerPublish, publishingEnabled: true })`
- Store subscription reference for monitored item creation

#### `addMonitoredItem(item)`
- Parse `item.nodeId` string → `node-opcua.NodeId`
- Create `ClientMonitoredItem` via `subscription.monitor()`:
  - `nodeId`, `attributeId: AttributeIds.Value`
  - `samplingInterval: item.samplingInterval` (-1 = server decides)
  - `queueSize: item.queueSize`
  - If deadband: `filter: new DataChangeFilter({ trigger, deadbandType, deadbandValue })`
- Wire `monitoredItem.on("changed")` to call stored `dataChangeHandler`
- Map `node-opcua` DataValue to our `DataChangeEvent`:
  - `nodeId`: item.nodeId (string)
  - `value`: extract from DataValue.value.value
  - `dataType`: DataType enum name (e.g., `"Float"`, `"Int32"`)
  - `sourceTimestamp`: DataValue.sourceTimestamp
  - `serverTimestamp`: DataValue.serverTimestamp
  - `statusCode`: DataValue.statusCode.value (numeric)
  - `quality`: derive from status code (top 2 bits)

#### `onDataChange(handler)`, `onClose(handler)`
- Store callbacks. `onClose`: wire to `client.on("close")` or `client.on("connection_lost")`

#### `transferSubscriptions()`
- Call `session.transferSubscriptions()` if the session supports it
- Return `true` on success, `false` if not supported

#### `browse(rootNodeId, maxDepth, nodeClasses)`
- Recursive BrowseDescription traversal from `rootNodeId`
- For each node: read `BrowseName`, `NodeClass`, `DataType` (for Variables), optionally current value
- Filter by `nodeClasses` parameter
- Respect `maxDepth` to prevent runaway traversal
- Return `BrowseResultNode[]`

#### `resolveNamespaceUri(uri)`
- Read namespace array from server: `session.readNamespaceArray()`
- Find index of `uri` in the array
- Throw if not found

#### `closeSession()`, `disconnect()`
- Graceful teardown: close session first, then disconnect client
- Handle cases where session/client is already closed

#### `isConnected`, `sessionActive`
- Delegate to `node-opcua` client/session state

**TOFU certificate support:**
- On first `connect()`, store server cert fingerprint
- Expose `getServerCertificateFingerprint(): string | null`
- The `OpcuaInput` class already handles TOFU logic using this — the adapter just provides the raw fingerprint

**Error mapping:**
- Wrap `node-opcua` errors in standard `Error` objects with descriptive messages
- Map `StatusCode` results to meaningful error messages for common failures (BadNodeIdUnknown, BadSessionClosed, etc.)

### Task 11.2 — Wire into Plugin Factory

**File:** `src/pipeline/plugin-factory.ts`

Update the `opcua` entry in `INPUT_FACTORIES`:

```typescript
// Before:
opcua: (config) => new OpcuaInput(OpcuaConfigSchema.parse(config)),

// After:
opcua: (config) => {
  const { RealOpcuaClient } = require("../core/opcua-client");
  return new OpcuaInput(OpcuaConfigSchema.parse(config), new RealOpcuaClient());
},
```

**Why lazy require:** `node-opcua` is a large library (~50MB). Lazy loading ensures it's only imported when an OPC-UA input is actually configured. This keeps startup fast for MQTT-only or Modbus-only deployments.

**Alternative approach:** Dynamic `import()` won't work here because the factory is synchronous. Use `require()` for lazy loading. If Bun's `require()` has issues with `node-opcua`, fall back to top-level import (acceptable given the factory is only called during pipeline construction).

**Remove the TODO/throw** from `OpcuaInput.start()`:
```typescript
// REMOVE this block from start():
if (!this.client) {
  throw new Error(
    "OPC-UA client not provided. Inject a client via constructor or " +
    "implement the real node-opcua wrapper.",
  );
}
```

The factory now always provides a client, so this guard becomes dead code. Keep the null check but make it a runtime safety assertion (should never happen):

```typescript
if (!this.client) {
  throw new Error("OPC-UA client not initialized — this is a bug");
}
```

### Task 11.3 — Unit Tests for RealOpcuaClient

**File:** `test/unit/core/opcua-client.test.ts`

Test the adapter in isolation using a mock `node-opcua` server (or by mocking `node-opcua` internals).

**Approach:** `node-opcua` provides `OPCUAServer` for testing. Create a lightweight in-process OPC-UA server with a few test nodes, then verify:

1. `connect()` connects to the server
2. `createSession()` creates an anonymous session
3. `createSubscription()` creates a subscription
4. `addMonitoredItem()` monitors a node and receives data changes via `onDataChange` callback
5. `browse()` discovers nodes from the test server
6. `resolveNamespaceUri()` resolves a known namespace URI
7. `closeSession()` and `disconnect()` clean up without errors
8. `isConnected` and `sessionActive` reflect current state
9. Connection loss triggers `onClose` callback
10. Security policy mapping: "None", "Basic256Sha256" map to correct `node-opcua` enums
11. Server certificate fingerprint is available after connect
12. Error handling: connect to unreachable endpoint → throws with descriptive message
13. Error handling: addMonitoredItem with bad node ID → throws, doesn't crash

**Important:** These tests require `node-opcua`'s OPCUAServer which starts a real TCP listener. Use unique ports per test to avoid conflicts. Set reasonable timeouts (5s per test). These are closer to integration tests but test the adapter in isolation.

### Task 11.4 — Integration Test: Smoke Test Validation

**File:** `test/integration/opcua-real-client.test.ts`

End-to-end test of the full pipeline path: config → plugin factory → OpcuaInput with RealOpcuaClient → data flows to accumulator.

1. Start an in-process `node-opcua` OPCUAServer with 4 dynamic nodes (Random Int32, Float, Double, Boolean)
2. Create config matching the smoke test pattern:
   ```toml
   [[inputs.opcua]]
     endpoint = "opc.tcp://localhost:PORT"
     security_policy = "None"
     security_mode = "None"
     auth_method = "anonymous"
     nodes = [...]
   ```
3. Build pipeline via `buildPipeline()` from plugin factory
4. Start pipeline, wait for data changes (up to 5s)
5. Verify metrics appeared with correct field names and types
6. Stop pipeline, verify clean shutdown

**Test 2: Browse mode**
1. Same server setup
2. Config with `browse.enabled = true`, `browse.output_file = tmpPath`
3. Start plugin, verify output file was written with discovered nodes
4. Verify output is valid TOML-comment format

**Test 3: Security auto-negotiation**
1. Server configured with `SecurityPolicy.Basic256Sha256`
2. Config with `security_policy = "auto"`
3. Verify connection succeeds (falls through negotiation order)

**Timeout:** These tests involve real TCP connections. Set per-test timeout to 15s. Mark with a comment: `// Integration test — requires node-opcua server`

### Task 11.5 — Smoke Test: Live Connection to Eclipse Milo Demo Server

**File:** `test/integration/opcua-milo-smoke.test.ts`

This is the acceptance test that proves the original smoke test failure is fixed. It connects to the real public Eclipse Milo demo server — the same one that produced zero data when Lee ran `smoke-test-public.toml`.

**Server:** `opc.tcp://milo.digitalpetri.com:62541/milo`
**Security:** None/None, anonymous auth
**Dynamic nodes:** `ns=2;s=Dynamic/RandomInt32`, `ns=2;s=Dynamic/RandomFloat`, `ns=2;s=Dynamic/RandomDouble`

**Test steps:**
1. Create `RealOpcuaClient`, connect to Milo demo server
2. Create session (anonymous)
3. Create subscription (publishing interval 2s)
4. Add monitored items for 3 dynamic nodes
5. Wait for data changes (up to 10s)
6. Verify: at least 1 data change received per node
7. Verify: field values are numeric (not null, not string)
8. Verify: source timestamps are present and recent (within last 60s)
9. Clean shutdown: close session, disconnect

**Offline guard:** The public server may be down. Wrap the entire test in a skip-if-offline guard:
```typescript
let canConnect = true;
try {
  // Quick connect attempt with short timeout
  await client.connect(endpoint, { ...opts, connectTimeout: 5000 });
  await client.disconnect();
} catch {
  canConnect = false;
}
test.skipIf(!canConnect)("connects to Milo demo and receives data", async () => { ... });
```
Alternatively, use `try/catch` on the connect and `test.skip()` if it fails. The key constraint: this test MUST NOT cause CI failures when the public server is unreachable.

**Timeout:** 30s for the full test (connect + subscribe + wait for data + teardown).

### Task 11.6 — Remove Stale TODO, Update OpcuaInput Guard

**File:** `src/plugins/inputs/opcua.ts`

1. Remove the Phase 7 TODO comment at line 531
2. Replace the throw block with a safety assertion (see Task 11.2 notes)
3. Update the module header comment: remove "plain string payloads" (was never true for OPC-UA), confirm that `RealOpcuaClient` provides the production adapter

## What This Does NOT Do

- No TOFU persistence (storing accepted fingerprints to disk). The Web UI cert helper page (Phase 9) provides the UI; persistent trust store is post-MVP.
- No certificate generation. Self-signed cert generation for `SignAndEncrypt` is post-MVP.
- No OPC-UA write services. CollatrEdge is READ-ONLY. This is a permanent safety constraint.
- No OPC-UA Alarms & Conditions. Subscription to A&C events is post-MVP.
- No namespace URI caching. `resolveNamespaceUri()` calls the server each time. Caching is a performance optimisation for post-MVP.

## Risks

| Risk | Mitigation |
|------|-----------|
| `node-opcua` OPCUAServer is heavy for tests | Keep test server minimal (4 nodes). Reuse across tests in same file. |
| Port conflicts in parallel test runs | Use `0` (OS-assigned) ports. Extract actual port after server start. |
| `node-opcua` import time slows all tests | Lazy `require()` in factory. Tests that don't use OPC-UA won't load it. |
| Bun `require()` incompatibility with `node-opcua` | Validated in Phase 0 spike. If issues arise, fall back to top-level import. |
| OPCUAServer startup time | May need `beforeAll` with extended timeout (10s). |

## Build Order

11.0 (PRD/backlog) → 11.1 (adapter) → 11.2 (factory wiring) → 11.3 (adapter unit tests) → 11.4 (in-process integration tests) → 11.5 (Milo live smoke test) → 11.6 (cleanup)

Task 11.1 is the bulk of the work. Task 11.2 is small but depends on 11.1. Tasks 11.3 and 11.4 can potentially be done together but keeping them separate follows the workflow pattern of separating unit and integration tests. Task 11.5 is the acceptance test against the real public Milo server — the whole reason this phase exists.
