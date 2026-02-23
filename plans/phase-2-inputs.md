# Phase 2: Input Plugins — Implementation Plan

**Goal:** Build all P0 input plugins (Modbus TCP, OPC-UA, MQTT consumer, internal metrics) and extend the pipeline runtime to support ServiceInput plugins. By the end of Phase 2, CollatrEdge can collect real data from industrial protocols and its own internal metrics.

**Estimated Duration:** 2–2.5 weeks
**PRD References:** §6 (Plugin System), §13 (Scheduling), §14 (Error Handling), §15 (Observability — internal metrics), §19 (MVP Plugin Inventory), Appendix B (Interfaces), Appendix D (OPC-UA Specification)

---

## Pre-Phase Fixes (from Phase 1 review)

Before starting new modules, address these Phase 1 review items that directly affect Phase 2:

1. **ServiceInput support in runtime** — PipelineRuntime must detect ServiceInput plugins and call `start(acc)` instead of running a gather loop. This is a prerequisite for OPC-UA and MQTT.
2. **`metric_batch_size` in output flush** (R3) — Split large batches before calling `write()`. Needed when real outputs have payload limits.

---

## Module Dependency Order

```
2.0  Runtime: ServiceInput support     ← prerequisite for 2.2 and 2.3
2.1  Modbus TCP input                  ← polling Input, no runtime changes needed
2.1i Integration: Modbus → pipeline
2.2  OPC-UA input                      ← ServiceInput, largest module
2.2i Integration: OPC-UA → pipeline
2.3  MQTT consumer input               ← ServiceInput
2.3i Integration: MQTT → pipeline
2.4  Internal metrics input            ← polling Input, self-metrics
2.4i Integration: internal → pipeline
```

**Build order rationale:**
- ServiceInput runtime support first — OPC-UA and MQTT both need it
- Modbus TCP before OPC-UA — simpler protocol, validates the polling input pattern with a real library
- OPC-UA is the largest piece — needs the most time and attention
- MQTT consumer after OPC-UA — simpler ServiceInput, validates the pattern
- Internal metrics last — depends on understanding what metrics to expose from the other inputs

---

## Module 2.0: ServiceInput Runtime Support

**PRD:** §4, §6, §8

### What to Build
- Extend `PipelineRuntime` to detect `ServiceInput` plugins (duck-type check: has `start` and `stop` methods)
- For ServiceInput: call `start(acc)` during pipeline startup instead of creating a gather loop
- For ServiceInput: call `stop()` during shutdown before closing channels
- Startup ordering: connect outputs → start service inputs → start gather loops (service inputs may emit immediately)
- Shutdown ordering: stop service inputs → abort gather loops → drain channels → close outputs

### What to Change
- `src/pipeline/runtime.ts` — add ServiceInput detection and lifecycle
- `src/core/plugin-types.ts` — add a type guard `isServiceInput()`

### Key Constraints
- ServiceInput `start()` receives an Accumulator and pushes metrics asynchronously (no Ticker)
- ServiceInput `stop()` must be called before channel close (so final metrics can be sent)
- A single pipeline can mix polling inputs and service inputs
- ServiceInput errors should not crash the pipeline — log and continue

### Tests
- ServiceInput `start()` called during pipeline startup, metrics flow to output
- ServiceInput `stop()` called during shutdown
- Mixed pipeline: 1 polling input + 1 service input, both produce metrics in output
- ServiceInput error in `start()`: logged, pipeline continues with other inputs
- ServiceInput pushes metrics asynchronously (not on ticker schedule)

---

## Module 2.1: Modbus TCP Input

**PRD:** §6 (Modbus config schema + exception handling), §19

### What to Build
- `src/plugins/inputs/modbus.ts`
- Polling `Input` implementation using `modbus-serial` library
- Connection management (connect on init, reconnect on failure)
- Register reading: FC01 (coils), FC02 (discrete inputs), FC03 (holding), FC04 (input registers)
- Multi-register data types: uint16, int16, uint32, int32, float32, bool
- Byte order decoding: ABCD, CDAB, BADC, DCBA (plugin-level default + per-register override)
- Scaling: `output = raw * scale + offset`
- Bit extraction: extract single bit (0-15) from register as boolean
- Batch reads: combine contiguous registers into single request (optimization = "batch")
- Gap handling: split batches when gap > max_gap
- Shared connection mode: `setID()` to switch slave on single TCP connection
- Modbus exception handling: per-exception behaviour from PRD §6 table
- Config validation via Zod schema matching PRD

### Key Constraints
- **READ ONLY** — FC01-04 only. No write function codes. Ever.
- Batch reads: max 125 registers per FC03 request (Modbus spec limit)
- Byte order affects multi-register types only (uint32, int32, float32), not uint16/int16/bool
- `connection_mode = "shared"`: serialise requests (one at a time) to avoid interleaving
- Error per-register: one bad register doesn't stop polling others
- Timeout from config (duration string, e.g., "5s")

