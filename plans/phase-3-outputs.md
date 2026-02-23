# Phase 3: Output Plugins — Implementation Plan

**Goal:** Build the P0 output plugins (local data store, file, stdout) and the store-and-forward buffer. By the end of Phase 3, CollatrEdge can persist collected data locally in SQLite with retention policies, write to files, and buffer metrics for delivery resilience.

**Estimated Duration:** 1–1.5 weeks
**PRD References:** §11 (Local Data Store), §12 (Buffers & Delivery Guarantees), §14 (Error Handling), §19 (MVP Plugin Inventory), Appendix A (Full Config Example)

---

## What Phase 3 Delivers

| Output | Priority | Description |
|--------|----------|-------------|
| `stdout` | P0 | Debug output — write metrics to console. Simplest output, validates the pattern. |
| `file` | P1→P0 for MVP | Write metrics as JSON-lines or CSV to a file. Debugging and local archival. |
| `local_store` | P0 | SQLite-based persistent storage with daily rotation, retention, downsampling, and CSV export. The primary output in standalone mode. |
| S&F Buffer | P0 | Store-and-forward buffer (SQLite WAL) for at-least-once delivery on remote outputs. |

---

## Module Dependency Order

```
3.0  Stdout output                    ← simplest, validates Output interface
3.1  File output                      ← JSON-lines and CSV formats
3.1i Integration: file output → pipeline
3.2  Local data store output          ← SQLite, daily rotation, retention, batch writes
3.2i Integration: local store → pipeline
3.3  Store-and-forward buffer         ← SQLite WAL, per-output queuing, transaction model
3.3i Integration: S&F buffer → output → pipeline
```

**Build order rationale:**
- Stdout first — trivial, validates Output contract with real pipeline
- File output next — introduces serialisation (JSON-lines) that local store will also need
- Local store is the most complex — SQLite schema, daily rotation, retention, downsampling
- S&F buffer last — builds on SQLite patterns from local store, adds transactional delivery

---

## Module 3.0: Stdout Output

**PRD:** §19

### What to Build
- `src/plugins/outputs/stdout.ts`
- Output implementation that writes metrics to `console.log()`
- Configurable format: `json` (default) or `line_protocol`
- Metric serialisation to readable string
- `connect()` — no-op
- `write(batch)` — format and print each metric
- `close()` — no-op

### Config Schema
```typescript
const StdoutConfigSchema = z.object({
  format: z.enum(['json', 'line_protocol']).default('json'),
});
```

