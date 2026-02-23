## Appendix D: OPC-UA Input Plugin Specification

> **Library:** `node-opcua` (MIT licence, ~30MB, optional native C++ addons)
> **Bun compatibility:** MUST be validated in Week 1 Bun spike. If `bun compile` fails with node-opcua's native addons, fallback options: pure-JS mode (slower), subprocess isolation, or runtime switch to Node.js for OPC-UA only.
> **Plugin type:** `ServiceInput` — uses subscriptions (server-push), not polling.

### D.1 Config Schema

```typescript
const OpcuaConfigSchema = z.object({
  // ── Connection ──────────────────────────────────────────────────────
  endpoint: z.string()
    .describe('OPC-UA server endpoint (e.g., opc.tcp://192.168.1.50:4840)'),
  connect_timeout: z.string().default('10s'),
  request_timeout: z.string().default('5s'),
  session_timeout: z.string().default('30m'),

  // ── Security ────────────────────────────────────────────────────────
  // Security policy determines encryption algorithm.
  // "auto" probes the server's endpoints and selects the highest available.
  // Fallback order when auto-negotiation fails (some servers advertise
  // policies they don't actually support):
  //   1. Basic256Sha256 + SignAndEncrypt (recommended, widest support)
  //   2. Aes128_Sha256_RsaOaep + SignAndEncrypt
  //   3. Aes256_Sha256_RsaPss + SignAndEncrypt
  //   4. Basic256Sha256 + Sign
  //   5. None + None (last resort, logged as warning)
  // If "auto" fails after trying all policies, log a clear error suggesting
  // the user set security_policy and security_mode explicitly.
  security_policy: z.enum([
    'None', 'Basic256Sha256', 'Aes128_Sha256_RsaOaep',
    'Aes256_Sha256_RsaPss', 'auto'
  ]).default('auto'),
  // Security mode determines whether messages are signed, encrypted, or both.
  security_mode: z.enum(['None', 'Sign', 'SignAndEncrypt', 'auto']).default('auto'),

  // ── Client Certificate ──────────────────────────────────────────────
  // If both paths are set and files exist, they are used as-is (production).
  // If both paths are set but files don't exist, a self-signed certificate
  // is generated and persisted at those paths (first-run convenience).
  // If neither is set, a temporary self-signed cert is created in memory
  // (testing only — server must re-trust on every restart).
  certificate: z.string().optional()
    .describe('Path to client certificate (PEM or DER)'),
  private_key: z.string().optional()
    .describe('Path to client private key (PEM)'),

  // ── Server Certificate Trust ────────────────────────────────────────
  // Explicitly trusted server certificate. If not set, the plugin uses
  // trust-on-first-use (TOFU): accepts and persists the server cert on
  // first connection, rejects if it changes subsequently.
  // See §D.4 Certificate Trust Workflow.
  server_certificate: z.string().optional()
    .describe('Path to explicitly trusted server certificate (PEM or DER)'),

  // ── Authentication ──────────────────────────────────────────────────
  auth_method: z.enum(['anonymous', 'username', 'certificate']).default('anonymous'),
  username: z.string().optional(),
  password: z.string().optional()
    .describe('Plaintext or secret ref: @{secrets:opc_password}'),

  // ── Subscription Parameters ─────────────────────────────────────────
  // These control server-side behaviour. Getting them wrong means either
  // excessive network traffic or missed data changes.
  subscription: z.object({
    // How often the server bundles and sends notifications (ms).
    // Lower = more responsive but more network traffic.
    // Most PLCs: 500-1000ms is the sweet spot.
    publishing_interval: z.string().default('1s'),

    // Server-side queue depth per monitored item. If the server detects
    // more changes than this between publishing intervals, it discards.
    queue_size: z.number().int().min(1).default(10),

    // Keep-alive: how many publishing intervals with no data changes
    // before the server sends an empty keep-alive. Used to detect
    // connection loss.
    max_keep_alive_count: z.number().int().min(1).default(10),

    // Lifetime: how many publishing intervals the subscription survives
    // without successful communication. After this, the server drops it.
    // Default 1000 = ~16 minutes at 1s publishing interval.
    // Lower values (100) risk subscription expiry during brief network
    // partitions, forcing full recreation instead of transfer on reconnect.
    lifetime_count: z.number().int().min(3).default(1000),

    // Max notifications per publish response. Limits burst size after
    // a period of many changes.
    max_notifications_per_publish: z.number().int().min(0).default(100),
  }).default({}),

  // ── Data Change Filter ──────────────────────────────────────────────
  // Controls WHEN the server sends updates. Applied to all monitored items
  // unless overridden per-node.
  data_change_filter: z.object({
    // What triggers a notification:
    //   "status"              — only on status change (rare)
    //   "status_value"        — on status or value change (default, recommended)
    //   "status_value_timestamp" — on any change including source timestamp
    trigger: z.enum(['status', 'status_value', 'status_value_timestamp'])
      .default('status_value'),

    // Deadband: suppress notifications when value changes are smaller than
    // this threshold. Reduces noise for analog signals.
    //   "none"     — report every change
    //   "absolute" — suppress if |new - old| < deadband_value
    //   "percent"  — suppress if |new - old| < (deadband_value% of EU range)
    //
    // ⚠️ Percent deadband requires the server to provide EU (Engineering Unit)
    // ranges for monitored variables. Many embedded OPC-UA servers (e.g.,
    // Siemens S7-1500) do NOT provide EU ranges. If percent is requested but
    // the server doesn't support it, CollatrEdge falls back to "none" and
    // logs a warning once: "Percent deadband not supported by server, using none."
    // Recommendation: use "absolute" for most deployments.
    deadband_type: z.enum(['none', 'absolute', 'percent']).default('none'),
    deadband_value: z.number().default(0),
  }).default({}),

  // ── Timestamp Source ────────────────────────────────────────────────
  // OPC-UA provides both server and source timestamps.
  //   "source" — timestamp from the device/PLC (most accurate for process data)
  //   "server" — timestamp from the OPC-UA server
  //   "gather" — timestamp from CollatrEdge when it receives the notification
  timestamp: z.enum(['source', 'server', 'gather']).default('source'),

  // ── Reconnection ───────────────────────────────────────────────────
  reconnect: z.object({
    initial_delay: z.string().default('1s'),
    max_delay: z.string().default('30s'),
    max_retry: z.number().int().min(0).default(0)
      .describe('0 = retry forever'),
  }).default({}),

  // ── Browse (optional) ──────────────────────────────────────────────
  // If enabled, browse the server's address space on startup to discover
  // nodes. Expensive on large servers (S7-1500 with 50,000+ tags).
  // Use for initial setup / config generation, not production.
  browse: z.object({
    enabled: z.boolean().default(false),
    root_node_id: z.string().default('ns=0;i=85')
      .describe('ObjectsFolder by default'),
    max_depth: z.number().int().min(1).default(5),
    // Filter by node class: Variable (tag values), Object (containers)
    node_classes: z.array(z.enum(['Variable', 'Object'])).default(['Variable']),
    // Write discovered nodes to a file for use as explicit config.
    // Operator reviews, picks what they want, pastes into config.
    output_file: z.string().optional()
      .describe('Path to write discovered nodes as TOML snippet'),
  }).default({}),

  // ── Nodes to Monitor ──────────────────────────────────────────────
  // Explicit NodeIDs — the primary configuration method.
  // Browse is a convenience tool; production configs should use explicit nodes.
  nodes: z.array(z.object({
    // OPC-UA NodeID string. All four formats supported:
    //   "ns=2;s=Channel1.Device1.Tag1"  (string identifier)
    //   "ns=2;i=1001"                    (numeric identifier)
    //   "ns=2;g=..." (GUID), "ns=2;b=..." (opaque/byte string)
    //
    // ⚠️ NAMESPACE INDEX WARNING: The namespace index (ns=X) can CHANGE
    // if the OPC-UA server configuration is modified or the server is
    // updated. For production deployments, prefer namespace URI format:
    //   "nsu=http://mycompany.com/UA;s=Temperature"
    // The nsu= format uses the stable namespace URI instead of the
    // volatile index. CollatrEdge resolves the URI to an index at
    // connect time by reading the server's namespace array.
    // If you must use ns= format, verify the index after any server
    // configuration change.
    node_id: z.string(),

    // Field name in the output metric. If not set, derived from the
    // OPC-UA BrowseName (which can be ugly: "Channel1.Device1.Tag1").
    name: z.string(),

    // Sampling interval for this specific node (overrides subscription
    // publishing_interval for sampling, not publishing).
    // -1 = use server default, 0 = fastest available.
    sampling_interval: z.string().optional(),

    // Per-node deadband override.
    deadband_type: z.enum(['none', 'absolute', 'percent']).optional(),
    deadband_value: z.number().optional(),

    // Per-node queue size override.
    queue_size: z.number().int().optional(),

    // Additional tags applied to metrics from this node.
    tags: z.record(z.string()).optional(),
  })),

  // ── Node Groups ────────────────────────────────────────────────────
  // Group nodes that share the same defaults (namespace, tags, sampling).
  // Reduces config repetition for large tag lists.
  groups: z.array(z.object({
    name: z.string().describe('Group name (used as measurement name if set)'),
    namespace: z.string().optional()
      .describe('Default namespace for nodes in this group'),
    sampling_interval: z.string().optional(),
    deadband_type: z.enum(['none', 'absolute', 'percent']).optional(),
    deadband_value: z.number().optional(),
    default_tags: z.record(z.string()).optional(),
    nodes: z.array(z.object({
      node_id: z.string(),
      name: z.string(),
      sampling_interval: z.string().optional(),
      deadband_type: z.enum(['none', 'absolute', 'percent']).optional(),
      deadband_value: z.number().optional(),
      queue_size: z.number().int().optional(),
      tags: z.record(z.string()).optional(),
    })),
  })).optional(),
});
```

