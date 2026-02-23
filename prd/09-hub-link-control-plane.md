## 9. Hub Link & Control Plane

### Architecture

The Hub link is a **built-in runtime component** (not a plugin) that implements a Sparkplug B edge node session. It manages:

- MQTT connection to Hub broker
- Birth/death certificates (NBIRTH, NDEATH, DBIRTH, DDEATH)
- Sequence numbering
- Control plane (NCMD handling)
- Data plane (DDATA publishing, shared with MQTT output plugin when targeting same broker)

### Sparkplug B Topic Structure

```
spBv1.0/{group_id}/NBIRTH/{edge_node_id}              → Edge online + capabilities
spBv1.0/{group_id}/NDEATH/{edge_node_id}              → Edge offline (Will Message)
spBv1.0/{group_id}/NDATA/{edge_node_id}               → Edge self-metrics
spBv1.0/{group_id}/NCMD/{edge_node_id}                → Hub commands to edge
spBv1.0/{group_id}/DBIRTH/{edge_node_id}/{device_id}  → Device discovered
spBv1.0/{group_id}/DDEATH/{edge_node_id}/{device_id}  → Device lost
spBv1.0/{group_id}/DDATA/{edge_node_id}/{device_id}   → Device telemetry
spBv1.0/{group_id}/DCMD/{edge_node_id}/{device_id}    → Hub commands to device
```

### Device ID Mapping

Each input plugin instance maps to exactly one Sparkplug B device:

| Concept | Value | Example |
|---------|-------|---------|
| `group_id` | From `[agent.hub]` config | `plant_floor` |
| `edge_node_id` | From `[agent.hub]` config | `edge-line-3` |
| `device_id` | **Plugin alias** (from `alias = "..."` in config) | `wrapper_plc` |

**Rules:**
- One input plugin instance = one Sparkplug device. A Modbus plugin collecting from one PLC is one device.
- Plugin aliases must be globally unique (validated at startup) — this ensures unique device IDs.
- If no alias is set, the device_id is auto-generated as `{plugin_type}_{index}` (e.g., `modbus_0`). Explicit aliases are strongly recommended.
- Metrics from that input use the device_id in DBIRTH/DDATA topics.
- Internal agent metrics use NDATA (node-level), not DDATA — they have no device_id.

### Sparkplug B Metric Aliases

Metric aliases are deterministic across restarts to avoid unnecessary DBIRTH re-processing by Hub:

```
alias = FNV-1a_hash(device_id + "/" + metric_name) mod 2^31
```

- 32-bit unsigned integers per Sparkplug B spec
- Consistent aliases across restarts without state persistence
- Collision probability is negligible (~1 in 2 billion per device); on collision, increment until unique
- DBIRTH carries both the full metric name and alias; DDATA uses alias only

### Sparkplug B Data Type Mapping

CollatrEdge's `FieldValue` types map to Sparkplug B metric types:

| FieldValue Type | Sparkplug B Type | Notes |
|----------------|-----------------|-------|
| `number` (integer, ≤32 bit) | `Int32` | Default for integer values |
| `number` (integer, >32 bit) | `Int64` | When value exceeds Int32 range |
| `number` (float) | `Double` | All floating-point → Double (no Float32 distinction in JS) |
| `boolean` | `Boolean` | Direct mapping |
| `string` | `String` | Direct mapping |
| `bigint` | `Int64` | Direct mapping |

**Limitation:** JavaScript's `number` type cannot distinguish Int16 vs Int32, or Float vs Double. All integers map to Int32/Int64 (based on range), all floats map to Double. Consumers that need specific Sparkplug types can use the metric's `properties` in DBIRTH for type hints.

### Sequence Numbers (seq / bdSeq)

- **bdSeq** (birth/death sequence): Incremented on each NBIRTH. Starts at 0, wraps at 255. Stored in plugin state (SQLite) so it persists across restarts. The NDEATH will message carries the same bdSeq as the corresponding NBIRTH, allowing Hub to correlate births and deaths.
- **seq** (message sequence): Per-message counter, 0-255, reset to 0 on each NBIRTH. Incremented for every NDATA/DDATA/DBIRTH/DDEATH message. Hub uses gaps in seq to detect missed messages and request rebirth.
- **Crash recovery**: On startup after unclean shutdown, read last bdSeq from plugin state, increment, publish NBIRTH. If state is lost (corrupt DB), start bdSeq at 0 — Hub will detect the discontinuity and request rebirth.

### ISA-95 Alignment

| Sparkplug B Concept | ISA-95 Concept |
|---------------------|----------------|
| `group_id` | Site / Area |
| `edge_node_id` | Work Centre / Equipment |
| `device_id` | Work Unit / Sub-equipment |
| NCMD/DCMD | Command transaction pattern |
| NDATA/DDATA | Show transaction pattern |
| Topic hierarchy | Equipment hierarchy |

### Single MQTT Connection

One TCP connection carries both control and data traffic. MQTT is multiplexed — Sparkplug message types (NCMD vs DDATA) differentiate the channels. When an MQTT output plugin targets the same Hub broker, it publishes DDATA through the Hub link's session rather than opening a separate connection.

### Control Plane Operations

| Operation | Mechanism | Flow |
|-----------|-----------|------|
| **Config push** | NCMD with `Node Control/Config` metric | Hub → Edge: new config. Edge validates, applies, responds via NDATA with ACK (success/failure + details). |
| **Rebirth request** | NCMD with `Node Control/Rebirth = true` | Hub → Edge: resync. Edge re-publishes NBIRTH + all DBIRTHs. Used when Hub detects sequence gaps. |
| **Status heartbeat** | NDATA with agent self-metrics | Edge → Hub: periodic health, buffer levels, pipeline state, config version. |
| **Device discovery** | DBIRTH on input plugin start | Edge → Hub: automatic. New input connects to a device → DBIRTH with full metric structure. Hub knows immediately. |
| **Device loss** | DDEATH on input plugin stop/failure | Edge → Hub: automatic. Input disconnects or fails → DDEATH. |
| **Edge death** | NDEATH (Will Message, published by broker) | Broker → Hub: automatic on ungraceful disconnect. Hub marks all metrics STALE. |

### Configuration

```toml
[agent.hub]
  enabled = true
  group_id = "plant_floor"
  edge_node_id = "${DEVICE_ID}"
  broker = "mqtts://hub.collatr.com:8883"
  tls_cert = "@{secrets:hub_cert}"
  tls_key = "@{secrets:hub_key}"
  heartbeat_interval = "30s"
```