### Tests (using mock Modbus server or stub)
- Read single holding register (FC03) → correct value
- Read coil (FC01) → boolean
- Read discrete input (FC02) → boolean
- Read input register (FC04) → correct value
- Multi-register float32 with each byte order (ABCD, CDAB, BADC, DCBA)
- Scaling: raw 8550, scale=0.01, offset=0 → 85.50
- Bit extraction: register value 0xFF00, bit=8 → true, bit=0 → false
- Batch read: 3 contiguous registers in one request
- Gap split: registers at 100 and 200 with max_gap=10 → 2 separate requests
- Shared mode: 2 slave IDs on same connection, both read correctly
- Connection timeout → error logged, gather returns without crash
- Modbus exception code 02 (Illegal Data Address) → register disabled, others continue
- Modbus exception code 04 (Slave Device Failure) → retry next interval
- Reconnection after connection drop
- Config validation: invalid controller address, slave_id out of range

---

## Module 2.2: OPC-UA Input

**PRD:** Appendix D (full specification)

### What to Build
- `src/plugins/inputs/opcua.ts`
- `ServiceInput` implementation using `node-opcua` library
- Connection lifecycle: connect → secure channel → session → subscription (D.2)
- Security auto-negotiation: try policies in fallback order (D.1)
- Client certificate: generate on first run if not present, persist (D.4 Step 1)
- Server certificate trust: TOFU with change detection (D.4 Step 4)
- Monitored items: create from `nodes` and `groups` config
- Data type mapping: 22+ OPC-UA types → FieldValue (D.3)
- Quality mapping: StatusCode → quality tag (good/uncertain/bad) (D.3)
- Subscription parameters: publishing_interval, queue_size, lifetime_count, max_keep_alive_count
- Data change filter: trigger type, deadband (absolute/percent/none) (D.1)
- Timestamp source: source/server/gather (D.1)
- Reconnection with exponential backoff (D.1, D.2)
- Subscription transfer on reconnect (D.2 step 3-5)
- Browse mode: discover address space, write TOML snippet (D.5)
- Node groups: expand groups into flat node list with inherited defaults
- Namespace URI resolution: `nsu=` format to `ns=` index at connect time
- Error handling: per-condition behaviour from D.7 table

### Key Constraints
- This is the largest single module in the entire project
- `node-opcua` is pure JS in v4.x (validated in Bun spike)
- Certificate operations: generate self-signed 2048-bit RSA, 10-year validity
- TOFU store: persist server cert fingerprints (can use a simple JSON file or the config store for MVP)
- Browse mode is expensive — rate-limit to 10 requests/second, support cancellation
- Bad-quality data is STILL EMITTED (not dropped) — consumer decides
- Array types → multiple fields: `name[0]`, `name[1]`, plus `name.length`
- ExtensionObject → flattened with dot notation, max depth 3
- Int64/UInt64 → number with warning if > Number.MAX_SAFE_INTEGER

### Tests
- Connect to mock OPC-UA server, read single node → correct metric
- Subscription: register monitored item, receive data change notification → metric emitted
- Data type mapping: Boolean, Int32, Float, Double, String, DateTime → correct FieldValue types
- Quality mapping: Good → "good" tag, Bad → "bad" tag, value still emitted
- Timestamp source=source: metric uses OPC-UA source timestamp
- Timestamp source=gather: metric uses local timestamp
- Reconnection: simulate disconnect → reconnect → subscription recreated
- Node groups: group config expanded into individual monitored items with inherited tags
- Certificate generation: no cert → generates and persists
- TOFU: first connect stores fingerprint, changed cert → rejection
- Browse: discovers nodes, writes TOML output file
- Auth: anonymous, username/password
- Security policy auto-negotiation
- Error: bad NodeID → error logged, other nodes continue
- Error: connection refused → retry with backoff, no crash
- Error: auth failure → clear error, no retry (config error)
- Deadband filter: absolute deadband suppresses small changes

---

## Module 2.3: MQTT Consumer Input

**PRD:** §6, §19

### What to Build
- `src/plugins/inputs/mqtt-consumer.ts`
- `ServiceInput` implementation using MQTT.js or similar
- Subscribe to configurable topics (with wildcards)
- Payload parsing: JSON (object → fields), plain string (single field), Sparkplug B (protobuf)
- Topic-to-tag mapping: extract tag values from topic segments
- QoS support (0, 1, 2)
- Connection management: auto-reconnect with backoff
- TLS support
- Auth: username/password, client certificate

