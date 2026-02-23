# Phase 3: Outputs — Progress

## Status: IN PROGRESS

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 3.0 | Stdout output | ✅ |
| 3.1 | File output (JSON-lines, CSV) | ✅ |
| 3.1i | File output → pipeline integration | ⬜ |
| 3.2 | Local data store (SQLite, rotation, retention) | ⬜ |
| 3.2i | Local store → pipeline integration | ⬜ |
| 3.3 | Store-and-forward buffer | ⬜ |
| 3.3i | S&F buffer + output integration | ⬜ |

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

## Notes

### Dependencies
- `bun:sqlite` — built-in, validated in spike
- `msgpackr` — already in package.json from Phase 1

### Key PRD Sections
- §11 (Local Data Store) — complete section, very detailed
- §12 (Buffers & Delivery Guarantees) — transaction model, overflow policies
- §14 (Error Handling) — output error behaviour, retry, circuit breaking
