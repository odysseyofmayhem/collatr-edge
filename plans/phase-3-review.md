# Phase 3 Code Review — Output Plugins & Store-and-Forward Buffer

**Reviewer:** Sub-agent (fresh context, per CLAUDE.md Phase Work Pattern step 4)
**Date:** 2026-02-23
**Scope:** All source and test files from Phase 3 (tasks 3.0-3.3)
**Test Status:** All 334 tests pass (0 failures)

---

## Summary

Phase 3 delivers four modules: stdout output, file output, local data store output, and the store-and-forward buffer. The code is well-organised, follows established project patterns, and has solid test coverage for happy paths. Tests pass cleanly.

However, the review found **3 must-fix issues** that will cause data corruption or runtime failures in production, **8 should-fix issues** affecting robustness and spec compliance, and **6 nice-to-have improvements**. The most critical finding is nanosecond timestamp precision loss in the local data store -- every metric stored loses the least significant 2-3 digits of its nanosecond timestamp due to a `Number()` conversion that exceeds `MAX_SAFE_INTEGER`.

---

## Findings

### 🔴 Must Fix

#### 🔴 F-01: Nanosecond timestamp precision loss in local store (data corruption)

**Files:** `src/plugins/outputs/local-store.ts:243`, `src/plugins/outputs/local-store.ts:477`, `src/plugins/outputs/local-store.ts:552`

The PRD (Section 11 schema) specifies `timestamp INTEGER NOT NULL -- nanosecond Unix UTC`. Metric timestamps are `bigint` nanosecond values (e.g., `1700000000000000000n`). However, the code converts them to JavaScript `Number` before passing to SQLite:

```typescript
// local-store.ts:243
const ts = Number(metric.timestamp);
insertStmt.run(ts, metric.name, tagsHash, tagsJson, fieldsBlob, quality);
```

`Number.MAX_SAFE_INTEGER` is `9007199254740991` (~9.0e15). A nanosecond timestamp in 2024-2026 is ~1.7e18, which is approximately **200x** larger than `MAX_SAFE_INTEGER`. This means:

- The last 2-3 digits of every nanosecond timestamp are silently rounded
- Two metrics arriving 100ns apart could get the same stored timestamp
- Time-range queries (`WHERE timestamp >= ? AND timestamp <= ?`) at lines 477 and 552 also suffer precision loss in the query parameters
- The downsample boundary calculation at line 393 `(ts / intervalNs) * intervalNs` operates on `BigInt` correctly, but the subsequent `Number(bucket.boundary)` at line 442 loses precision when writing back

**Impact:** Silent data corruption. Metrics appear to have slightly wrong timestamps. Correlation with other time-series data (e.g., PLC timestamps from OPC-UA at 1ms resolution) will show unexplained jitter. For a 1ms polling interval, the ~100ns rounding might not matter practically, but at 1s polling with nanosecond precision from OPC-UA source timestamps, the stored value will differ from the original.

**Fix:** Use `BigInt` throughout. Bun's `bun:sqlite` supports BigInt values in prepared statements when the database is opened with `{ strict: true }` or when values are passed as BigInt. If Bun's SQLite binding does not support BigInt parameters directly, store timestamps as TEXT (string representation of the bigint) or split into two columns. Alternatively, if millisecond precision is acceptable for the MVP, convert to milliseconds consistently and document the precision reduction -- but this contradicts the PRD's "nanosecond Unix UTC" spec.

**Rule violated:** Rule 5 (PRD is the spec), Rule 8 (interface compliance)

---

#### 🔴 F-02: SQLite parameter limit exceeded in BufferTransaction.deleteByIds()

**File:** `src/buffer/store-forward.ts:129-134`

