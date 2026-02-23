# Phase 3: Outputs — Progress

## Status: COMPLETE

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 3.0 | Stdout output | ✅ |
| 3.1 | File output (JSON-lines, CSV) | ✅ |
| 3.1i | File output → pipeline integration | ✅ |
| 3.2 | Local data store (SQLite, rotation, retention) | ✅ |
| 3.2i | Local store → pipeline integration | ✅ |
| 3.3 | Store-and-forward buffer | ✅ |
| 3.3i | S&F buffer + output integration | ✅ |

## Task 3.0: Stdout Output — COMPLETE

**Files created:**
- `src/plugins/outputs/stdout.ts` — StdoutOutput class, config schema, toJSON/toLineProtocol helpers
- `test/unit/plugins/outputs/stdout.test.ts` — 18 tests

**What was built:**
- `StdoutOutput` implementing the `Output` interface (connect/write/close)
- Zod config schema: `format: 'json' | 'line_protocol'` (default: json)
- JSON format: serialises metric as `{name, tags, fields, timestamp}` JSON object. Timestamp as string (bigint not JSON-safe).
- Line protocol format: Telegraf-compatible `measurement,tag=val field=val timestamp` with proper escaping (spaces, commas, equals, quotes in strings)
- Exported `toJSON()` and `toLineProtocol()` helpers for reuse by file output (task 3.1)

**Decisions:**
- `bigint` fields get `i` suffix in line protocol (Telegraf convention)
- Integer numbers (`Number.isInteger()`) get `i` suffix; floats are bare. Note: JS treats `1.0` as integer — this matches Telegraf behaviour where explicit integer typing uses the `i` suffix.
- JSON format serialises bigint timestamp as string since JSON.stringify can't handle bigint natively.
- Exported serialisation helpers (`toJSON`, `toLineProtocol`) so the file output can reuse them without duplicating logic.

**Test count:** 269 pass (18 new), 0 fail

## Task 3.1: File Output — COMPLETE

**Files created:**
- `src/plugins/outputs/file.ts` — FileOutput class, config schema, CSV helpers
- `test/unit/plugins/outputs/file.test.ts` — 18 tests

**What was built:**
- `FileOutput` implementing the `Output` interface (connect/write/close)
- Zod config schema: `path` (required), `format: 'json' | 'csv'` (default: json)
- JSON-lines format: one JSON object per line, reuses `toJSON()` from stdout plugin
- CSV format: header row on first write (timestamp, name, sorted tags, sorted fields), data rows after
- Append mode: `connect()` creates file if missing, never truncates existing content
- `node:fs/promises` for file I/O (`appendFile` for writes, `mkdir` for parent dirs)

**Decisions:**
- Reused `toJSON()` from stdout plugin — avoids duplicating serialisation logic
- CSV columns established from first batch. Missing fields in later metrics produce empty values. New fields in later batches are silently dropped (column set is fixed after first write).
- CSV tag/field columns use `tag:` and `field:` internal prefixes for disambiguation during lookup, stripped for the header display.
- CSV values with commas, quotes, or newlines are properly escaped per RFC 4180.
- `connect()` creates parent directories with `mkdir({ recursive: true })`.

**Test count:** 287 pass (18 new), 0 fail

## Task 3.1i: File Output Pipeline Integration — COMPLETE

**Files created:**
- `test/integration/file-pipeline.test.ts` — 3 integration tests

**What was tested:**
- Mock polling input → pipeline → FileOutput (JSON-lines): metrics arrive in file with correct names, fields, tags
- Global tags (`site`, `line`) merged into every metric in the file
- Processor (TaggingProcessor adds `processed=true`) transforms reflected in file output

**Test count:** 290 pass (3 new), 0 fail

## Task 3.2: Local Data Store — COMPLETE

**Files created:**
- `src/plugins/outputs/local-store.ts` — LocalStoreOutput class, config schema, MessagePack helpers, retention, downsampling, CSV export
- `test/unit/plugins/outputs/local-store.test.ts` — 21 tests

**What was built:**
- `LocalStoreOutput` implementing the `Output` interface (connect/write/close)
- Zod config schema matching PRD §11: enabled, path, retention_days, retention_max_gb, rotation, downsample_after_days, downsample_interval
- Daily file rotation: `data_YYYY_MM_DD.db` — metrics routed to correct daily file by UTC date
- SQLite PRAGMAs: WAL mode, synchronous=NORMAL, busy_timeout=5000
- Schema: `metrics` table (timestamp, name, tags_hash, tags, fields BLOB, quality) + `tag_index` table (name, tags_hash, tags, first_seen, last_seen)
- Batch writes via `BEGIN IMMEDIATE` transaction with SQLITE_BUSY retry (one retry)
- MessagePack encoding/decoding of fields via `msgpackr` (type fidelity: int/float/string/bool)
- Quality mapping: good=0, uncertain=1, bad=2 (from metric `quality` tag)
- Tags hash: `metric.hashId() & 0x7fffffffffffffffn` (ensure positive for SQLite)
- Retention: time-based (delete files older than retention_days) + size-based (delete oldest when exceeding retention_max_gb)
- Downsampling: aggregate numeric fields to min/max/mean/count per interval boundary
- CSV export: query time range across daily files, collect all field keys, output CSV
- `query()` method for testing: time range query across daily files with decoded results
- WAL checkpoint on open (startup recovery) and on close

