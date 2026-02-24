# Phase 8.5 Progress: Pre-Web-UI Hardening

## Status: IN PROGRESS

## Baseline
- **Starting commit:** `27cc6fc` (Phase 8 fix pass 2)
- **Starting tests:** 790 pass, 0 failures
- **Plan:** `plans/phase-8.5-hardening.md`
- **Tasks:** `plans/phase-8.5-tasks.json`

## Tasks

| Task | Description | Status | Tests | Commit |
|------|-------------|--------|-------|--------|
| 8.5.0 | Ticker clock jump warning log | ✅ Done | 790 pass, 0 fail | `556c151` |
| 8.5.1 | swVersion from package.json | ✅ Done | 790 pass, 0 fail | `52b9f1f` |
| 8.5.2 | parseMqttServerUrl IPv6 tests | ⬜ Not started | — | — |
| 8.5.3 | Structured ConfigWarning type | ⬜ Not started | — | — |
| 8.5.4 | Plugin metadata in runtime logs | ⬜ Not started | — | — |

## Deferred
- 8.5.5 (integrity_check_on_startup agent-level) removed — config refactor, not blocking Phase 9. Moved to post-MVP backlog.

## Notes

Phase 8 gate review: GO for Phase 9. Phase 8.5 addresses Tier 1 + Tier 2 quick wins before building the Web UI. All deferred items comprehensively logged in `plans/post-mvp-backlog.md`.
