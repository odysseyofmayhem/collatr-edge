## 14. Error Handling & Resilience

### Per-Plugin Error Isolation

Every plugin call (`gather()`, `process()`, `write()`, `start()`, `stop()`) is wrapped in try/catch. One plugin's error never crashes the agent or affects other plugins.

### Startup Error Behaviours

Configurable per-plugin via `error_behavior`:

| Behaviour | Description |
|----------|-------------|
| `error` (default) | Fatal — agent refuses to start |
| `retry` | Log warning, keep retrying on each gather/flush cycle. Essential for IIoT where PLCs may not be online at boot. |
| `ignore` | Remove the plugin silently |
| `probe` | Try a test connection; remove if it fails |

### Input Errors

- Gather errors: logged, error counter incremented. **Does not stop the input.** Next gather proceeds on schedule.
- Gather timeout: killed after `timeout` duration. Warning logged, timeout counter incremented, next gather skipped.

### Processor Errors

- If `process()` throws: error logged, **metric is dropped** (`metric.drop()`). Other metrics and other processors unaffected.

### Output Errors

- Full write failure: all metrics kept in buffer for retry. `lastWriteFailed` flag prevents retriggering.
- Partial write failure: via `PartialWriteError` — accepted metrics removed, rejected metrics removed (won't retry), remaining kept.
- **Exponential backoff with jitter** on output retry (configurable via `retry_backoff`). Circuit-breaks after `retry_max` consecutive failures.

### Config Validation Errors

- On hot-reload: invalid config is rejected entirely. Agent continues with current config. Rejection logged and reported to Hub via NDATA.
- On startup: agent refuses to start with clear error message identifying the invalid field and expected type.