```typescript
private deleteByIds(ids: number[]): void {
  const placeholders = ids.map(() => "?").join(",");
  this.db.prepare(
    `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
  ).run(...ids);
}
```

SQLite has a default compile-time limit of `SQLITE_MAX_VARIABLE_NUMBER = 999` host parameters. The default `metric_batch_size` is 1000 (from PRD Section 12). When `acceptAll()` is called on a full batch of 1000 metrics, this generates 1000 placeholders -- exceeding the SQLite limit. This will throw a runtime error on `acceptAll()` for any batch of 1000+ metrics, which is the exact default configuration.

**Impact:** The default config's flush cycle will crash on successful delivery. The buffer will never drain. Metrics accumulate until `metric_buffer_limit` is hit, then oldest are dropped. Production data loss.

**Fix:** Chunk the delete into batches of <=999 IDs:

```typescript
private deleteByIds(ids: number[]): void {
  const CHUNK_SIZE = 900; // safely under SQLite's 999 limit
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
    ).run(...chunk);
  }
}
```

Alternatively, use a transaction wrapping multiple fixed-size deletes, or delete by ID range (`WHERE id >= ? AND id <= ?`) when IDs are contiguous.

**Rule violated:** Rule 9 (test the hard paths -- this path has no test with batch_size >= 1000)

**Test gap:** No test exercises `acceptAll()` with batch size >= 1000. The test at `store-forward.test.ts:116` only uses 3 metrics. Add a test with 1500 metrics to validate the chunking works.

---

#### 🔴 F-03: BufferTransaction interface deviates from PRD (Rule 8 violation)

**File:** `src/buffer/store-forward.ts:75-135`

The PRD Section 12 defines:

```typescript
interface BufferTransaction {
  metrics(): Metric[];  // method
  acceptAll(): void;
  keepAll(): void;
  accept(indices: number[]): void;
  reject(indices: number[]): void;
}
```

The implementation uses:

```typescript
get batch(): Metric[] { return this._batch; }  // property, not method; wrong name
```

This is a `metrics()` method vs `batch` property naming mismatch. Downstream code (the pipeline flush loop, Phase 4+ outputs) will be written against the PRD interface and will call `tx.metrics()`, which will fail with "not a function".

**Fix:** Rename `batch` getter to a `metrics()` method, or add a `metrics()` method that returns `this._batch`. Update all call sites (tests).

**Rule violated:** Rule 8 (interface compliance check -- field-by-field diff against PRD)

---

### 🟡 Should Fix

#### 🟡 F-04: CSV export omits tags (spec gap)

**File:** `src/plugins/outputs/local-store.ts:461-516`

The `exportCSV()` method produces headers: `timestamp,name,quality,...fields`. Tags are parsed from JSON (line 494) but never included in the CSV output. The PRD Section 11 states CSV export is for "Production managers live in Excel" and for offline analysis. Tags contain critical context: which sensor, which PLC, which production line generated each reading.

A CSV without tags would look like:
```
timestamp,name,quality,value
1700000000000,temperature,0,23.5
1700000000000,temperature,0,24.0
```

...with no way to distinguish which sensor produced which reading.

**Fix:** Include tag columns in the CSV export, similar to the file output's CSV format: collect all tag keys across rows, add sorted tag columns between `name` and `quality` (or after quality), populate each row's tag values.

---

#### 🟡 F-05: Unused imports in local-store.ts

**File:** `src/plugins/outputs/local-store.ts:9`

```typescript
import { appendFileSync, writeFileSync } from "node:fs";
```

Neither `appendFileSync` nor `writeFileSync` is used anywhere in the file. These are dead imports, likely left over from an earlier implementation approach.

**Fix:** Remove the import line.

**Rule violated:** Rule 6 (commit discipline -- no dead code)

---

#### 🟡 F-06: Config field naming inconsistency with PRD Appendix A

**Files:** `src/plugins/outputs/file.ts:17`, `src/plugins/outputs/stdout.ts:13`

The PRD Appendix A configuration example uses `data_format` for output format specification:

```toml
[[outputs.file]]
  data_format = "json"
