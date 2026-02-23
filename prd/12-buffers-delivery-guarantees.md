## 12. Buffers & Delivery Guarantees

### Architecture

Each output has its own independent buffer. The buffer has two tiers:

```
Pipeline ──► Output.add() ──► Filter ──► [Memory Ring Buffer] ──► [SQLite WAL] ──► Batch ──► Output.write()
                                              (hot tier)            (cold tier)
```

- **Memory ring buffer (hot tier):** Fast, in-process. Serves metrics to `write()` from memory when possible.
- **SQLite WAL (cold tier):** Persistent. Every metric is written through to SQLite before being acknowledged to the pipeline. Survives crashes and power loss.

### Delivery Guarantee

**At-least-once.** Every metric is persisted to SQLite before acknowledgement. If `write()` fails, metrics stay in the buffer for retry. If the process crashes, SQLite WAL recovery brings them back.

**Duplicate handling:** After crash recovery, metrics that were written to the output but not yet acknowledged may be re-sent. CollatrEdge does **not** add a synthetic `metric_id` — this would add overhead to every metric for a rare edge case. Instead, the natural composite key `(name, tags, timestamp)` serves as the deduplication key. Downstream systems (Hub, InfluxDB, TimescaleDB) that use time-series storage naturally handle upserts on this key. For outputs that don't deduplicate (file, stdout), duplicates are harmless.

**MVP scope:** At-least-once with natural-key dedup. Post-MVP: optional exactly-once delivery via buffer transaction dedup IDs (requires downstream coordination).

### Overflow Policies

Configurable per-output:

```toml
[[outputs.mqtt]]
  overflow_policy = "drop_oldest"   # default
  metric_buffer_limit = 50000
  metric_batch_size = 1000
```

| Policy | Behaviour |
|--------|-----------|
| `drop_oldest` (default) | Oldest metrics discarded when buffer is full. Recent data is more valuable for telemetry. |
| `disk_spill` | Memory buffer overflows to SQLite without discarding. Buffer grows on disk until `metric_buffer_limit` is hit, then falls back to `drop_oldest`. |
| `block` | Backpressure to input — `Channel<T>.send()` awaits until buffer has space. Slows polling rather than losing data. |

### Write Transaction Model

Adopted from Telegraf with improvements:

1. `buffer.beginTransaction(batchSize)` → returns oldest N metrics
2. `output.write(batch)` is called
3. On **success:** `tx.acceptAll()` — metrics removed from buffer
4. On **total failure:** `tx.keepAll()` — metrics stay for retry
5. On **partial failure:** `tx.accept(indices)` / `tx.reject(indices)` — granular control via `PartialWriteError`

### Power Loss Recovery

- **`synchronous = NORMAL` (default):** Lose at most ~1 second of data on unexpected power loss. Suitable for the vast majority of deployments.
- **`synchronous = FULL` (config option):** Zero data loss. Fsync on every commit, at the cost of write throughput.

### Buffer Sizing

Per-output, two parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `metric_buffer_limit` | 10000 | Maximum metrics buffered for this output |
| `metric_batch_size` | 1000 | Maximum metrics per `write()` call |
