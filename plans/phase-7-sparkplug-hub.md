# Phase 7: Sparkplug B Hub Link

## Goal

Implement the Hub link runtime component and MQTT output plugin so CollatrEdge can connect to a Collatr Hub (or any Sparkplug B-compliant SCADA host) via MQTT, publish device birth/death certificates, stream telemetry as DDATA, handle rebirth commands, and publish agent self-metrics as NDATA.

PRD §21 estimate: 1–1.5 weeks.

## PRD References

- **§9 Hub Link & Control Plane** — primary spec (architecture, topic structure, device mapping, aliases, sequence numbers, data types, control plane ops, config)
- **§10 Network Policy & Standalone Operation** — mode presets, fail-fast enforcement, mode transitions
- **§19 MVP Plugin Inventory** — `outputs.mqtt` (P0, plain MQTT and Sparkplug B)
- **§12 Buffers & Delivery Guarantees** — at-least-once, overflow policies (for MQTT output wiring, NOT S&F integration)
- **§14 Error Handling & Resilience** — reconnection, exponential backoff
- **§15 Observability** — structured logging for hub link events
- **Appendix A** — `[agent.hub]` config section example
- **Appendix C** — Sparkplug B topic map (NBIRTH/NDEATH/DBIRTH/DDEATH/DDATA/NDATA/NCMD payloads)

## What Phase 7 Does NOT Do

- **S&F buffer integration** — the buffer exists but is not wired to the runtime flush loop. This is deferred and tracked separately.
- **Network policy enforcement** — Phase 8 implements the full `[network_policy]` config, egress rules, DNS blocking, and fail-fast output validation.
- **Config push via NCMD** — NCMD `Node Control/Config` handling is deferred. Only `Node Control/Rebirth` is implemented in Phase 7.
- **Web UI** — Phase 9.
- **Plain MQTT output (non-Sparkplug)** — an `outputs.mqtt` plugin that publishes raw JSON/line-protocol to arbitrary topics is useful but is a separate, simpler output. Phase 7 focuses on the Sparkplug B protocol.  The MQTT client wrapper created here will be reusable for a future plain MQTT output.
- **DCMD (device commands)** — CollatrEdge is read-only. Modbus is FC01-04 only. DCMD is not implemented.
- **Mode transition messages** — the "going standalone" NDATA message (§10) requires network policy (Phase 8).

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| `mqtt` npm package | ✅ Installed | Already used by mqtt-consumer input; real client wrapper needed |
| `sparkplug-payload` npm package | ❌ Not installed | Protobuf encode/decode for Sparkplug B payloads. Pure JS (protobufjs). Must verify Bun compatibility. |
| `MqttClientInterface` | ✅ Exists | Interface defined in `mqtt-consumer.ts`. Needs real implementation (currently a stub). |
| `[agent.hub]` config schema | ✅ Exists | Already in `config.ts` AgentSchema (group_id, edge_node_id, broker, tls_cert, tls_key). Needs `enabled`, `heartbeat_interval`. |
| Plugin factory | ✅ Exists | Needs MQTT output entry added. |
| Plugin schema registry | ✅ Exists | Needs MQTT output schema registered. |

## Pre-Phase-7 Spike: sparkplug-payload + Bun

Before writing any production code, validate that `sparkplug-payload` works under `bun build --compile`:

```bash
bun add sparkplug-payload
# Write a test that encodes/decodes a NBIRTH payload with metrics
# Verify it works in `bun test`
# Verify it compiles: `bun build --compile --minify ...`
```

If `sparkplug-payload` fails with Bun (protobufjs is complex), fallback: use the Sparkplug B protobuf schema directly with `protobufjs` (already a transitive dep of sparkplug-payload). Last resort: hand-roll a minimal encoder for the subset of Sparkplug B types we use (the wire format is documented).

This spike is task 7.0. Proceed with production code only after it passes.

---

## Task Breakdown

### Task 7.0: Sparkplug B payload spike

**Goal:** Verify `sparkplug-payload` works with Bun runtime and compilation.

**Files:**
- `test/unit/spike/sparkplug-payload.test.ts` — spike test