### D.2 Session Lifecycle

OPC-UA sessions are stateful and long-lived. The plugin manages the full lifecycle:

```
                    ┌──────────┐
                    │  INIT    │ Generate/load client certificate
                    └────┬─────┘
                         │
                    ┌────▼─────┐
             ┌──────│ CONNECT  │ TCP connection to endpoint
             │      └────┬─────┘
             │           │
             │      ┌────▼──────────────┐
             │      │ ENDPOINT DISCOVER │ GetEndpoints → select best
             │      └────┬──────────────┘ matching security policy/mode
             │           │
             │      ┌────▼─────────────┐
             │      │ SECURE CHANNEL   │ OpenSecureChannel with selected
             │      └────┬─────────────┘ security policy
             │           │
             │      ┌────▼─────┐
             │      │ SESSION  │ CreateSession + ActivateSession
             │      └────┬─────┘ (authentication applied here)
             │           │
             │      ┌────▼────────────┐
             │      │ SUBSCRIBE       │ CreateSubscription +
             │      │                 │ CreateMonitoredItems for all nodes
             │      └────┬────────────┘
             │           │
             │      ┌────▼─────┐
             │      │ RUNNING  │ Receive DataChangeNotifications
             │      │          │ via publish requests
             │      └────┬─────┘
             │           │ (connection lost / session expired)
    reconnect│      ┌────▼──────┐
     backoff │      │ RECONNECT │ Exponential backoff
             └──────│           │ Re-establish session + subscriptions
                    └───────────┘
```

