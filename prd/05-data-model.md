## 5. Data Model

### Metric Structure

Every data point flowing through the pipeline is a `Metric`. The model follows Telegraf's battle-tested design (name + tags + fields + timestamp), extended with priority and tracking.

```typescript
interface Metric {
  /** Measurement name (e.g., "temperature", "motor_speed") */
  name: string;

  /** Indexed metadata, sorted by key (e.g., device_id, line, area) */
  tags: Map<string, string>;

  /** Actual data values */
  fields: Map<string, FieldValue>;

  /** Nanosecond Unix timestamp (UTC) */
  timestamp: bigint;

  /** Metric type hint */
  type: MetricType;

  /** Delivery priority (used post-MVP by buffer) */
  priority: MetricPriority;

  // --- Tracking ---
  accept(): void;   // Successfully delivered
  reject(): void;   // Explicitly rejected (won't retry)
  drop(): void;     // Filtered or lost

  // --- Utilities ---
  hashId(): bigint;  // FNV-64a of name + sorted tags
  copy(): Metric;    // Deep copy for fan-out
}

type FieldValue = number | bigint | string | boolean;
type MetricType = 'untyped' | 'counter' | 'gauge' | 'summary' | 'histogram';
type MetricPriority = 'normal' | 'high' | 'critical';
```

### Design Decisions

- **Tags are sorted by key** — enables consistent hashing for aggregator grouping
- **Fields support four types:** `number` (float64), `bigint` (int64/uint64), `string`, `boolean`. All other numeric types are coerced. This maps to JavaScript's native types.
- **`hashId()`** uses FNV-64a hash of `name + tags` (not fields) — used for aggregator grouping and dedup
- **`copy()`** is hand-rolled, not `structuredClone()` — faster for our known structure
- **`priority`** is present from MVP but ignored by the buffer until post-MVP priority queue implementation
- **`accept()`/`reject()`/`drop()`** enable end-to-end delivery tracking through the pipeline

### Timestamp Assignment

Timestamps are nanosecond Unix UTC (`bigint`). Assignment follows a clear hierarchy:

| Scenario | Source | How |
|----------|--------|-----|
| **OPC-UA with source timestamp** | Device/PLC | Input plugin sets `timestamp` from OPC-UA source timestamp (see Appendix D, `timestamp = "source"`) |
| **OPC-UA with server timestamp** | OPC-UA server | Input plugin sets `timestamp` from server-assigned time |
| **Modbus / protocols without timestamps** | CollatrEdge | Runtime auto-assigns at gather time (default) |
| **MQTT with embedded timestamp** | Message payload | Input plugin parses timestamp from JSON payload field |
| **No timestamp available** | CollatrEdge | Runtime auto-assigns: `BigInt(Math.round(Bun.nanoseconds() / 1e6)) * 1_000_000n + wallClockOffsetNs` |

**Implementation detail:** `Bun.nanoseconds()` provides monotonic nanosecond precision but not wall-clock time. On startup, the runtime calculates an offset between `Bun.nanoseconds()` and `Date.now()` (wall clock). Auto-assigned timestamps use monotonic time adjusted by this offset — monotonic ordering with wall-clock alignment.

**Inputs can always override:** If an input plugin sets `timestamp` explicitly (via `acc.addFields(..., timestamp)` parameter), the runtime does not overwrite it. This is essential for protocols like OPC-UA where the source timestamp is more accurate than the collection timestamp.

### Sparkplug B Mapping

When metrics flow to Hub via the Sparkplug B Hub link:

| Metric Field | Sparkplug B Field |
|-------------|-------------------|
| `name` | Metric `name` (in BIRTH) / `alias` (in DATA) |
| `tags` | Metric `properties` (PropertySet) |
| `fields` | Metric `value` (one Sparkplug metric per field) |
| `timestamp` | Metric `timestamp` |
| `type` | Inferred from field values → Sparkplug `DataType` enum |

Sparkplug B's **metric aliasing** is applied automatically: DBIRTH publishes full metric names, subsequent DDATA messages use numeric aliases for bandwidth efficiency.