**Steps:**
1. `bun add sparkplug-payload`
2. Write a test that:
   - Encodes an NBIRTH payload with 3 metrics (Int32, Double, Boolean)
   - Decodes it back and verifies all field values match
   - Encodes a DDATA payload with metric aliases
   - Decodes it and verifies aliases + values
   - Encodes an NDEATH payload with bdSeq
   - Verifies timestamps are preserved (64-bit, milliseconds)
3. Run `bun test test/unit/spike/` — must pass
4. Run `bun build --compile --minify --sourcemap --external=@serialport/bindings-cpp --outfile /tmp/spike-test src/index.ts` — must succeed (no compilation errors from sparkplug-payload)
5. If fails: try `@jcoreio/sparkplug-payload` (maintained fork), or raw `protobufjs`

**Commit:** `phase-7: spike — verify sparkplug-payload works with Bun`

**Pass/fail gate:** If no Sparkplug B protobuf library works with Bun compilation, raise immediately. Do not proceed.

---

### Task 7.1: Real MQTT client wrapper

**Goal:** Replace the stub `createDefaultMqttClient()` in mqtt-consumer.ts with a real implementation that wraps the `mqtt` npm package. Extract it to a shared module so both the MQTT consumer input and the Hub link/MQTT output can use it.

**Files:**
- `src/core/mqtt-client.ts` — new shared MQTT client wrapper
- `test/unit/core/mqtt-client.test.ts` — unit tests
- `src/plugins/inputs/mqtt-consumer.ts` — update `createDefaultMqttClient()` to use shared wrapper

**Spec:**

```typescript
// src/core/mqtt-client.ts

import type { MqttClientInterface, MqttClientOptions, MqttMessageEvent } from "./mqtt-types";

/**
 * Wraps the `mqtt` npm package, implementing MqttClientInterface.
 * 
 * Features:
 * - connect(servers, options): connects to first available broker
 * - Automatic reconnection with configurable backoff
 * - TLS support (ca, cert, key, rejectUnauthorized)
 * - Will message support (for NDEATH)
 * - QoS 0/1 publish support
 * - Clean session control
 */
export class RealMqttClient implements MqttClientInterface {
  // ...
}
```

The `MqttClientInterface` needs to be **extended** for Hub link requirements:

```typescript
// Additional methods needed on MqttClientInterface:
export interface MqttClientInterface {
  // ... existing methods ...
  
  // New for Phase 7:
  publish(topic: string, payload: Buffer, options?: { qos?: 0 | 1; retain?: boolean }): Promise<void>;
  setWill(topic: string, payload: Buffer, qos?: 0 | 1, retain?: boolean): void;
}
```

**Steps:**
1. Move `MqttClientInterface` and related types from `mqtt-consumer.ts` to `src/core/mqtt-types.ts` (shared)
2. Extend interface with `publish()` and `setWill()`
3. Create `src/core/mqtt-client.ts` implementing `RealMqttClient`
4. Update `mqtt-consumer.ts` imports to use shared types and new default factory
5. Write tests: connect (mock), publish, subscribe, reconnect, error events, will message, TLS option passing
6. Run `bun test` — all tests must pass (including all mqtt-consumer tests)
7. Commit: `phase-7: extract shared MQTT client wrapper from mqtt-consumer`

**Key design decisions:**
- The real `mqtt` package handles reconnection internally. We wrap it, not replace it.
- `setWill()` must be called BEFORE `connect()` — it configures the Will message in MQTT CONNECT packet.
- The existing `MqttConsumerInput` constructor accepts an optional client for DI in tests — this doesn't change.

---

### Task 7.2: Sparkplug B codec module

**Goal:** Create a Sparkplug B encoding/decoding module that wraps `sparkplug-payload` with CollatrEdge-specific logic: metric type mapping, alias computation, and payload construction for each message type.

**Files:**
- `src/hub/sparkplug-codec.ts` — new module
- `test/unit/hub/sparkplug-codec.test.ts` — unit tests

**Spec:**

