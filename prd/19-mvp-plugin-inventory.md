## 19. MVP Plugin Inventory

### Inputs

| Plugin | Protocol | Priority | Notes |
|--------|----------|----------|-------|
| `modbus` | Modbus TCP (RTU post-MVP) | P0 | Core IIoT protocol. Registers, coils, discrete inputs. **Read-only** (FC01-04 only; write FCs not implemented). Configurable byte order (ABCD/CDAB/BADC/DCBA), scaling/offset, bit extraction, batch reads. |
| `opcua` | OPC-UA | P0 | Core IIoT protocol. Subscription-based (`ServiceInput`). Full spec in Appendix D: security (auto-negotiate policy/mode), certificate trust (TOFU + explicit pin), browse + explicit NodeIDs, subscriptions with deadband, data type mapping (22+ types → Metric), reconnection with subscription transfer. Library: `node-opcua`. |
| `mqtt_consumer` | MQTT | P0 | Subscribe to MQTT topics. Supports JSON, plain value, string, and auto-detect payload formats. Auto mode tries JSON first, falls back to value parsing. Non-parseable payloads are silently treated as string values. Parse error logging is throttled to prevent log flooding from noisy wildcard subscriptions. Plain and Sparkplug B payloads. |
| `http_listener` | HTTP/REST | P1 | Push endpoint for webhook-style data sources. |
| `exec` | Shell command | P1 | Run a command, parse stdout as metrics. |
| `internal` | Agent self-metrics | P0 | Built-in. Emits `agent.*` metrics. |

### Processors

| Plugin | Function | Priority | Notes |
|--------|----------|----------|-------|
| `rename` | Rename fields/tags | P0 | |
| `converter` | Type conversion | P1 | String → number, etc. |
| `filter` | Drop/pass by criteria | P0 | namepass/namedrop/tagpass/tagdrop |
| `default` | Set default field values | P1 | Fill missing fields |
| `override` | Override tags | P1 | Force tag values |

### Aggregators

| Plugin | Function | Priority | Notes |
|--------|----------|----------|-------|
| `basicstats` | Min/max/mean/count/sum | P0 | Over configurable time windows |

### Outputs

| Plugin | Destination | Priority | Notes |
|--------|-------------|----------|-------|
| `local_store` | Local SQLite | P0 | **Built-in.** Always-on in standalone mode. Persistent local record with retention, downsampling, and export. See §11. |
| `mqtt` | MQTT broker | P0 | Plain MQTT and Sparkplug B. Shares Hub link connection when targeting same broker. |
| `http` | HTTP/REST endpoint | P1 | POST metrics as JSON/line-protocol. For InfluxDB, custom APIs. |
| `file` | Local file | P1 | JSON-lines or CSV. For debugging and local archival. |
| `stdout` | Console | P0 | For debugging. |

### Execd Support

| Type | Direction | Protocol | Priority |
|------|-----------|----------|----------|
| `execd_input` | External → Edge | Telegraf line protocol over stdin/stdout | P1 |
| `execd_output` | Edge → External | Telegraf line protocol over stdin/stdout | P1 |