**Decisions:**
- Tags stored as JSON string (sorted keys from metric's sorted Map)
- Fields stored as MessagePack BLOB (type fidelity, faster than JSON, 12-15% smaller for large payloads)
- Daily file deletion is the TTL mechanism — no VACUUM needed, critical for flash storage longevity
- Timestamps stored as `Number(bigint)` — exact for most nanosecond timestamps divisible by 256 (all standard timestamps at second resolution are exact)
- `connect()` creates data directory and today's DB file (fail-fast validation), then runs retention
- Exported `encodeFields()`, `decodeFields()`, `timestampToDateString()` helpers for testing and future reuse

**Test count:** 311 pass (21 new), 0 fail

## Task 3.2i: Local Store Pipeline Integration — COMPLETE

**Files created:**
- `test/integration/local-store-pipeline.test.ts` — 4 integration tests

**What was tested:**
- Mock polling input → pipeline → LocalStoreOutput: metrics persisted to SQLite with correct names, fields, tags
- MessagePack round-trip: all stored fields decode back to original values via `decodeFields()`
- Tag index populated: both metric series (temperature, pressure) have entries with correct tags_hash and parseable tags JSON
- Global tags (`site`, `line`) merged into every stored metric alongside original tags

**Test count:** 315 pass (4 new), 0 fail

## Task 3.3: Store-and-Forward Buffer — COMPLETE

**Files created:**
- `src/buffer/store-forward.ts` — StoreForwardBuffer, BufferTransaction, config schema, metric encoding helpers
- `test/unit/buffer/store-forward.test.ts` — 15 tests

**Files modified:**
- `tsconfig.json` — added `@buffer/*` path alias

**What was built:**
- `StoreForwardBuffer` class with SQLite persistence (WAL mode, synchronous=NORMAL, busy_timeout=5000)
- Per-output buffer table naming: `buffer_{sanitised_alias}` (shared DB, isolated tables)
- `add(metrics)`: batch INSERT in transaction, enforces overflow policy after insertion
- `beginTransaction(batchSize)`: SELECT oldest N by row ID, returns `BufferTransaction`
- `BufferTransaction` with full PRD §12 transaction model:
  - `acceptAll()`: remove all transaction metrics (successful delivery)
  - `keepAll()`: no-op (total failure, retry later)
  - `accept(indices)`: remove specific metrics by batch position (partial success)
  - `reject(indices)`: remove specific metrics by batch position (permanent failure)
- Overflow policies: `drop_oldest` (default) and `disk_spill` — both enforce `metric_buffer_limit` at SQLite level in MVP; two-tier memory/disk distinction deferred to post-MVP
- Recovery: `open()` counts existing rows, so unacknowledged metrics from previous session are immediately available
- `encodeMetric()`/`decodeMetric()`: full metric → MessagePack blob round-trip (name, tags, fields, timestamp as string, type, priority)
- Zod config schema: metric_buffer_limit (default 10000), metric_batch_size (default 1000), overflow_policy

**Decisions:**
- BigInt timestamp encoded as string in MessagePack payload for portable encoding
- Alias sanitised to `[a-zA-Z0-9_]` for safe SQL identifier usage
- Both overflow policies identical at SQLite level in MVP — the memory tier optimisation is post-MVP
- `reject()` and `accept()` both delete from buffer; semantic difference is for logging/metrics, not buffer state

**Test count:** 330 pass (15 new), 0 fail

## Task 3.3i: S&F Buffer + Output Integration — COMPLETE

**Files created:**
- `test/integration/buffer-output.test.ts` — 4 integration tests

**What was tested:**
- Buffer + SuccessOutput: metrics delivered via output.write(), then acceptAll() drains buffer to 0
- Buffer + FailingOutput: output.write() throws → keepAll() retains metrics for retry across multiple attempts, metrics remain intact and in correct order
- Buffer + PartialOutput: partial write failure with acceptIndices/rejectIndices → accept() removes successful metrics, reject() removes permanently failed metrics, buffer drained
- Crash recovery: add metrics, output fails, keepAll(), close buffer (simulate crash), reopen from same DB path → metrics survive restart, successful delivery on second session

**Test count:** 334 pass (4 new), 0 fail

## Notes

### Dependencies
- `bun:sqlite` — built-in, validated in spike
- `msgpackr` — already in package.json from Phase 1

### Key PRD Sections
- §11 (Local Data Store) — complete section, very detailed
- §12 (Buffers & Delivery Guarantees) — transaction model, overflow policies
- §14 (Error Handling) — output error behaviour, retry, circuit breaking