**Key behaviours:**

1. **Secure channel renewal**: The OPC-UA secure channel has a lifetime (default: 1 hour). node-opcua handles renewal automatically. The plugin logs renewals at debug level.

2. **Session keep-alive**: The plugin sends periodic read requests to keep the session alive. If the session times out server-side (e.g., network partition longer than `session_timeout`), the plugin detects this and triggers reconnection.

3. **Subscription transfer and recreation**: On reconnection, the plugin follows this sequence:
   1. Re-establish TCP connection and secure channel
   2. Create new session (or attempt session re-activation if session ID is known)
   3. Attempt `TransferSubscriptions` for previous subscription IDs
   4. If transfer succeeds: resume receiving notifications (minimal data gap)
   5. If transfer fails (server doesn't support it, subscriptions expired, or session was lost):
      - Log: `"Subscriptions expired on server, recreating (gap: Xs)"`
      - Create new subscription with original parameters
      - Create new monitored items for all configured nodes
      - Resume data collection
   6. Log the duration of any data gap as a warning
   
   **Note:** Subscriptions expire server-side after `lifetime_count × publishing_interval` without communication. Default: 1000 × 1s = ~16 minutes. Network partitions longer than this will always require subscription recreation, not transfer.

4. **Graceful shutdown**: On `stop()`, the plugin deletes subscriptions, closes the session, and closes the secure channel. This is a clean disconnect — the server frees resources immediately rather than waiting for session timeout.

### D.3 Data Type Mapping

OPC-UA has 22+ built-in data types. The flat `Metric` model uses `FieldValue = number | string | boolean`. Mapping:

| OPC-UA Type | FieldValue Type | Notes |
|-------------|----------------|-------|
| Boolean | `boolean` | Direct |
| SByte, Int16, Int32 | `number` | Direct |
| Byte, UInt16, UInt32 | `number` | Direct |
| Int64, UInt64 | `number` | Loss of precision beyond `Number.MAX_SAFE_INTEGER`. Log warning if value exceeds safe range. Post-MVP: BigInt support in Metric model. |
| Float | `number` | Direct |
| Double | `number` | Direct |
| String | `string` | Direct |
| DateTime | `number` | Converted to Unix epoch milliseconds |
| ByteString | `string` | Base64-encoded |
| Guid | `string` | Standard GUID string format |
| NodeId | `string` | String representation |
| StatusCode | `number` | UInt32 status code value. Additionally stored as tag `quality` with human-readable status (e.g., "Good", "Bad_SensorFailure"). |
| LocalizedText | `string` | `.text` property extracted |
| QualifiedName | `string` | `{ns}:{name}` format |
| Array types | multiple fields | Unpacked: `name[0]`, `name[1]`, etc. Array length stored as `name.length` field. |
| ExtensionObject / Structure | multiple fields | Flattened with dot notation: `name.field1`, `name.field2`. Nested structures: `name.sub.field`. Max depth: 3 levels (configurable). Deeper nesting serialised as JSON string. |

**Quality mapping**: Every OPC-UA value includes a `StatusCode`. This is mapped to a `quality` tag on each metric:
- `0x00000000` (Good) → `quality = "good"`
- `0x40000000` (Uncertain) → `quality = "uncertain"`
- `0x80000000` (Bad) → `quality = "bad"`
- Specific sub-codes logged at debug level (e.g., `Bad_SensorFailure`, `Uncertain_LastUsableValue`)

Bad-quality values are **still emitted** (not silently dropped) — the consumer decides what to do with them. This is critical for compliance and troubleshooting.

### D.4 Certificate Trust Workflow

The #1 deployment blocker for OPC-UA in practice. Every OPC-UA server has its own trust store, and they're all in different places:

| Server | Trust Store Location |
|--------|---------------------|
| Kepware | Configuration → OPC UA → Trusted Clients |
| Siemens S7-1500 | TIA Portal → OPC UA Server Settings → Trusted Clients |
| Ignition | Gateway → Config → OPC UA → Security → Trusted Certificates |
| Prosys | Certificate Management tab → Trusted |
| Unified Automation | Admin dialogue → Certificate Trust List |
| open62541 | File system: `pki/trusted/certs/` |

**CollatrEdge certificate workflow:**

#### Step 1: Client Certificate Generation (first run)

```
collatr-edge run
  → No certificate at configured path?
    → Generate self-signed certificate (2048-bit RSA, 10-year validity)
    → Save to configured paths (default: /etc/collatr-edge/certs/)
    → Log: "Generated OPC-UA client certificate: /etc/collatr-edge/certs/client.pem"
    → Log: "Certificate thumbprint: AB:CD:EF:12:..."
```

The certificate persists across restarts. It is never regenerated unless the operator deletes it.

#### Step 2: Server Rejects Client (expected on first connection)

```
collatr-edge connects to OPC-UA server
  → Server rejects: BadCertificateUntrusted
  → Plugin logs clearly:
    "OPC-UA server rejected our client certificate.
     To fix: add our certificate to the server's trusted client store.
     
     Our certificate: /etc/collatr-edge/certs/client.pem
     Thumbprint:      AB:CD:EF:12:34:56:78:90:...
     
     Common server trust store locations:
       Kepware:   Configuration → OPC UA → Trusted Clients
       Siemens:   TIA Portal → OPC UA Server → Trusted Clients  
       Ignition:  Gateway → Config → OPC UA → Security → Trusted
     
     After adding the certificate, restart CollatrEdge or wait
     for automatic reconnection."
```

#### Step 3: Web UI Certificate Helper

The Web UI provides a certificate management page:

- **Download client certificate** — one-click download of the `.der` or `.pem` file
- **View certificate details** — thumbprint, validity, subject
- **Connection status** — shows whether the server accepted or rejected the certificate, with the specific error
- **Server certificate** — shows the server's certificate details (received during endpoint discovery, even if the connection was rejected)
- **Trust server certificate** — button to explicitly trust the server's certificate (writes to local trust store). Shows fingerprint for manual verification.

#### Step 4: Server Certificate Trust (TOFU)

CollatrEdge uses **Trust-On-First-Use** by default:

1. First connection: server presents its certificate
2. Plugin stores the certificate fingerprint in the local trust store (SQLite)
3. Subsequent connections: if the server's certificate fingerprint changes, the connection is **rejected** with a clear warning:

```
"OPC-UA server certificate has CHANGED since first connection.
 This could indicate a server reconfiguration or a security issue.
 
 Expected thumbprint: AB:CD:EF:12:...
 Received thumbprint: 99:88:77:66:...
 
 To accept the new certificate:
   collatr-edge cert trust --endpoint opc.tcp://192.168.1.50:4840
 Or via Web UI: Settings → Certificates → Trust"
```

For production environments, operators can set `server_certificate` in config to pin a specific server certificate and disable TOFU entirely.

### D.5 Browse Mode

Browse mode discovers the server's address space — useful for initial setup but expensive on large servers.

**Workflow:**

1. Operator enables `browse.enabled = true` and runs CollatrEdge
2. Plugin connects, browses from `root_node_id` to `max_depth`
3. Discovered Variable nodes are written to `browse.output_file` as a TOML snippet:

```toml
# Discovered OPC-UA nodes from opc.tcp://192.168.1.50:4840
# Generated 2026-02-23T14:30:00Z — 47 nodes found
# Review and copy desired nodes into your config file.

# [[inputs.opcua.nodes]]
#   node_id = "ns=2;s=Channel1.Device1.Temperature"
#   name = "temperature"
#   # OPC-UA DataType: Double, Current value: 23.5

# [[inputs.opcua.nodes]]
#   node_id = "ns=2;s=Channel1.Device1.MotorSpeed"
#   name = "motor_speed"
#   # OPC-UA DataType: Float, Current value: 1485.0

# [[inputs.opcua.nodes]]
#   node_id = "ns=2;s=Channel1.Device1.Running"
#   name = "running"
#   # OPC-UA DataType: Boolean, Current value: true
```

4. Operator reviews, uncomments desired nodes, pastes into config
5. Operator disables browse mode for production

**Web UI browse**: The Web UI also provides a tree-view browser (read-only). This is a convenience for integrators who prefer a visual tool over TOML editing. The tree loads lazily (browse-on-expand) to handle large servers.

**Performance guard**: Browse requests are rate-limited (max 10 browse requests per second) to avoid overloading the OPC-UA server. A progress indicator shows browse status. Browse can be cancelled mid-operation.

### D.6 TOML Config Example

```toml
[[inputs.opcua]]
  alias = "siemens_line3"
  endpoint = "opc.tcp://192.168.10.50:4840"

  # Security — "auto" selects the best available
  security_policy = "auto"
  security_mode = "auto"
  auth_method = "username"
  username = "collatr"
  password = "@{secrets:opc_password}"

  # Client certificate — generated on first run if not present
  certificate = "/etc/collatr-edge/certs/opcua-client.pem"
  private_key = "/etc/collatr-edge/certs/opcua-client-key.pem"

  # Use source timestamps from the PLC
  timestamp = "source"

  connect_timeout = "10s"
  request_timeout = "5s"
  session_timeout = "30m"

  # Subscription: 1s publishing interval, queue depth 10
  [inputs.opcua.subscription]
    publishing_interval = "1s"
    queue_size = 10
    lifetime_count = 1000
    max_keep_alive_count = 10

  # Deadband: suppress noise on analog signals
  [inputs.opcua.data_change_filter]
    trigger = "status_value"
    deadband_type = "absolute"
    deadband_value = 0.5

  # Reconnection: retry forever with exponential backoff
  [inputs.opcua.reconnect]
    initial_delay = "1s"
    max_delay = "30s"
    max_retry = 0

  # Individual nodes
  [[inputs.opcua.nodes]]
    node_id = "ns=2;s=Line3.Motor1.Speed"
    name = "motor_speed"
  [[inputs.opcua.nodes]]
    node_id = "ns=2;s=Line3.Motor1.Current"
    name = "motor_current"
    deadband_type = "absolute"
    deadband_value = 0.1
  [[inputs.opcua.nodes]]
    node_id = "ns=2;s=Line3.Oven.Temperature"
    name = "oven_temp"
  [[inputs.opcua.nodes]]
    node_id = "ns=2;s=Line3.Oven.Setpoint"
    name = "oven_setpoint"
  [[inputs.opcua.nodes]]
    node_id = "ns=2;s=Line3.Counter.GoodParts"
    name = "good_parts"
    [inputs.opcua.nodes.tags]
      unit = "count"

  # Node groups — reduce repetition
  [[inputs.opcua.groups]]
    name = "conveyor_drives"
    sampling_interval = "500ms"
    [inputs.opcua.groups.default_tags]
      subsystem = "conveyor"
    [[inputs.opcua.groups.nodes]]
      node_id = "ns=2;s=Line3.Conv1.Speed"
      name = "conv1_speed"
    [[inputs.opcua.groups.nodes]]
      node_id = "ns=2;s=Line3.Conv2.Speed"
      name = "conv2_speed"
    [[inputs.opcua.groups.nodes]]
      node_id = "ns=2;s=Line3.Conv3.Speed"
      name = "conv3_speed"
```

### D.7 Error Handling

| Condition | Behaviour | Log Level |
|-----------|-----------|-----------|
| Connection refused | Retry with backoff | WARN |
| Certificate rejected | Log clear instructions (§D.4), retry | ERROR |
| Session timeout | Reconnect, attempt subscription transfer | WARN |
| Monitored item error (bad NodeID) | Skip item, log, continue with remaining nodes | ERROR |
| Bad quality data | Emit metric with `quality` tag, do not drop | DEBUG |
| Server shutdown (GoodShutdown) | Reconnect with backoff | INFO |
| Secure channel renewal failure | Close and re-establish from scratch | WARN |
| Browse timeout | Cancel browse, log partial results | WARN |
| Authentication failure | Log clearly, do not retry (config error) | ERROR |
| Data type not mappable | Emit as JSON string, log warning once | WARN |

### D.8 Bun Compatibility Risk

`node-opcua` is the only mature OPC-UA library for the Node.js ecosystem. It has:

- **Optional native C++ addons** for crypto acceleration (OpenSSL bindings)
- **~30MB footprint** (largest single dependency in CollatrEdge)
- **Complex module structure** with ~50 sub-packages

**Risks for `bun compile`:**

1. Native addons may not compile or link correctly in the Bun single-binary output
2. `node-opcua`'s dynamic `require()` patterns may not be statically analysable
3. ARM64 cross-compilation from x64 CI with native addons is untested

**Week 1 Bun spike must validate:**

```bash
# Minimal test: create OPC-UA client, connect to prosys demo server,
# read a single node, subscribe to a single node, receive 5 notifications.
# Test on both x64 and arm64 (Pi 4).

bun compile --target=bun-linux-x64 ./opcua-spike.ts
bun compile --target=bun-linux-arm64 ./opcua-spike.ts
```

**Fallback options (in preference order):**

1. **Pure-JS mode**: node-opcua can run without native addons (slower crypto). Test performance impact.
2. **Subprocess isolation**: Run OPC-UA in a separate Node.js process, communicate via IPC/stdio. CollatrEdge binary stays Bun-compiled; OPC-UA runs in bundled Node.js. Adds ~50MB to distribution.
3. **Alternative library**: `open62541` has WASM builds. Less mature in JS ecosystem but no native addon dependency.
4. **Runtime switch**: Ship with Node.js runtime for OPC-UA-enabled deployments. Defeats the single-binary goal.

---

*End of document.*