```typescript
// src/hub/sparkplug-codec.ts

import type { Metric, FieldValue } from "../core/metric";

/** Sparkplug B metric types (subset we support) */
export type SparkplugDataType = 
  | "Int32" | "Int64" | "Double" | "Boolean" | "String";

/** Map a CollatrEdge FieldValue to a Sparkplug B data type */
export function fieldValueToSparkplugType(value: FieldValue): SparkplugDataType;

/** Compute deterministic metric alias: FNV-1a hash mod 2^31 */
export function computeMetricAlias(deviceId: string, metricName: string): number;

/** Resolve alias collisions within a device's metric set */
export function resolveAliases(deviceId: string, metricNames: string[]): Map<string, number>;

/** Encode NBIRTH payload (protobuf bytes) */
export function encodeNBirth(options: {
  bdSeq: number;
  swVersion: string;
  hwPlatform: string;
  hostname: string;
  pluginsLoaded: string[];
  agentMetrics: { name: string; type: SparkplugDataType; value: unknown }[];
}): Buffer;

/** Encode NDEATH payload (protobuf bytes) — Will message */
export function encodeNDeath(bdSeq: number): Buffer;

/** Encode DBIRTH payload — full metric definition for a device */
export function encodeDBirth(options: {
  deviceId: string;
  metrics: Metric[];       // Initial values
  aliases: Map<string, number>;  // name → alias
  pluginType: string;
  pluginAlias: string;
  properties?: Record<string, string>;
}): Buffer;

/** Encode DDEATH payload */
export function encodeDDeath(): Buffer;

/** Encode DDATA payload — changed metrics (alias-based) */
export function encodeDData(options: {
  metrics: Metric[];
  aliases: Map<string, number>;
}): Buffer;

/** Encode NDATA payload — agent self-metrics */
export function encodeNData(options: {
  seq: number;
  metrics: { name: string; type: SparkplugDataType; value: unknown; timestamp?: bigint }[];
}): Buffer;

/** Decode NCMD payload — for rebirth handling */
export function decodeNCmd(payload: Buffer): {
  metrics: { name: string; value: unknown; type: string }[];
};
```

**Field value → Sparkplug type mapping (from PRD §9):**

| FieldValue Type | JS check | Sparkplug B Type |
|----------------|----------|-----------------|
| `number` (integer, `Number.isInteger()`, abs ≤ 2^31-1) | `typeof === 'number' && isInteger && abs ≤ 2147483647` | `Int32` |
| `number` (integer, abs > 2^31-1) | `typeof === 'number' && isInteger && !inInt32Range` | `Int64` |
| `number` (float) | `typeof === 'number' && !isInteger` | `Double` |
| `boolean` | `typeof === 'boolean'` | `Boolean` |
| `string` | `typeof === 'string'` | `String` |
| `bigint` | `typeof === 'bigint'` | `Int64` |

**Metric alias computation (from PRD §9):**
```
alias = FNV-1a_hash(device_id + "/" + metric_name) mod 2^31
```
- FNV-1a 32-bit hash
- On collision: increment until unique within the device's metric set
- Deterministic across restarts (no persistence needed)

**Steps:**
1. Create `src/hub/sparkplug-codec.ts`
2. Implement FNV-1a hash function (32-bit, ~15 lines)
3. Implement type mapping functions
4. Implement all encode/decode functions using `sparkplug-payload` library
5. Write comprehensive tests:
   - Type mapping: all 6 FieldValue cases
   - Alias computation: deterministic, collision resolution, stability across calls
   - NBIRTH: encode→decode round-trip, all properties present, bdSeq correct
   - NDEATH: encode→decode, bdSeq present
   - DBIRTH: encode→decode, all metrics present with aliases and types, properties
   - DDATA: encode→decode, alias-based (no metric names), timestamps preserved
   - NDATA: encode→decode, seq number correct
   - NCMD decode: rebirth command parsing
6. Run `bun test` — all pass
7. Commit: `phase-7: add Sparkplug B codec — payload encoding, type mapping, metric aliases`

---

### Task 7.3: Hub link session manager

**Goal:** Create the core Hub link component that manages the Sparkplug B edge node session: MQTT connection, birth/death lifecycle, sequence numbering, device tracking, and NCMD subscription.

This is a **runtime component** (not a plugin). It is instantiated by the pipeline runtime when `[agent.hub]` is configured and `enabled = true`.

**Files:**
- `src/hub/hub-link.ts` — new module
- `test/unit/hub/hub-link.test.ts` — unit tests

