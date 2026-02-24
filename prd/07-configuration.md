## 7. Configuration

### Format

**TOML.** Explicit typing, comment support, Telegraf-familiar. Avoids YAML footguns (implicit type coercion, the Norway problem) and JSON limitations (no comments).

### Structure

```toml
# Global agent settings
[agent]
  hostname = "${HOSTNAME}"
  interval = "10s"
  round_interval = true
  collection_jitter = "0s"
  collection_offset = "0s"
  flush_interval = "10s"
  flush_jitter = "0s"
  precision = "1ms"
  log_level = "info"

# Buffer settings
[agent.buffer]
  sync_mode = "normal"        # "normal" or "full" (PRAGMA synchronous)

# Hub connection (Sparkplug B)
[agent.hub]
  group_id = "plant_floor"
  edge_node_id = "${DEVICE_ID}"
  broker = "mqtts://hub.collatr.com:8883"
  tls_cert = "@{secrets:hub_cert}"
  tls_key = "@{secrets:hub_key}"

# Global tags applied to all metrics
[global_tags]
  site = "factory_a"
  area = "production"

# Input plugins
[[inputs.modbus]]
  alias = "plc_01"
  controller = "tcp://192.168.1.100:502"
  interval = "5s"               # Per-plugin override
  timeout = "3s"                # Gather timeout
  # ...

# Processor plugins
[[processors.rename]]
  order = 1
  [[processors.rename.replace]]
    field = "old_name"
    dest = "new_name"

# Aggregator plugins
[[aggregators.basicstats]]
  period = "30s"
  drop_original = false         # Per-aggregator, but evaluated globally — see §6

# Output plugins (non-Hub destinations)
[[outputs.http]]
  url = "http://influxdb.local:8086/write"
  metric_batch_size = 500
  metric_buffer_limit = 5000
```

### Environment Variable Expansion

Telegraf syntax, processed before TOML parsing:

| Syntax | Behaviour |
|--------|-----------|
| `${VAR}` | Substitute value of `VAR`, error if unset |
| `${VAR:-default}` | Substitute value of `VAR`, or `default` if unset |
| `${VAR:?error message}` | Substitute value of `VAR`, or fail with error message if unset |

### Secret References

```toml
password = "@{secrets:mqtt_password}"
```

The `@{store_id:key}` syntax references the pluggable secret store. Default store is `secrets` (SQLite + AES-256). See [Security](#16-security) for details.

### Per-Plugin Config Overrides

Every plugin supports these overrides alongside its own config:

**Adopted from Telegraf:**

| Override | Scope | Description |
|----------|-------|-------------|
| `interval` | Input | Collection interval override |
| `collection_jitter` | Input | Random delay added to each collection |
| `collection_offset` | Input | Fixed offset from interval boundary |
| `precision` | Input | Timestamp rounding precision |
| `flush_interval` | Output | Flush interval override |
| `flush_jitter` | Output | Random delay added to each flush |
| `metric_batch_size` | Output | Max metrics per `write()` call |
| `metric_buffer_limit` | Output | Max metrics buffered for this output |

**CollatrEdge extensions:**

| Override | Scope | Description |
|----------|-------|-------------|
| `timeout` | Input, Output | Per-plugin gather/write timeout. Kills hung operations. |
| `retry_max` | Output | Max consecutive retries before circuit-breaking |
| `retry_backoff` | Output | Backoff strategy: `fixed`, `exponential`, `exponential_jitter` |
| `error_behavior` | All | Startup error behaviour: `error`, `retry`, `ignore`, `probe`. **Default: `retry` for inputs, `error` for outputs.** Inputs default to retry because PLCs aren't always available at boot (90-second boot times are common). Outputs default to error because a misconfigured output should prevent startup. |
| `log_level` | All | Per-plugin log verbosity: `debug`, `info`, `warn`, `error` |
| `enabled` | All | Boolean to disable without removing config block |
| `tags` | Input, Processor | Additional tags to inject |

### Filtering (on every plugin)

Adopted from Telegraf — tag and field filtering on any plugin:

```toml
[[inputs.modbus]]
  namepass = ["temperature_*", "pressure_*"]
  namedrop = ["debug_*"]
  fieldpass = ["value", "quality"]
  tagpass = { line = ["line_1", "line_2"] }
  tagdrop = { env = ["test"] }
```

### Validation

1. TOML parsed → raw config object
2. Environment variables expanded
3. Secret references resolved
4. Global config validated against agent schema (Zod)
5. Each plugin config validated against its JSON Schema
6. **Fail fast:** if any validation fails, the entire config is rejected with clear error messages. The agent continues running the previous valid config (or refuses to start if this is the initial load).