```

The implementation uses `format`:

```typescript
format: z.enum(["json", "csv"]).default("json")
```

When the config parser reads a TOML file with `data_format = "json"`, it will not match the Zod schema's `format` field. The config value will be silently ignored, and the default (`"json"`) will be used regardless of what the user configured.

**Impact:** Users following the PRD/Appendix A config format will not be able to configure the file output format. The stdout output has the same issue.

**Fix:** Either rename the schema field to `data_format` to match the PRD config key, or add an alias/transform. The PRD prose and config example both use `data_format`.

---

#### 🟡 F-07: `tags_hash` includes metric name, deviating from PRD comment

**File:** `src/plugins/outputs/local-store.ts:239`

```typescript
const tagsHash = Number(metric.hashId() & 0x7fffffffffffffffn);
```

The PRD Section 11 schema comments say `tags_hash INTEGER NOT NULL -- FNV-64a of sorted tags (grouping key)`. But `metric.hashId()` computes `FNV-64a of name + sorted tags` (see `src/core/metric.ts:99-107`). The composite `(name, tags_hash)` primary key in `tag_index` already separates name and tags_hash, so including `name` in the hash is redundant and means two metrics with the same tags but different names will produce different `tags_hash` values even though the tags are identical.

This is not technically incorrect (the composite key still uniquely identifies series), but it means you cannot query "all series with the same tags across different measurements" using `tags_hash` alone, which the PRD's separate `name` and `tags_hash` columns were designed to support.

Additionally, `Number(...)` conversion of the hash has the same precision loss issue as F-01. A 64-bit hash will lose its least significant bits when converted to a JavaScript Number. This could cause hash collisions in the `tag_index` that would not occur with the full 64-bit value.

**Fix:** Either compute a separate tags-only hash for `tags_hash`, or document the deviation. The Number precision issue should be fixed with BigInt support (same fix as F-01).

---

#### 🟡 F-08: `metric_buffer_limit` minimum is 1, plan says 100

**File:** `src/buffer/store-forward.ts:15`

```typescript
metric_buffer_limit: z.number().int().min(1).default(10000),
```

The phase plan at `plans/phase-3-outputs.md:212` specifies `min(100)`:

```typescript
metric_buffer_limit: z.number().int().min(100).default(10000),
```

A buffer limit of 1 is practically useless and would cause immediate overflow on every add(). The plan's `min(100)` is a more sensible minimum.

**Fix:** Change `.min(1)` to `.min(100)` to match the plan.

---

#### 🟡 F-09: File output CSV schema is fixed after first batch -- new fields silently dropped

**File:** `src/plugins/outputs/file.ts:96-100`

```typescript
if (!this.csvColumns) {
  this.csvColumns = this.buildColumns(batch);
}
```

CSV columns are determined from the first batch only. If later batches contain metrics with fields not present in the first batch, those fields are silently dropped from the CSV output. The test at `file.test.ts:398-422` tests for missing fields (fields in first batch not in second), but does not test for *new* fields (fields in second batch not in first).

**Impact:** In a mixed-metric pipeline where different measurement types flow through the same file output, metrics arriving after the first flush cycle may lose fields.

**Fix:** Either (a) document the limitation clearly, (b) dynamically extend columns when new fields appear (requires re-writing the header, which is complex for append-only), or (c) collect field schema from config rather than auto-detecting.

---

#### 🟡 F-10: Downsampling does not handle BigInt field values

**File:** `src/plugins/outputs/local-store.ts:411`

```typescript
if (typeof value !== "number") continue;
```

The downsampling loop skips non-number fields. This correctly skips strings and booleans, but it also skips `bigint` values. In IIoT, bigint fields are common for counters (e.g., total parts produced, OPC-UA sequence numbers). These counter values will be silently dropped during downsampling.

The PRD Section 11 says "min/max/mean/count for each numeric field." BigInt is numeric.

**Fix:** Add BigInt handling: convert to Number for aggregation (with precision check) or use BigInt arithmetic for min/max/sum.

---

#### 🟡 F-11: No test for the SQLITE_BUSY retry path in local store

**Files:** `src/plugins/outputs/local-store.ts:250-260`, `test/unit/plugins/outputs/local-store.test.ts`

The `writeToDailyDb` method has a SQLITE_BUSY retry path:

```typescript
} catch (e) {
  const err = e as Error;
  if (err.message.includes("SQLITE_BUSY")) {
    console.warn("[local_store] write blocked by concurrent reader, retrying");
    tx();
  } else {
    throw err;
  }
}
```

The test at `local-store.test.ts:427-448` tests concurrent reads and writes but does not actually trigger SQLITE_BUSY. WAL mode allows concurrent readers and a single writer without conflict. To trigger SQLITE_BUSY, you would need two concurrent writers or a reader that promotes to a write (e.g., via temp tables).

The retry also has no guard against the retry itself failing with SQLITE_BUSY -- if the retry throws SQLITE_BUSY again, it will propagate as an unhandled error. The PRD pseudocode at Section 11 shows "Retry once after busy_timeout (5000ms from PRAGMA)" which implies exactly one retry, but the code has no protection against infinite retry or second-failure propagation.

**Rule violated:** Rule 9 (test the hard paths first -- the SQLITE_BUSY branch has zero test coverage proving it triggers correctly)

---

### 🟢 Nice to Have

#### 🟢 F-12: StdoutOutput.toJSON BigInt serialisation loses type information

**File:** `src/plugins/outputs/stdout.ts:76-93`

The `toJSON()` function converts BigInt field values by relying on `JSON.stringify()`. Since `JSON.stringify()` throws on BigInt values, any metric with a BigInt field will crash the stdout output. The test at `stdout.test.ts:228-250` tests `int_val: 42` (which is a Number, not a BigInt) and does not test BigInt fields in JSON mode.

The line protocol formatter handles BigInt correctly (line 26-27), but the JSON formatter does not.

**Fix:** Add a replacer function to `JSON.stringify()` that converts BigInt to string (or number if within safe range), or pre-process the fields object.

---

#### 🟢 F-13: Local store `retentionBySize()` calls `statSync` twice for each file

**File:** `src/plugins/outputs/local-store.ts:295-326`

The method first loops through all files to sum sizes, then loops again to delete. For the files being deleted, `statSync` is called twice (once for the total, once for the subtraction at line 313). This is a minor inefficiency -- could be optimised by caching sizes in the first pass.

---

#### 🟢 F-14: No `init()` method on output plugins

**Files:** `src/plugins/outputs/stdout.ts`, `src/plugins/outputs/file.ts`, `src/plugins/outputs/local-store.ts`

The PRD Appendix B Output interface includes `init?(): Promise<void>`. While it's optional (note the `?`), the pipeline runtime calls `init()` if present. None of the Phase 3 output plugins implement `init()`. This is technically correct (optional method), but for consistency with future plugins and the PRD pattern, a no-op `init()` could be added.

---

#### 🟢 F-15: Buffer `open()` is not part of PRD StoreForwardBuffer interface

**File:** `src/buffer/store-forward.ts:155`

The PRD defines:
```typescript
interface StoreForwardBuffer {
  add(metrics: Metric[]): void;
  beginTransaction(batchSize: number): BufferTransaction;
  length: number;
  close(): void;
}
```

The implementation adds an `open()` method not in the PRD interface. This is a reasonable addition (database initialisation needs to happen somewhere), but it means the class doesn't match the PRD interface. The PRD may intend initialisation to happen in the constructor. Document why `open()` was added.

---

#### 🟢 F-16: Local store `downsample()` and `runRetention()` are public but not called from the pipeline

**File:** `src/plugins/outputs/local-store.ts:268, 354`

`downsample()` and `runRetention()` are public methods but are not called from the pipeline's flush cycle or any scheduled maintenance pass. `runRetention()` is called on `connect()` (startup), but the PRD Section 11 says "Retention runs on daily maintenance pass (not per-write)." There is no daily maintenance loop.

For the MVP, calling retention on startup is acceptable. But downsampling has no trigger at all -- it can only be called manually. Either wire it into a daily timer, or document it as a CLI-only operation.

---

#### 🟢 F-17: Local store `close()` silently catches checkpoint errors

**File:** `src/plugins/outputs/local-store.ts:192-198`

```typescript
try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} catch {
  // Ignore checkpoint errors during shutdown
}
```

WAL checkpoint failure during shutdown means data written since the last checkpoint may not be durable. While crashing during shutdown is worse, silently ignoring the error means no one knows data may be at risk. At minimum, log a warning.

---

## PRD Compliance Tables

### Module 3.0: Stdout Output

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| Output interface: connect() | PASS | No-op, correct |
| Output interface: write(batch) | PASS | Formats and prints each metric |
| Output interface: close() | PASS | No-op, correct |
| Format: json (default) | PASS | Default matches PRD |
| Format: line_protocol | PASS | Telegraf-compatible |
| Config field name `data_format` | FAIL | Uses `format`, PRD Appendix A uses `data_format` (F-06) |
| BigInt field handling in JSON | WARN | JSON.stringify will throw on BigInt fields (F-12) |

### Module 3.1: File Output

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| Output interface: connect() | PASS | Creates dir and file |
| Output interface: write(batch) | PASS | Appends correctly |
| Output interface: close() | PASS | Resets state |
| JSON-lines format | PASS | One JSON object per line |
| CSV format | PASS | Header + data rows |
| Append mode (no overwrite) | PASS | Tested |
| Config field name `data_format` | FAIL | Uses `format`, PRD Appendix A uses `data_format` (F-06) |
| CSV new-field handling | WARN | New fields after first batch silently dropped (F-09) |

### Module 3.2: Local Data Store

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| Output interface: connect() | PASS | Creates dir, opens DB |
| Output interface: write(batch) | PASS | Batch insert with transaction |
| Output interface: close() | PASS | WAL checkpoint, close handles |
| Daily file rotation | PASS | Tested including midnight boundary |
| Schema: metrics table | PASS | All columns present |
| Schema: tag_index table | PASS | Upsert works correctly |
| Schema: timestamp precision | FAIL | Nanosecond precision lost via Number() (F-01) |
| WAL mode | PASS | Verified in tests |
| synchronous = NORMAL | PASS | Set in getOrOpenDb() |
| busy_timeout = 5000 | PASS | Set in getOrOpenDb() |
| BEGIN IMMEDIATE transactions | PASS | Bun SQLite default |
| SQLITE_BUSY retry | WARN | Code exists but zero test coverage (F-11) |
| Retention: time-based | PASS | Tested |
| Retention: size-based | PASS | Tested |
| Downsampling | PASS | Tested with 60-point aggregation |
| Downsampling: BigInt fields | FAIL | Silently dropped (F-10) |
| CSV export | WARN | Missing tag columns (F-04) |
| MessagePack encoding | PASS | Round-trip verified |
| Config defaults match PRD Section 11 | PASS | Verified in test |
| tags_hash = FNV-64a of sorted tags | WARN | Uses hashId() which includes name (F-07) |

### Module 3.3: Store-and-Forward Buffer

| PRD Requirement | Status | Notes |
|----------------|--------|-------|
| BufferTransaction.metrics() | FAIL | Named `batch` (property), PRD says `metrics()` (method) (F-03) |
| acceptAll() | PASS | Removes metrics from buffer |
| keepAll() | PASS | No-op, metrics retained |
| accept(indices) | PASS | Partial removal works |
| reject(indices) | PASS | Partial removal works |
| add() persists to SQLite | PASS | Verified |
| beginTransaction() returns oldest N | PASS | Verified |
| Per-output buffer table | PASS | Tested with different aliases |
| Overflow: drop_oldest | PASS | Oldest dropped at limit |
| Overflow: disk_spill | WARN | Identical to drop_oldest in MVP (documented) |
| At-least-once delivery | PASS | Metrics persisted before ack |
| Recovery after crash | PASS | Tested |
| Config defaults match PRD Section 12 | PASS | Verified |
| deleteByIds with batch_size >= 1000 | FAIL | Exceeds SQLITE_MAX_VARIABLE_NUMBER (F-02) |
| metric_buffer_limit min(100) | WARN | Uses min(1), plan says min(100) (F-08) |

---

## Test Coverage Assessment

### Happy Path Coverage: STRONG
All four modules have thorough happy-path tests. JSON serialisation, CSV formatting, daily rotation, buffer transactions, recovery, append mode, and multi-batch operations are well tested.

### Edge Case Coverage: MODERATE
Midnight boundary, empty batches, special characters, and missing fields are tested. CSV quoting and escape are tested.

### Hard Path Coverage: WEAK
The following critical paths have **zero test coverage**:

1. **SQLITE_BUSY retry** (local-store.ts:254) -- The catch block that retries on SQLITE_BUSY has never been triggered in any test
2. **SQLite parameter limit** (store-forward.ts:130-133) -- No test with batch_size >= 1000
3. **BigInt field in JSON output** (stdout.ts:87) -- Will crash, not tested
4. **Nanosecond timestamp precision** -- No test verifies round-trip timestamp fidelity at nanosecond precision
5. **Concurrent add + beginTransaction** -- Listed as a planned test in the phase plan but not implemented
6. **Retention that deletes today's file** -- What happens if retention_days=0 or size limit is below today's file size?
7. **Downsample with non-numeric fields** -- Tested only with numeric; no test verifying bigint or mixed-type handling
8. **Second SQLITE_BUSY failure** (double-retry) -- If the retry at local-store.ts:256 also throws SQLITE_BUSY, the error propagates unhandled

---

## Phase 4 Readiness Assessment

### Can Phase 4 Start?

**No, not until 🔴 findings are resolved.**

- **F-01 (timestamp precision)** affects every metric stored in the local data store. Phase 4 (pipeline integration, CLI) will inherit this corruption. Fix before any production testing.
- **F-02 (SQLite parameter limit)** means the buffer's default configuration will fail at runtime. Any Phase 4 integration test using the buffer with default `metric_batch_size=1000` will crash.
- **F-03 (interface naming)** will cause compile/runtime errors when Phase 4 code calls `tx.metrics()` per the PRD interface.

### Recommended Fix Priority

1. **F-02** (SQLite parameter limit) -- Immediate fix, simple chunking. Add test with 1500 metrics.
2. **F-03** (BufferTransaction interface) -- Quick rename. Update test call sites.
3. **F-01** (timestamp precision) -- Requires investigation into Bun SQLite BigInt support. May need schema or encoding approach change.
4. **F-04** (CSV export tags) -- Important for user value but does not block other modules.
5. **F-06** (config field naming) -- Will cause user confusion but can be fixed later.
6. **F-11** (SQLITE_BUSY test coverage) -- Add tests for untested error paths.
7. **F-07, F-08, F-09, F-10** -- Fix during Phase 4 when context arises.

### What Phase 4 Can Safely Build On

- Stdout output: ready, minor issues only
- File output: ready for non-CSV use; CSV has the frozen-schema limitation
- Local data store: **blocked by F-01** (timestamp precision)
- Store-and-forward buffer: **blocked by F-02 and F-03** (parameter limit and interface naming)
