Read CLAUDE.md for project rules and conventions.

You are implementing Phase 12 (WebUI Redesign — Config-Driven Dashboard & Trend Charts) of CollatrEdge.

## CONTEXT

Phases 0–11 are complete. ~1048 tests, 0 failures (2 skips). All phase plans, reviews, and progress files are in `plans/`.

Phase 12 replaces the hardcoded 4-signal dashboard with a config-driven live overview that reflects the actual configured inputs, and adds a dedicated trend charts page with curated defaults and a metric picker.

Tasks 12.0–12.6 are complete. Tasks 12.7–12.9 are review follow-up items that must be completed before Phase 12 is done:
- **12.7**: Extract duplicate `collectMetricNames()` to shared module (review finding F-02)
- **12.8**: Staleness test imports actual JS module instead of re-implementing (review finding F-04)
- **12.9**: Wire pipeline operational stats (gathered/written/dropped/errors) into the Pipeline Status panel, and filter `agent.*` metrics out of equipment cards

Key reference: the factory simulator packaging profile defines 47 signals across 7 equipment groups (press, laminator, slitter, coder, energy, environment, vibration). The Edge config (`configs/factory-sim-packaging.toml`) maps 78 signal registrations (with Modbus/OPC-UA cross-protocol duplicates). Signal units and types are defined in the Phase 12 plan's signal metadata reference tables.

## CRITICAL: ONE TASK PER SESSION

You MUST implement exactly ONE task per session, then STOP.

1. Read `plans/phase-12-webui-redesign.md` for the full plan (architecture decisions, signal metadata, page designs, task details)
2. Read `plans/phase-12-tasks.json` to find the **first** task with `"passes": false`
3. Read the relevant PRD sections referenced in that task
4. Implement ONLY that single task: write code, write tests, run `bun test test/unit test/integration` — ALL tests must pass
5. Update `plans/phase-12-tasks.json`: set `"passes": true` for your completed task
6. Update `plans/phase-12-progress.md` with what you built and any decisions
7. Commit: `phase-12: <what> (task 12.X)`
8. Do NOT push. Pushing is handled externally.
9. Output TASK_COMPLETE and STOP. Do NOT continue to the next task. The loop script handles iteration.

## PHASE-SPECIFIC RULES

- **No hardcoded signal names in the frontend** — the only place signal names appear statically is the unit/type lookup table in `signal-descriptors.ts`. Everything else is derived from the config at runtime.
- **Reuse existing infrastructure** — the SSE stream, chart data API, ECharts web component, Elysia server, Layout component, and Datastar are all proven. Don't rebuild them.
- **Unknown signals must work** — any signal not in the lookup table must still render with reasonable defaults (equipment from prefix, display name from signal name, no unit, type=numeric).
- **No new npm dependencies** — the trends page metric picker is vanilla JS. No React, no Vue, no framework additions.
- **Rule 7 (YAGNI)** — no multi-series overlay charts, no persistent picker state, no configurable thresholds. Build what the plan specifies.
- **Backward compatibility** — the export endpoint, certificate page, health endpoint, and all existing API routes must continue to work unchanged.

## KEY FILES

- `plans/phase-12-webui-redesign.md` — full plan with signal metadata, page designs, architecture decisions
- `plans/phase-12-tasks.json` — task tracker
- `configs/factory-sim-packaging.toml` — the real config this UI must reflect
- `src/web/views/dashboard.tsx` — current dashboard (to be rewritten in 12.1)
- `src/web/routes/stream.ts` — SSE stream (already sends all metrics)
- `src/web/routes/chart-data.ts` — chart history API (already works for any metric)
- `src/web/adapter.ts` — WebUIAdapter interface
- `src/web/views/layout.tsx` — base layout with CSS
- `src/web/public/components/line-chart.js` — ECharts web component
- `src/web/server.ts` — Elysia HTTP server with route registration
- `prd/17-local-web-ui.md` — PRD spec for the WebUI

## STOPPING RULES

**After completing ONE task:** Output `TASK_COMPLETE` and stop immediately. Do not look for the next task. Do not start another task. The loop script will call you again for the next iteration.

**When ALL tasks have `"passes": true`:** Instead of TASK_COMPLETE, do the following:
1. Do NOT output PHASE_COMPLETE yet.
2. Spawn a sub-agent code review (see CLAUDE.md "Phase Work Pattern" step 4).
3. Write the review to `plans/phase-12-review.md`
4. Address all 🔴 Must Fix findings. Re-run `bun test test/unit test/integration` after each fix.
5. Commit fixes: `phase-12: address code review findings`
6. Push all commits.
7. THEN output: PHASE_COMPLETE