**Spec:**

```typescript
// src/hub/hub-link.ts

export interface HubLinkConfig {
  groupId: string;
  edgeNodeId: string;
  broker: string;          // MQTT URL
  tlsCert?: string;        // path or @{secrets:...}
  tlsKey?: string;
  heartbeatIntervalMs: number;
  swVersion: string;       // from package.json
}

export interface DeviceInfo {
  deviceId: string;        // Plugin alias
  pluginType: string;      // e.g., "modbus"
  pluginAlias: string;
  initialMetrics: Metric[];  // First gather results → DBIRTH
  properties?: Record<string, string>;
}

export class HubLink {
  private client: MqttClientInterface;
  private config: HubLinkConfig;
  private bdSeq: number;         // Birth/death sequence (0-255, persisted)
  private seq: number;           // Message sequence (0-255, resets on NBIRTH)
  private devices: Map<string, DeviceInfo>;
  private aliases: Map<string, Map<string, number>>; // deviceId → (metricName → alias)
  private connected: boolean;

  constructor(config: HubLinkConfig, client?: MqttClientInterface);

  /** Start the hub link: set Will, connect, publish NBIRTH, subscribe to NCMD */
  async start(): Promise<void>;

  /** Register a device (input plugin). Called during pipeline startup. */
  registerDevice(device: DeviceInfo): void;

  /** Publish DBIRTH for a device. Called after first successful gather. */
  async publishDeviceBirth(deviceId: string, metrics: Metric[]): Promise<void>;

  /** Publish DDATA for a device. Called from output flush. */
  async publishDeviceData(deviceId: string, metrics: Metric[]): Promise<void>;

  /** Publish DDEATH for a device. Called when input fails/disconnects. */
  async publishDeviceDeath(deviceId: string): Promise<void>;

  /** Publish NDATA with agent self-metrics. Called on heartbeat timer. */
  async publishNodeData(metrics: { name: string; value: unknown; type: SparkplugDataType }[]): Promise<void>;

  /** Handle incoming NCMD messages */
  private handleNCmd(payload: Buffer): void;

  /** Perform full rebirth (NBIRTH + all DBIRTHs) */
  async rebirth(): Promise<void>;

  /** Graceful shutdown: publish DDEATH for all devices, then disconnect */
  async stop(): Promise<void>;

  /** Get the next seq number (0-255, wrapping) */
  private nextSeq(): number;
}
```

**Topic building:**
```typescript
const TOPIC_PREFIX = "spBv1.0";
function topic(groupId: string, msgType: string, edgeNodeId: string, deviceId?: string): string {
  const base = `${TOPIC_PREFIX}/${groupId}/${msgType}/${edgeNodeId}`;
  return deviceId ? `${base}/${deviceId}` : base;
}
```

**Sequence numbering (PRD §9):**
- `bdSeq`: 0-255, incremented on each NBIRTH. Persisted in plugin state (SQLite) across restarts. NDEATH Will message carries same bdSeq as corresponding NBIRTH.
- `seq`: 0-255, reset to 0 on each NBIRTH. Incremented for every outgoing message (NDATA, DDATA, DBIRTH, DDEATH).
- On crash recovery: read last bdSeq from state, increment, publish NBIRTH. If state lost, start at 0.

**For MVP:** bdSeq persistence is deferred — always starts at 0. Add a TODO for SQLite state persistence (needs StatefulPlugin interface wiring, which is defined but not used yet). The Sparkplug B spec handles this gracefully — Hub sees a bdSeq gap and knows it's a fresh start.

