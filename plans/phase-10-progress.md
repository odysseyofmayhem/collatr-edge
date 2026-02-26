# Phase 10 Progress — MQTT Data Format Hardening

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 10.0 | PRD Updates | ✅ |
| 10.1 | Add data_format auto and string modes | ✅ |
| 10.2 | Parse error throttling | ⬜ |
| 10.3 | Tests for new data formats and throttling | ⬜ |
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