### Tests
- write() outputs JSON representation of metrics to console
- write() with line_protocol format outputs Telegraf-compatible line protocol
- connect() and close() are no-ops (don't throw)
- Batch of 10 metrics → 10 lines output
- Metric with tags and multiple fields serialised correctly

---

## Module 3.1: File Output

**PRD:** §19, Appendix A

### What to Build
- `src/plugins/outputs/file.ts`
- Output that writes metrics to a local file
- Formats: `json` (JSON-lines, one metric per line) and `csv`
- File rotation: configurable (none, daily, size-based) — MVP: just append
- `connect()` — open/create file
- `write(batch)` — append serialised metrics
- `close()` — flush and close file handle
- JSON format: one JSON object per line (JSON-lines)
- CSV format: header row on first write, data rows after

### Config Schema
```typescript
const FileOutputConfigSchema = z.object({
  path: z.string().describe('Output file path'),
  format: z.enum(['json', 'csv']).default('json'),
  // rotation: z.enum(['none', 'daily', 'size']).default('none'),  // post-MVP
});
```

### Key Constraints
- JSON-lines format: `{"name":"...", "tags":{...}, "fields":{...}, "timestamp":...}\n`
- CSV: header = `timestamp,name,tag_keys...,field_keys...` — tricky with varying schemas. MVP: flatten all fields.
- Append mode — don't overwrite existing file on restart
- Handle write errors gracefully (disk full, permissions)

### Tests
- JSON format: write batch → file contains valid JSON-lines
- CSV format: write batch → file has header + data rows
- Append mode: two write() calls → all metrics in file
- connect() creates file if it doesn't exist
- connect() appends to existing file (doesn't overwrite)
- close() flushes buffered data
- Write error (invalid path) → error thrown, not swallowed

---

## Module 3.2: Local Data Store Output

**PRD:** §11 (complete section), §7 (config)

### What to Build
- `src/plugins/outputs/local-store.ts`
- SQLite-based persistent local storage
- **Daily file rotation**: `data/data_YYYY_MM_DD.db` — one file per day
- **Schema per daily file**: metrics table + tag_index table (per PRD §11 schema)
- **Batch writes**: buffer metrics in memory, write in single transaction (1s default)
- **MessagePack encoding**: fields stored as msgpackr-encoded BLOB
- **Retention policies** (all active simultaneously):
  - Time-based: delete daily files older than `retention_days`
  - Size-based: evict oldest files when total exceeds `retention_max_gb`
  - Downsampling: aggregate to `downsample_interval` after `downsample_after_days`
- **WAL mode** with `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`
- **Startup recovery**: WAL checkpoint + integrity check on startup
- **CSV export**: query time range → write CSV file
- `connect()` — create data directory, open/create today's daily file, run migrations
- `write(batch)` — batch insert with transaction, update tag_index
- `close()` — WAL checkpoint, close all open database handles

### Config Schema (from PRD §11)
```typescript
const LocalStoreConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('/var/collatr/data'),
  retention_days: z.number().int().min(1).default(90),
  retention_max_gb: z.number().min(0.1).default(10),
  rotation: z.enum(['daily']).default('daily'),
  downsample_after_days: z.number().int().min(1).default(7),
  downsample_interval: z.string().default('1m'),
  // backup_smb_path and backup_schedule — post-MVP
});
```

### Key Constraints
- **Daily rotation is the TTL mechanism** — delete old `.db` files, no VACUUM needed
- **MessagePack for fields** via `msgpackr` — type fidelity, faster than JSON
- **tags_hash** uses the Metric's existing `hashId()` (FNV-64a)
- **BEGIN IMMEDIATE** transactions — fail fast on lock contention
- **SQLITE_BUSY retry** — one retry after busy_timeout
- **Tag index** updated with ON CONFLICT upsert for `last_seen`
- **Retention runs on daily maintenance pass** (not per-write)
- **Downsampling**: min/max/mean/count per field, per name+tags_hash, per interval boundary

### Tests
- write() inserts metrics into daily SQLite file
- Metrics retrievable: query by time range returns correct data
- MessagePack round-trip: fields encode and decode correctly
- Daily rotation: metrics on different days go to different files
- Tag index populated: name + tags_hash entries created
- Tag index upsert: last_seen updated on subsequent writes
- Retention time-based: files older than retention_days deleted
- Retention size-based: oldest file deleted when total exceeds limit
- WAL mode enabled on new databases
- Startup recovery: WAL checkpoint runs on connect()
- Batch write atomicity: partial failure → full rollback
- SQLITE_BUSY: retry on lock contention
- CSV export: time range → correct CSV output
- Empty write (no metrics) → no error
- connect() creates data directory if missing
- close() checkpoints WAL

---

## Module 3.3: Store-and-Forward Buffer

**PRD:** §12 (complete section)

### What to Build
- `src/buffer/store-forward.ts`
- Per-output buffer with memory (hot) + SQLite (cold) tiers
- **Memory ring buffer**: fast path for recent metrics
- **SQLite persistence**: every metric written through to SQLite before acknowledgement
- **Transaction model**: beginTransaction → write → acceptAll/keepAll/accept+reject
- **Overflow policies**: `drop_oldest` (default), `disk_spill`, `block` (post-MVP)
- **Configurable per-output**: `metric_buffer_limit`, `metric_batch_size`
- **Recovery on startup**: read unacknowledged metrics from SQLite

### Key Interfaces (from PRD §12)
```typescript
interface BufferTransaction {
  metrics(): Metric[];
  acceptAll(): void;
  keepAll(): void;
  accept(indices: number[]): void;
  reject(indices: number[]): void;
}

interface StoreForwardBuffer {
  add(metrics: Metric[]): void;
  beginTransaction(batchSize: number): BufferTransaction;
  length: number;
  close(): void;
}
```

### Config Schema
```typescript
const BufferConfigSchema = z.object({
  metric_buffer_limit: z.number().int().min(100).default(10000),
  metric_batch_size: z.number().int().min(1).default(1000),
  overflow_policy: z.enum(['drop_oldest', 'disk_spill']).default('drop_oldest'),
  // block: post-MVP
});
```

### Key Constraints
- **At-least-once delivery**: metric persisted to SQLite before acknowledged to pipeline
- **Natural-key dedup**: `(name, tags, timestamp)` composite key — no synthetic metric_id
- **Per-output buffer table**: `buffer_{output_alias}` in main database
- **acceptAll()** removes metrics from buffer (successful delivery)
- **keepAll()** leaves metrics for retry (total write failure)
- **accept/reject granular**: for partial write failures via PartialWriteError
- **Startup recovery**: read all unacknowledged entries from SQLite buffer table

### Tests
- add() persists metrics to SQLite buffer
- beginTransaction() returns oldest N metrics
- acceptAll() removes metrics from buffer
- keepAll() leaves metrics for retry
- accept(indices) removes selected, keeps others
- reject(indices) removes rejected (won't retry)
- Buffer limit: oldest dropped when limit exceeded (drop_oldest policy)
- disk_spill: memory overflows to SQLite without dropping
- Recovery: crash simulation → restart → unacknowledged metrics still in buffer
- Empty buffer: beginTransaction returns empty batch
- Concurrent add + beginTransaction: no data corruption
- Buffer length tracks current count accurately

---

## Phase 3 Acceptance Criteria

Phase 3 is complete when:

1. ✅ Stdout output prints metrics in JSON format
2. ✅ File output writes JSON-lines to a file
3. ✅ Local data store persists metrics in daily-rotated SQLite files
4. ✅ Retention policies work (time-based, size-based)
5. ✅ CSV export extracts data from local store
6. ✅ S&F buffer provides at-least-once delivery guarantee
7. ✅ Buffer recovery after simulated crash
8. ✅ All tests pass: `bun test`
9. ✅ Sub-agent code review completed and findings addressed

---

## Risks

| Risk | Mitigation |
|------|-----------|
| SQLite locking in concurrent read/write scenarios | WAL mode + BEGIN IMMEDIATE + busy_timeout. Test concurrent access explicitly. |
| Daily file rotation edge cases (midnight boundary) | Use UTC day boundaries. Test metrics arriving at 23:59:59 and 00:00:00. |
| MessagePack encoding edge cases | Reuse spike validation. Test all FieldValue types round-trip. |
| Downsampling correctness | Test with known data: 60 points at 1/sec → 1 summary with correct min/max/mean/count. |
| Buffer + output interaction complexity | Build buffer after outputs — test with real stdout/file outputs first. |