**Steps:**
1. Create `src/hub/hub-link.ts`
2. Implement topic builder helper
3. Implement HubLink class with constructor (accepts MqttClientInterface for DI)
4. Implement `start()`: configure Will (NDEATH), connect, publish NBIRTH, subscribe to NCMD topic
5. Implement device registration and DBIRTH publishing
6. Implement DDATA publishing (alias-based, using codec)
7. Implement NDATA publishing (heartbeat self-metrics)
8. Implement NCMD handler (parse payload, handle `Node Control/Rebirth`)
9. Implement `rebirth()`: re-publish NBIRTH + all DBIRTHs, reset seq
10. Implement `stop()`: publish DDEATH for all devices, disconnect
11. Write tests with mock MQTT client:
    - start(): Will message set with correct NDEATH payload, NBIRTH published to correct topic
    - NBIRTH payload: bdSeq, properties, control metrics present
    - registerDevice + publishDeviceBirth: DBIRTH to correct topic with all metrics and aliases
    - publishDeviceData: DDATA to correct topic, alias-based encoding, seq incremented
    - publishNodeData: NDATA to correct topic, seq incremented
    - handleNCmd (rebirth): triggers full rebirth sequence
    - stop(): DDEATHs for all devices, disconnect
    - seq wraps at 255 → 0
    - Topic structure matches PRD §9 and Appendix C
12. Run `bun test` — all pass
13. Commit: `phase-7: add Hub link session manager — Sparkplug B edge node lifecycle`

---

### Task 7.4: MQTT output plugin (Sparkplug B mode)

**Goal:** Create an MQTT output plugin that publishes metrics via the Hub link using Sparkplug B encoding. When the output targets the same broker as the Hub link, it uses the Hub link's MQTT connection (single connection, per PRD §9).

**Files:**
- `src/plugins/outputs/mqtt.ts` — new MQTT output plugin
- `test/unit/plugins/outputs/mqtt.test.ts` — unit tests

**Spec:**

```typescript
// src/plugins/outputs/mqtt.ts

export const MqttOutputConfigSchema = z.object({
  // Connection (used when NOT sharing Hub link connection)
  servers: z.array(z.string()).optional(),
  client_id: z.string().optional(),
  
  // Sparkplug B mode (when hub link handles connection)
  sparkplug: z.boolean().default(false),
  
  // Plain MQTT mode settings
  topic: z.string().optional()
    .describe("Topic template for plain mode. Supports ${name} substitution."),
  data_format: z.enum(["json", "sparkplug"]).default("json"),
  qos: z.number().int().min(0).max(1).default(1),
  retain: z.boolean().default(false),
  
  // Auth
  username: z.string().optional(),
  password: z.string().optional(),
  
  // TLS
  tls: z.object({
    ca_file: z.string().optional(),
    cert_file: z.string().optional(),
    key_file: z.string().optional(),
    insecure_skip_verify: z.boolean().default(false),
  }).optional(),
  
  // Reconnection
  reconnect: z.object({
    initial_delay: z.string().default("1s"),
    max_delay: z.string().default("30s"),
  }).default({ initial_delay: "1s", max_delay: "30s" }),
});

export class MqttOutput implements Output {
  constructor(config: MqttOutputConfig, hubLink?: HubLink, client?: MqttClientInterface);
  
  async connect(): Promise<void>;
  async write(batch: Metric[]): Promise<void>;
  async close(): Promise<void>;
}
```

**Write behaviour:**
- In Sparkplug mode (`sparkplug: true` or when Hub link connection is shared): group metrics by their source device (via tag `_source_device` or similar mechanism) and call `hubLink.publishDeviceData(deviceId, metrics)`.
- In plain MQTT mode: encode each metric as JSON (or batch) and publish to configured topic.

**Device ID resolution for DDATA:**
- Each metric needs to map back to its source input plugin (= Sparkplug device).
- Pipeline currently doesn't track source. **Simplest MVP approach:** Add an internal tag `_device_id` set by the input accumulator (from the plugin's alias). The MQTT output reads this tag for routing, strips it before encoding.
- Alternative (cleaner, more work): Track source on the Metric object itself via a metadata field.

**For MVP:** Use the tag approach. Add `_device_id` to ChannelAccumulator when the input has an alias. The MQTT output groups by this tag for Sparkplug routing.

