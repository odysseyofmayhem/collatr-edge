# Phase 7 Progress: Sparkplug B Hub Link

## Status: NOT STARTED

## Test Baseline
- **560 tests, 0 failures, 4547 assertions** at start of Phase 7
- Commit: `16a143f` on `main`

## Tasks

| Task | Description | Status | Tests Added | Commit |
|------|-------------|--------|-------------|--------|
| 7.0 | sparkplug-payload spike | ⬜ Not started | | |
| 7.1 | Real MQTT client wrapper | ⬜ Not started | | |
| 7.2 | Sparkplug B codec | ⬜ Not started | | |
| 7.3 | Hub link session manager | ⬜ Not started | | |
| 7.4 | MQTT output plugin | ⬜ Not started | | |
| 7.5 | Pipeline integration | ⬜ Not started | | |
| 7.6 | Heartbeat / NDATA | ⬜ Not started | | |
| 7.7 | Integration tests + cleanup | ⬜ Not started | | |

## Notes

- sparkplug-payload must pass Bun spike before any production code (7.0 is a hard gate)
- Task 7.1 (MQTT client) refactors existing code — run all mqtt-consumer tests after
- Task 7.3 (Hub link) is the most complex piece — allocate extra care
- Task 7.5 (pipeline integration) touches multiple existing files — high regression risk
- bdSeq persistence deferred (start at 0 for MVP, TODO for SQLite state)
