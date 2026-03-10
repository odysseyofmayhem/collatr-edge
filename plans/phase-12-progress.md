# Phase 12 Progress — WebUI Redesign

## Status: IN PROGRESS

## Overview
Replace hardcoded 4-signal dashboard with config-driven live overview and hybrid trends page.

## Tasks
- [x] 12.0 — Signal descriptor system
- [x] 12.1 — Dashboard page rewrite — equipment cards
- [x] 12.2 — SSE stream update — dynamic signal names
- [x] 12.3 — Trends page — hybrid curated + metric picker
- [x] 12.4 — Staleness detection and visual indicators
- [x] 12.5 — CSS refinements and responsive layout
- [x] 12.6 — Integration tests with factory simulator data
- [ ] 12.7 — Review fix: extract duplicate collectMetricNames (F-02)
- [ ] 12.8 — Review fix: staleness test imports actual module (F-04)
- [ ] 12.9 — Pipeline stats in status panel (agent.* metrics)

## Log

### Task 12.6 — Integration tests with factory simulator data (complete)
- Created `test/integration/web-ui-trends.test.ts` with 22 integration tests across 4 describe blocks
- **Dashboard with factory sim data** (5 tests): verifies all 7 equipment group cards present, display names from signal descriptors, Datastar signal bindings with sanitised names, navigation links
- **Trends page** (7 tests): GET /trends returns 200 HTML, equipment section headers, curated default chart elements (press.line_speed, env.ambient_temp etc.), time range buttons, metric picker dropdown, metric-picker.js script inclusion, active nav state
- **Chart metrics API with factory sim data** (2 tests): /api/chart/metrics returns factory sim metric names from local store, /api/chart/history returns data points for press.line_speed
- **Backward compatibility** (8 tests): export endpoint responds correctly (503 without store), certificates page works, chart metrics API returns JSON array, network policy banner visible, pipeline status section present, data export form present, static assets served, SSE stream returns event-stream content type
- All 1155 non-smoke tests passing

### Task 12.5 — CSS refinements and responsive layout (complete)
- Comprehensive CSS overhaul in `layout.tsx` for all Phase 12 components
- **Equipment cards**: full-width with structured header (name + status badge), separator border, 20px padding
- **Signal grid**: 4-column responsive grid (→3 at 1024px, →2 at 768px, →1 at 480px), each signal in a subtle background tile
- **Boolean indicators**: 10px coloured dots (green=ok/on, grey=off, red=alarm) in a flex-wrap row with top border separator
- **Counter formatting**: monospace font stack (SF Mono, Menlo, Consolas)
- **Enum badges**: coloured pill badges — grey (off), amber (setup/standby/maintenance), green (running/printing), blue (ready/idle), red (fault)
- **Equipment status**: inline dot next to header (green=running, red=fault, grey=stopped) via Datastar data-class bindings
- **Navigation**: subtle tab-style links with active state highlight (`.nav-active`), hover background
- **Trends page**: time range button bar, section titles with bottom border, full-width chart cards, dashed-border metric picker dropdown, chart remove button with red hover
- **Print styles**: hides nav, export form, time range bar, metric picker, remove buttons; forces `break-inside: avoid` on cards; 3-column signal grid; preserves banner colours
- All 1133 non-smoke tests passing

### Task 12.4 — Staleness detection and visual indicators (complete)
- Created `src/web/public/components/staleness.js` — client-side module that tracks per-signal last-update times
- Uses MutationObserver on the `[data-signals]` container to detect Datastar signal value changes
- Periodic check every 5s re-evaluates all tracked signals and applies CSS classes
- Three states: `.signal-fresh` (<30s, default), `.signal-stale` (30-60s, amber border), `.signal-dead` (>60s, red border + "No data" indicator)
- Added `data-staleness-signal` attributes to all signal value elements in `signal-value.tsx`: numeric, boolean, counter, enum, and dryer paired values
- Added staleness CSS to `layout.tsx`: amber left border for stale, red left border + opacity reduction for dead, "No data" pseudo-element for dead signals
- Included `staleness.js` script tag in layout HTML
- `classifyStaleness()` pure function exported for testing
- 13 unit tests: 6 for staleness classification logic (fresh/stale/dead boundaries), 5 for data-staleness-signal attributes on all signal types, 2 for CSS/script presence in layout
- All 1134 non-smoke tests passing

### Task 12.3 — Trends page — hybrid curated + metric picker (complete)
- Created `src/web/views/trends.tsx` — config-driven trends page with hybrid approach (AD-4)
- Equipment sections grouped by prefix with curated default charts rendered server-side
- Each chart uses existing `<collatr-line-chart>` web component with metric, colour, unit, height attributes
- Time range selector: Last Hour (default), Last Shift (8h), Last 24h, Last Week
- Created `src/web/public/components/metric-picker.js` — vanilla JS module for client-side metric add/remove:
  - "Add metric" dropdown per equipment section lists remaining numeric signals
  - Selecting appends new chart card with remove button; metric removed from dropdown
  - Remove button deletes chart and re-adds metric to dropdown
  - Time range buttons re-fetch all chart history with updated from/to parameters
- Boolean, counter, and enum signals excluded from both default charts and picker
- Unknown equipment groups show all numeric signals as defaults (no picker if all are defaults)
- Registered `/trends` route in server.ts with text/html response
- Added metric-picker.js to static asset map in server.ts
- 32 tests (29 JSX rendering + 3 HTTP route), all passing
- All 1121 non-smoke tests passing

### Task 12.2 — SSE stream update — dynamic signal names (complete)
- Fixed `flattenMetrics()` signal name mismatch: for single-field metrics where field is `"value"` (the common packaging profile case), signal key is now just the sanitised metric name (e.g. `press_line_speed`) instead of `press_line_speed_value`
- Multi-field metrics or fields not named `"value"` retain the `name_field` format for disambiguation
- This aligns SSE signal names with dashboard `toDatastarName()` — Datastar bindings now receive updates correctly
- Updated all stream tests to use representative packaging profile metrics (`press.line_speed`, `laminator.nip_temp`, `env.ambient_temp`, etc.) instead of old `temperature`/`pressure` names
- Added new test: "SSE signal names match dashboard Datastar signal names" — explicitly verifies no `_value` suffix on single-value metrics
- Added tests for multi-field metric disambiguation and non-"value" field name handling
- 18 stream tests passing, all 1087 non-smoke tests passing

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
