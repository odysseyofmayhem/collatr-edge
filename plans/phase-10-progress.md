# Phase 10 Progress — MQTT Data Format Hardening

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 10.0 | PRD Updates | ✅ |
| 10.1 | Add data_format auto and string modes | ✅ |
| 10.2 | Parse error throttling | ✅ |
| 10.3 | Tests for new data formats and throttling | ✅ |
| 10.4 | Smoke test config update | ⬜ |

## Decisions & Notes

### Task 10.0 — PRD Updates
- Updated §19 `mqtt_consumer` notes: expanded to describe all four data_format modes (json, value, string, auto), silent fallback behaviour in auto mode, and parse error throttling for noisy wildcard subscriptions.
- Updated Appendix A config example: added inline comment on `data_format` field listing all options with short descriptions.

### Task 10.1 — Add data_format auto and string modes
- Schema: `data_format` enum expanded from `["json", "value"]` to `["json", "value", "string", "auto"]`, default remains `"json"`.
- Refactored `handleMessage()` payload parsing from if/else to switch covering all four formats.
- `"auto"`: inner try/catch around JSON.parse, silent fallback to value parsing (no error, no log). Binary payloads detected via `\uFFFD`/`\0` skip JSON attempt entirely.
- `"string"`: always `{ value: payloadStr }`, no numeric coercion.
- `"json"`: binary payload detection throws explicit error (will be throttled in 10.2).
- `"value"`: unchanged behaviour.
- All 984 existing tests pass.

### Task 10.2 — Parse error throttling
- Added per-instance throttling fields: `parseErrorCount`, `lastParseErrorLogTime` (Rule 13: per-instance, not global).
- Static constants: `PARSE_ERROR_VERBOSE_LIMIT = 5`, `PARSE_ERROR_SUMMARY_INTERVAL_MS = 60_000`.
- Replaced catch block: first 5 errors logged at `warn` with full context (topic, error, count). After threshold, periodic summary every 60s with total count. Between summaries: silent increment only.
- Downgraded from `error` to `warn` — parse errors from garbage data on wildcard subscriptions are expected noise.
- `acc.addError()` only called for first 5 and once per 60s summary — prevents internal metrics flooding.
- Only applies to `data_format="json"` errors. Auto mode has inner try/catch so JSON failures never reach the outer throttled catch.
- Omitted plan's `since_last_summary` field from summary log — the calculation in the plan was incorrect (always subtracted 5, not count at last summary). `total_errors` is sufficient.
- All 984 existing tests pass.

### Task 10.3 — Tests for new data formats and throttling
- Added 19 new tests across 5 describe groups: auto mode (6), string mode (3), parse error throttling (5), binary payload handling (4), config validation (1).
- Updated existing "invalid JSON payload" test name to document Phase 10 warn-level change (test itself unchanged — first error still within verbose limit, acc.addError() still called).
- Auto mode tests: valid JSON object, JSON primitive, NMEA sentence fallback, numeric fallback ("+42"), binary payload fallback, silent fallback verification (no acc.addError on parse failure).
- String mode tests: text, numeric text with no coercion, empty string.
- Throttling tests: first 5 verbose errors, 6th triggers summary (lastParseErrorLogTime starts at 0), 7th-10th silent, 60s interval summary with total count (Date.now mock), valid messages after errors, per-instance counter isolation (two independent instances).
- Binary tests: all 4 data_format modes — json (error), auto (silent fallback), string (replacement chars), value (NaN → string).
- Total test count: 1003 (984 → 1003). 0 failures.
