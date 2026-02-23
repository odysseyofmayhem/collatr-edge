## 15. Observability

### Agent Self-Metrics

CollatrEdge exposes metrics about itself as regular metrics in the pipeline (published via NDATA to Hub):

| Metric | Type | Description |
|--------|------|-------------|
| `agent.uptime_seconds` | counter | Seconds since agent start |
| `agent.metrics_gathered` | counter | Total metrics collected across all inputs |
| `agent.metrics_written` | counter | Total metrics successfully written across all outputs |
| `agent.metrics_dropped` | counter | Total metrics dropped (buffer overflow, filter, error) |
| `agent.event_loop_lag_ms` | gauge | Event loop lag in milliseconds |
| `agent.buffer_length` | gauge | Current buffer depth (per output, tagged) |
| `agent.buffer_overflow_count` | counter | Metrics dropped due to buffer overflow (per output) |
| `agent.gather_errors` | counter | Gather errors (per input, tagged) |
| `agent.write_errors` | counter | Write errors (per output, tagged) |
| `agent.gather_timeout_count` | counter | Gather timeouts (per input, tagged) |
| `agent.config_version` | gauge | Current config version hash |
| `agent.config_reload_count` | counter | Number of config reloads since start |
| `agent.local_store.used_bytes` | gauge | Current local data store size |
| `agent.local_store.available_bytes` | gauge | Remaining storage capacity |
| `agent.local_store.days_remaining` | gauge | Estimated days until retention limit at current ingest rate |
| `agent.local_store.retention_evictions` | counter | Metrics evicted by retention policy |
| `agent.local_store.backup_last_success` | gauge | Timestamp of last successful SMB backup |
| `agent.network_policy.mode` | gauge | Current network policy mode (encoded: 0=connected, 1=local_network, 2=standalone) |
| `agent.network_policy.blocked_connections` | counter | Connection attempts blocked by network policy |

### Health Endpoint

HTTP endpoint on the Web UI port:

```
GET /health         → 200 OK + JSON status (pipeline state, plugin count, buffer levels)
GET /health/ready   → 200 if pipeline is running, 503 if starting/stopping
GET /health/live    → 200 if process is alive
```

### Logging

Structured JSON logging to stdout/stderr:

```json
{
  "ts": "2026-02-22T10:30:00.123Z",
  "level": "warn",
  "plugin": "inputs.modbus.plc_01",
  "msg": "gather timeout",
  "timeout_ms": 5000,
  "consecutive_timeouts": 3
}
```

Per-plugin `log_level` override allows debugging individual plugins without noise from others.
