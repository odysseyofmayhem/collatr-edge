# Phase 3: Outputs — Progress

## Status: NOT STARTED

## Tasks
| Task | Description | Status |
|------|-------------|--------|
| 3.0 | Stdout output | ⬜ |
| 3.1 | File output (JSON-lines, CSV) | ⬜ |
| 3.1i | File output → pipeline integration | ⬜ |
| 3.2 | Local data store (SQLite, rotation, retention) | ⬜ |
| 3.2i | Local store → pipeline integration | ⬜ |
| 3.3 | Store-and-forward buffer | ⬜ |
| 3.3i | S&F buffer + output integration | ⬜ |

## Notes

### Dependencies
- `bun:sqlite` — built-in, validated in spike
- `msgpackr` — already in package.json from Phase 1

### Key PRD Sections
- §11 (Local Data Store) — complete section, very detailed
- §12 (Buffers & Delivery Guarantees) — transaction model, overflow policies
- §14 (Error Handling) — output error behaviour, retry, circuit breaking