### Key Constraints
- ServiceInput pattern: `start(acc)` subscribes and pushes metrics on message arrival
- Topic wildcards: MQTT `+` and `#` must work
- JSON payload: flat object → one metric with all fields; nested → dot-notation flattening
- Sparkplug B: decode protobuf, map metrics array to individual metrics
- Message ordering: process in arrival order (don't parallelise message handling)

### Config Schema
```typescript
const MqttConsumerConfigSchema = z.object({
  servers: z.array(z.string()).describe('MQTT broker URLs (mqtt://host:1883)'),
  topics: z.array(z.string()).describe('Topics to subscribe (wildcards ok)'),
  qos: z.number().int().min(0).max(2).default(1),
  client_id: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  tls: z.object({
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
    insecure: z.boolean().default(false),
  }).optional(),
  payload_format: z.enum(['json', 'string', 'sparkplug_b']).default('json'),
  topic_tag: z.string().optional().describe('Extract topic as tag with this key'),
  // Topic parsing: /factory/{site}/line/{line}/machine/{machine}
  topic_tags: z.record(z.number().int()).optional()
    .describe('Map topic segment indices to tag names'),
  measurement: z.string().optional()
    .describe('Override measurement name (default: topic)'),
  reconnect: z.object({
    initial_delay: z.string().default('1s'),
    max_delay: z.string().default('30s'),
  }).default({}),
});
```

### Tests
- Connect to mock MQTT broker, subscribe, receive JSON message → metric
- JSON payload with multiple fields → single metric with all fields
- Topic tag extraction: topic "factory/A/line/1" with topic_tags → correct tags
- Wildcard subscription: subscribe to "sensors/#" → receives from sub-topics
- QoS 1: message acknowledged
- Reconnection: broker disconnect → auto-reconnect → resubscribe
- Plain string payload → single "value" field
- Sparkplug B payload → decoded metrics (if implementing in MVP)
- Connection failure → retry with backoff, no crash
- Multiple topics: subscribe to 3 topics, metrics from all arrive

---

## Module 2.4: Internal Metrics Input

**PRD:** §15 (Observability), §19

### What to Build
- `src/plugins/inputs/internal.ts`
- Polling `Input` implementation (runs on agent interval)
- Emits `collatr.` prefixed metrics about agent health:
  - `collatr.agent.uptime` — seconds since start
  - `collatr.agent.metrics_gathered` — total metrics from inputs
  - `collatr.agent.metrics_written` — total metrics to outputs
  - `collatr.agent.metrics_dropped` — total dropped (channel overflow)
  - `collatr.agent.gather_errors` — total gather errors
  - `collatr.agent.write_errors` — total write errors
  - `collatr.agent.memory_usage` — RSS in bytes (from `process.memoryUsage()`)
  - `collatr.agent.cpu_usage` — CPU % (from `process.cpuUsage()`)
- Per-input metrics: `collatr.input.gather_time` (ms), `collatr.input.metrics_count`
- Per-output metrics: `collatr.output.write_time` (ms), `collatr.output.buffer_size`

### Key Constraints
- Must not create circular dependencies (internal metrics go through the pipeline like any other metric)
- Stats counters need to be collected from the pipeline runtime — need a stats interface or shared counter object
- Memory/CPU from Bun built-ins
- Tags: `input` tag for per-input metrics, `output` tag for per-output metrics

### Tests
- Internal input produces `collatr.agent.uptime` metric with positive value
- Memory usage metric is a positive number (bytes)
- Per-input gather_time is non-negative
- Metrics flow through normal pipeline (processed, output'd like any other metric)
- Tags present: `agent` tag identifying the CollatrEdge instance

---

## Phase 2 Acceptance Criteria

Phase 2 is complete when:

1. ✅ Modbus TCP input reads registers from a mock/stub server
2. ✅ OPC-UA input receives subscriptions from a mock server
3. ✅ MQTT consumer receives messages from a mock broker
4. ✅ Internal metrics emits agent health metrics
5. ✅ ServiceInput lifecycle works (start/stop/async push)
6. ✅ Mixed pipeline: polling + service inputs coexist
7. ✅ All input configs validate via Zod
8. ✅ Error handling: connection loss → reconnect with backoff, no crash
9. ✅ All tests pass: `bun test`
10. ✅ Sub-agent code review completed and findings addressed

---

## Risks

| Risk | Mitigation |
|------|-----------|
| OPC-UA complexity (largest module) | Build incrementally: connect → read → subscribe → reconnect → certs → browse. Each step tested before next. |
| Mock OPC-UA server setup | Use `node-opcua` server module for test fixtures — validated in Bun spike |
| MQTT library Bun compatibility | Test MQTT.js import + connect before starting module. Fallback: raw TCP with MQTT protocol |
| Internal metrics circular dependency | Internal input only reads counters, never writes to pipeline channels directly |
| Test isolation (real TCP connections in tests) | Use localhost servers in test fixtures, random ports, cleanup in afterEach |
