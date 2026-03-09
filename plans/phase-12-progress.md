# Phase 12 Progress — WebUI Redesign

## Status: IN PROGRESS

## Overview
Replace hardcoded 4-signal dashboard with config-driven live overview and hybrid trends page.

## Tasks
- [x] 12.0 — Signal descriptor system
- [x] 12.1 — Dashboard page rewrite — equipment cards
- [ ] 12.2 — SSE stream update — dynamic signal names
- [ ] 12.3 — Trends page — hybrid curated + metric picker
- [ ] 12.4 — Staleness detection and visual indicators
- [ ] 12.5 — CSS refinements and responsive layout
- [ ] 12.6 — Integration tests with factory simulator data

## Log

### Task 12.1 — Dashboard page rewrite — equipment cards (complete)
- Rewrote `src/web/views/dashboard.tsx` to be fully config-driven using `buildSignalDescriptors()`
- Created `src/web/views/fragments/signal-value.tsx` — type-aware signal rendering (numeric with units, boolean indicators with alarm-aware colouring, counter with locale formatting, enum badges with label lookup)
- Created `src/web/views/fragments/equipment-card.tsx` — one card per equipment group with signal grid, dryer temp/setpoint pairing, equipment status indicator from running/machine_state signals
- Dynamic Datastar signals initialisation from descriptor list (no hardcoded signal names)
- Metric names sourced from `getLiveMetrics()` + `getLocalStore()?.listMetricNames()` for maximum coverage
- Added nav links: Dashboard (active), Trends, Certificates
- Removed old hardcoded 4-chart layout (collatr-line-chart elements moved to /trends in task 12.3)
- Kept: network policy banner, pipeline status panel, CSV export form, footer
- Exported `toDatastarName()` helper for signal name sanitisation (used by SSE stream in task 12.2)
- Updated integration test `test/integration/web-ui.test.ts` to use dotted metric names (`press.line_speed`, `env.ambient_temp`) and check for equipment cards instead of old chart elements
- 33 unit tests passing, all 1083 non-smoke tests passing

### Task 12.0 — Signal descriptor system (complete)
- Created `src/web/signal-descriptors.ts` with `SignalDescriptor`, `EquipmentGroup` types
- Static lookup table covering all 47 signals across 7 equipment groups (press, laminator, slitter, coder, energy, env, vibration)
- `buildSignalDescriptors()` groups metrics by dotted prefix, assigns metadata from lookup, handles unknown signals with sensible defaults
- Curated `defaultTrendSignals` per equipment group for the trends page
- Machine state enum labels exported for press (6 states) and coder (5 states)
- Unknown equipment groups: capitalised prefix as display name, order=100 (after known), all numeric signals as trend defaults
- 22 unit tests, all passing