**Steps:**
1. Create `src/plugins/outputs/mqtt.ts` with Zod schema and MqttOutput class
2. Implement `connect()`: connect via own client OR receive HubLink reference
3. Implement `write()` for Sparkplug mode: group by device_id → publishDeviceData
4. Implement `write()` for plain MQTT mode: JSON encode → publish to topic
5. Implement `close()`: disconnect (only if own connection, not Hub link's)
6. Register in plugin-factory.ts (OUTPUT_FACTORIES) and plugin-schemas.ts
7. Update config-init.ts template to include commented MQTT output example
8. Write tests:
   - Sparkplug mode: metrics grouped by device, published via hub link mock
   - Plain MQTT mode: metrics published as JSON to configured topic
   - connect/close lifecycle
   - Config validation (Zod schema)
9. Run `bun test` — all pass
10. Commit: `phase-7: add MQTT output plugin — Sparkplug B and plain MQTT modes`

---

### Task 7.5: Pipeline integration — Hub link wiring

**Goal:** Wire the Hub link into the pipeline runtime and plugin factory so that when `[agent.hub]` is configured and `enabled = true`, the Hub link starts/stops with the pipeline, devices are registered from input plugins, and the MQTT output can share the Hub link's connection.

**Files:**
- `src/pipeline/runtime.ts` — extend PipelineOptions, wire hub link lifecycle
- `src/pipeline/plugin-factory.ts` — create HubLink from config, pass to MQTT output
- `src/core/config.ts` — extend `[agent.hub]` schema (add `enabled`, `heartbeat_interval`)
- `src/core/accumulator.ts` — add `_device_id` tag injection
- `test/integration/hub-link-pipeline.test.ts` — integration test

**Config changes:**
```typescript
// In AgentSchema, extend hub:
hub: z.object({
  enabled: z.boolean().default(false),
  group_id: z.string(),
  edge_node_id: z.string(),
  broker: z.string(),
  tls_cert: z.string().optional(),
  tls_key: z.string().optional(),
  heartbeat_interval: durationString.default("30s"),
}).optional(),
```

**Pipeline integration points:**
1. `buildPipeline()` in plugin-factory: if `config.agent.hub?.enabled`, create HubLink instance and pass it to MQTT output plugins that have `sparkplug: true`.
2. `PipelineOptions` gains optional `hubLink: HubLink`.
3. `PipelineRuntime.start()`: if hubLink present, call `hubLink.start()` after output connects, before inputs start. Register devices from input aliases.
4. `PipelineRuntime.stop()`: call `hubLink.stop()` after pipeline drains, before plugin close.
5. `ChannelAccumulator`: when input has an alias, add `_device_id` tag to all metrics.

**DBIRTH timing:** DBIRTH needs the first gather's metrics to define the metric schema. Options:
- **Option A (simple):** Publish DBIRTH on first DDATA — the hub link tracks which devices have published DBIRTH and auto-publishes on first data.
- **Option B (eager):** Require inputs to declare their metric schema upfront (not currently supported).

**Use Option A.** The Hub link maintains a `Set<string>` of devices that have published DBIRTH. On first `publishDeviceData()` call for a device, it publishes DBIRTH first, then DDATA.

**Steps:**
1. Extend `[agent.hub]` schema in config.ts (add `enabled`, `heartbeat_interval`)
2. Extend `PipelineOptions` with optional `hubLink`
3. Update `buildPipeline()` to create HubLink when hub is enabled
4. Update `ChannelAccumulator` to inject `_device_id` tag when input has an alias
5. Update `PipelineRuntime.start()` to start hub link, register devices
6. Update `PipelineRuntime.stop()` to stop hub link
7. Wire MQTT output to receive hub link reference
8. Write integration test: full pipeline with hub link mock → verify NBIRTH published, DBIRTH on first data, DDATA published, DDEATH on shutdown
9. Run `bun test` — ALL tests pass (existing + new)
10. Commit: `phase-7: wire Hub link into pipeline — lifecycle, device registration, _device_id tagging`

---

### Task 7.6: Heartbeat and self-metrics via NDATA

**Goal:** Implement the periodic heartbeat that publishes agent self-metrics to Hub via NDATA. This connects the existing `InternalInput`/`StatsCollector` to the Hub link.

**Files:**
- `src/hub/hub-link.ts` — add heartbeat loop
- `test/unit/hub/hub-link.test.ts` — extend tests

**NDATA payload (from PRD §9 / Appendix C):**
```
Agent Metrics/
  ├── uptime_seconds: <number>
  ├── event_loop_lag_ms: <number>
  └── buffer_total_length: <number>
```

**Implementation:**
- HubLink starts an internal timer at `heartbeatIntervalMs`
- On each tick: collect self-metrics from StatsCollector, encode as NDATA, publish
- Timer is cancelled on stop()

**Steps:**
1. Add heartbeat timer to HubLink (start/stop with the session)
2. Accept optional StatsCollector in HubLink constructor
3. On heartbeat tick: read stats, encode NDATA, publish to `spBv1.0/{group_id}/NDATA/{edge_node_id}`
4. Write tests: heartbeat fires at interval, NDATA published with correct metrics, timer stops on shutdown
5. Run `bun test` — all pass
6. Commit: `phase-7: add Hub link heartbeat — periodic NDATA with agent self-metrics`

---

### Task 7.7: Phase 7 integration tests + cleanup

**Goal:** Write comprehensive integration tests proving the full Sparkplug B lifecycle works end-to-end: startup → NBIRTH → DBIRTH → DDATA → rebirth → shutdown → DDEATH/NDEATH.

**Files:**
- `test/integration/sparkplug-lifecycle.test.ts` — new integration test
- `test/integration/mqtt-output-pipeline.test.ts` — MQTT output in pipeline

**Test scenarios:**
1. **Full Sparkplug lifecycle:** Start pipeline with Hub link → verify NBIRTH → send metrics → verify DBIRTH (first data) → verify DDATA (subsequent) → trigger rebirth → verify re-NBIRTH + re-DBIRTH → shutdown → verify cleanup
2. **Multi-device:** Two inputs with different aliases → each gets own DBIRTH/DDATA on correct topics
3. **Sequence numbering:** Verify seq increments across messages, wraps at 255, resets on rebirth
4. **MQTT output in pipeline:** Full config-driven pipeline with MQTT output → verify metrics flow through
5. **Hub disabled:** Verify pipeline works normally when `hub.enabled = false` (no MQTT connection attempt)

**Cleanup items (address during this task):**
- Ensure all new modules have proper JSDoc
- Ensure plugin-schemas.ts includes `outputs.mqtt`
- Ensure config-init templates include Hub + MQTT output examples (commented)
- Update README.md with Hub configuration section

**Steps:**
1. Write all integration tests using mock MQTT client
2. Run full `bun test` — all tests pass
3. Address cleanup items
4. Run full `bun test` again — zero failures
5. Commit: `phase-7: add Sparkplug B integration tests and cleanup`

---

## Task Summary

| Task | Description | Est. | New Files | Key Risk |
|------|-------------|------|-----------|----------|
| 7.0 | sparkplug-payload spike | 30min | 1 test | Protobuf + Bun compat |
| 7.1 | Real MQTT client wrapper | 2-3h | 2 (+ refactor) | Event handling fidelity |
| 7.2 | Sparkplug B codec | 3-4h | 2 | Type mapping edge cases |
| 7.3 | Hub link session manager | 4-5h | 2 | Lifecycle complexity |
| 7.4 | MQTT output plugin | 2-3h | 2 | Device ID routing |
| 7.5 | Pipeline integration | 3-4h | 1 new + 4 modified | Wiring breadth |
| 7.6 | Heartbeat / NDATA | 1-2h | 0 (extend hub-link) | Timer lifecycle |
| 7.7 | Integration tests + cleanup | 2-3h | 2 | Test complexity |

**Total estimated: 18-24 hours of implementation**

## Acceptance Criteria

Phase 7 is complete when:

1. ✅ `sparkplug-payload` works with Bun (spike passes)
2. ✅ Real MQTT client wrapper shared between mqtt-consumer and hub link
3. ✅ Sparkplug B codec handles all PRD-specified data types and message types
4. ✅ Hub link manages full NBIRTH/NDEATH/DBIRTH/DDEATH/DDATA/NDATA lifecycle
5. ✅ NCMD `Node Control/Rebirth` triggers full rebirth
6. ✅ MQTT output plugin publishes via Hub link (Sparkplug mode) or independently (plain mode)
7. ✅ Pipeline starts/stops Hub link at correct lifecycle points
8. ✅ Heartbeat publishes NDATA at configured interval
9. ✅ All existing tests still pass (zero regressions)
10. ✅ ≥25 new tests covering Sparkplug B codec, Hub link, MQTT output, and pipeline integration
