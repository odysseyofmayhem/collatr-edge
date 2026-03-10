# Phase 12: WebUI Redesign — Config-Driven Dashboard & Trend Charts

## Goal

Replace the hardcoded 4-signal dashboard with a config-driven live overview that reflects the actual configured inputs, and add a dedicated trend charts page. The current dashboard shows Temperature, Pressure, Line Speed, and Humidity — none of which correspond to signals in the packaging config (or any real config). The redesigned UI must work with any Edge configuration without code changes.

## PRD References

- **§17 Local Web UI** — Dashboard, Live Values, Trend Charts, Design principle
- **§10 Network Policy** — Banner on every page
- **§11 Local Data Store** — Historical queries for trend charts
- **§15 Observability** — Pipeline status, plugin health

## Background: What Exists

The WebUI was built in Phase 9 and works correctly as infrastructure:

- **SSE stream** (`stream.ts`) already sends ALL metrics via `flattenMetrics()` — every signal from every configured input flows through. The limitation is purely in `dashboard.tsx` which only displays 4 hardcoded signals.
- **Chart data API** (`chart-data.ts`) already supports arbitrary metric names — `/api/chart/history?metric=<name>` and `/api/chart/metrics` (lists all available metrics from the local store).
- **ECharts line chart web component** (`line-chart.js`) works for any metric.
- **Adapter** (`adapter.ts`) provides `getLiveMetrics()`, `getPluginHealth()`, `getStatus()`, `getLocalStore()`.
- **Elysia server** with static asset embedding, gzip caching, SSE support.

The TOML config already provides enough structure to build a rich UI. The packaging config (`factory-sim-packaging.toml`) defines 78 signal names across Modbus (holding registers, input registers, coils, discrete inputs), OPC-UA nodes, and MQTT wildcard topics. Signal names follow a `equipment.signal_name` convention (e.g. `press.line_speed`, `laminator.nip_temp`).

## Architecture Decisions

### AD-1: Equipment grouping by metric name prefix

Groups are derived from the first dotted segment of the metric name: `press.*`, `laminator.*`, `slitter.*`, `energy.*`, `coder.*`, `env.*`, `vibration.*`. Zero-config — works with any TOML. No explicit group configuration needed.

### AD-2: Signal metadata from config parsing

A new `getSignalDescriptors()` method on the adapter returns structured metadata about configured signals: name, equipment group, data type (numeric/boolean/counter/enum), and unit. Units are inferred from a static lookup table built from the factory simulator PRD signal tables (the canonical source of truth for signal semantics). Unknown signals get no unit — that's fine.

### AD-3: Landing page is live values, not charts

The PRD §17 calls for "current readings from all connected inputs" with "simple gauges, traffic-light indicators" — the "mini-SCADA view." Charts are secondary. The landing page should give a production manager green/red at a glance. Trend charts move to a dedicated `/trends` page.

### AD-4: Hybrid trend charts — curated defaults + metric picker (Option C)

The `/trends` page uses a hybrid approach. Each equipment group has a curated set of "important" metrics pre-selected by default (line speed, dryer temps, machine state transitions, etc.). Below the default charts, an "Add metric" control lets the user select additional signals from the full list to overlay or add as new charts. This gives immediate value on page load (the interesting signals are already visible) while allowing exploration of the full signal set. The curated defaults are defined in the signal descriptor system alongside the unit/type metadata.

### AD-5: SSE stream sends all signals

The existing `flattenMetrics()` already sends everything. No backend changes needed for the live data feed. The frontend selects which signals to display.

### AD-6: Datastar signals are dynamic

Instead of hardcoding `data-signals="{temperature: '0', ...}"`, the dashboard initialises with a signal object derived from the adapter's signal descriptors at SSR time. New signals appear automatically when the config changes.

### AD-7: Boolean signals rendered as indicators, not values

Signals of type boolean (coils, discrete inputs) render as coloured dots/badges: green for expected state (running=true, fault=false), red for alarm state (fault=true, e-stop=true, web_break=true). Not as "0" / "1" text.

## Signal Metadata Reference

From the factory simulator PRD §2.2-2.9, the packaging profile signals with units:

### Press (21 signals + 9 Modbus-specific)
| Signal | Unit | Type | Notes |
|--------|------|------|-------|
| press.line_speed | m/min | numeric | Web speed |
| press.web_tension | N | numeric | Infeed tension |
| press.registration_error_x | mm | numeric | OPC-UA only |
| press.registration_error_y | mm | numeric | OPC-UA only |
| press.ink_viscosity | s | numeric | Zahn cup |
| press.ink_temperature | °C | numeric | |
| press.dryer_temp_zone_1 | °C | numeric | Actual temp |
| press.dryer_temp_zone_2 | °C | numeric | Actual temp |
| press.dryer_temp_zone_3 | °C | numeric | Actual temp |
| press.dryer_setpoint_zone_1 | °C | numeric | Setpoint |
| press.dryer_setpoint_zone_2 | °C | numeric | Setpoint |
| press.dryer_setpoint_zone_3 | °C | numeric | Setpoint |
| press.impression_count | count | counter | |
| press.good_count | count | counter | |
| press.waste_count | count | counter | |
| press.machine_state | — | enum | 0-5 states |
| press.fault_code | — | enum | |
| press.main_drive_current | A | numeric | |
| press.main_drive_speed | RPM | numeric | |
| press.nip_pressure | bar | numeric | |
| press.unwind_diameter | mm | numeric | |
| press.rewind_diameter | mm | numeric | |
| press.dryer_temp_zone_1_ir | °C | numeric | Input register (Eurotherm) |
| press.dryer_temp_zone_2_ir | °C | numeric | Input register |
| press.dryer_temp_zone_3_ir | °C | numeric | Input register |
| press.ink_temperature_ir | °C | numeric | Input register |
| press.running | — | boolean | Coil |
| press.fault_active | — | boolean | Coil |
| press.emergency_stop | — | boolean | Coil |
| press.web_break | — | boolean | Coil |
| press.guard_door_open | — | boolean | Discrete input |
| press.material_present | — | boolean | Discrete input |
| press.cycle_complete | — | boolean | Discrete input |

### Laminator (5 signals + 4 Modbus-specific)
| Signal | Unit | Type |
|--------|------|------|
| laminator.nip_temp | °C | numeric |
| laminator.nip_pressure | bar | numeric |
| laminator.tunnel_temp | °C | numeric |
| laminator.web_speed | m/min | numeric |
| laminator.adhesive_weight | g/m² | numeric |
| laminator.nip_temp_ir | °C | numeric |
| laminator.tunnel_temp_ir | °C | numeric |
| laminator.running | — | boolean |

### Slitter (3 signals + 1 Modbus-specific)
| Signal | Unit | Type |
|--------|------|------|
| slitter.speed | m/min | numeric |
| slitter.web_tension | N | numeric |
| slitter.reel_count | count | counter |
| slitter.running | — | boolean |

### Coder (11 signals, MQTT)
| Signal | Unit | Type |
|--------|------|------|
| coder.state | — | enum |
| coder.prints_total | count | counter |
| coder.ink_level | % | numeric |
| coder.printhead_temp | °C | numeric |
| coder.ink_pump_speed | RPM | numeric |
| coder.ink_pressure | mbar | numeric |
| coder.ink_viscosity_actual | cP | numeric |
| coder.supply_voltage | V | numeric |
| coder.ink_consumption_ml | ml | counter |
| coder.nozzle_health | % | numeric |
| coder.gutter_fault | — | boolean |

### Environment (2 signals, MQTT)
| Signal | Unit | Type |
|--------|------|------|
| env.ambient_temp | °C | numeric |
| env.ambient_humidity | %RH | numeric |

### Energy (2 signals, Modbus)
| Signal | Unit | Type |
|--------|------|------|
| energy.line_power | kW | numeric |
| energy.cumulative_kwh | kWh | counter |

### Vibration (3 signals, MQTT)
| Signal | Unit | Type |
|--------|------|------|
| vibration.main_drive_x | mm/s | numeric |
| vibration.main_drive_y | mm/s | numeric |
| vibration.main_drive_z | mm/s | numeric |

## Equipment Display Names & Order

| Prefix | Display Name | Render Priority |
|--------|-------------|-----------------|
| press | Flexographic Press | 1 |
| laminator | Laminator | 2 |
| slitter | Slitter | 3 |
| coder | Coder | 4 |
| energy | Energy | 5 |
| env | Environment | 6 |
| vibration | Vibration | 7 |

Unknown prefixes render after these, sorted alphabetically, with the prefix capitalised as the display name.

## Machine State Enum Labels

For `press.machine_state`:
| Value | Label | Colour |
|-------|-------|--------|
| 0 | Off | grey |
| 1 | Setup | amber |
| 2 | Running | green |
| 3 | Idle | blue |
| 4 | Fault | red |
| 5 | Maintenance | amber |

For `coder.state`:
| Value | Label | Colour |
|-------|-------|--------|
| 0 | Off | grey |
| 1 | Ready | blue |
| 2 | Printing | green |
| 3 | Fault | red |
| 4 | Standby | amber |

## Page Designs

### Landing Page (/) — Live Overview

```
+------------------------------------------------------------------+
| CollatrEdge                     [Dashboard] [Trends]   ● Running |
+------------------------------------------------------------------+
| 🔒 STANDALONE — No hub connection configured                     |
+------------------------------------------------------------------+
|                                                                    |
| ┌─ FLEXOGRAPHIC PRESS ──────────────────── ● Running ───────────┐ |
| │                                                                 │ |
| │  Line Speed    Web Tension    Ink Viscosity    Ink Temp         │ |
| │  198.4 m/min   245.2 N       28.3 s           24.1 °C         │ |
| │                                                                 │ |
| │  Dryer Zone 1    Dryer Zone 2    Dryer Zone 3                  │ |
| │  ■ 78.2 / 80 °C  ■ 85.1 / 85 °C  ■ 72.0 / 75 °C             │ |
| │                                                                 │ |
| │  Drive Current  Drive Speed   Nip Pressure                     │ |
| │  45.2 A         1250 RPM      4.8 bar                         │ |
| │                                                                 │ |
| │  Unwind ⬇ 890mm   Rewind ⬆ 420mm                              │ |
| │                                                                 │ |
| │  Impressions: 124,502  Good: 123,115  Waste: 1,387            │ |
| │                                                                 │ |
| │  ● Running  ○ No Fault  ○ No E-Stop  ○ No Web Break           │ |
| └─────────────────────────────────────────────────────────────────┘ |
|                                                                    |
| ┌─ LAMINATOR ──────────────────────────── ● Running ────────────┐ |
| │  Nip Temp      Tunnel Temp    Web Speed    Adhesive Weight     │ |
| │  55.2 °C       65.1 °C       197.8 m/min  2.8 g/m²           │ |
| │  Nip Pressure                                                  │ |
| │  4.2 bar                                                       │ |
| └─────────────────────────────────────────────────────────────────┘ |
|                                                                    |
| ┌─ SLITTER ────────────────────────────── ○ Stopped ────────────┐ |
| │  Speed          Web Tension    Reel Count                      │ |
| │  0.0 m/min      0.0 N         47                              │ |
| └─────────────────────────────────────────────────────────────────┘ |
|                                                                    |
| ... (Coder, Energy, Environment, Vibration cards) ...             |
|                                                                    |
| ┌─ PIPELINE STATUS ────────────────────────────────────────────┐  |
| │  Uptime: 2h 14m 32s   Heap: 42 MB   RSS: 98 MB              │  |
| │  Plugin | Type   | Status | Last Activity                    │  |
| │  ...    | ...    | ...    | ...                               │  |
| └──────────────────────────────────────────────────────────────┘  |
|                                                                    |
| ┌─ DATA EXPORT ────────────────────────────────────────────────┐  |
| │  From: [____]  To: [____]  [Export CSV]                       │  |
| └──────────────────────────────────────────────────────────────┘  |
|                                                                    |
| CollatrEdge v0.1.0 — running                                     |
+------------------------------------------------------------------+
```

Key design points:
- One card per equipment group, auto-generated from config
- Equipment status derived from running/state signals where available
- Dryer zones show actual vs setpoint when both signals exist (temp/setpoint pairing)
- Boolean indicators use coloured dots with descriptive text
- Counters formatted with comma separators
- All values update live via SSE
- Staleness detection: values go amber after 30s no update, red after 60s

### Trends Page (/trends) — Historical Charts (Hybrid: Curated + Picker)

```
+------------------------------------------------------------------+
| CollatrEdge                     [Dashboard] [Trends]   ● Running |
+------------------------------------------------------------------+
|                                                                    |
| Time Range: [Last Hour ▾]  [Last Shift] [Last 24h] [Last Week]  |
|                                                                    |
| ── FLEXOGRAPHIC PRESS ──────────────────────────────────────────  |
|                                                                    |
| ┌─ Line Speed (m/min) ─────────────────────────────────────────┐ |
| │  [~~~~~~~~~~~~chart~~~~~~~~~~~~]                               │ |
| └────────────────────────────────────────────────────────────────┘ |
| ┌─ Web Tension (N) ────────────────────────────────────────────┐  |
| │  [~~~~~~~~~~~~chart~~~~~~~~~~~~]                               │ |
| └────────────────────────────────────────────────────────────────┘ |
| ┌─ Dryer Zone 1 Temperature (°C) ──────────────────────────────┐  |
| │  [~~~~~~~~~~~~chart~~~~~~~~~~~~]                               │ |
| └────────────────────────────────────────────────────────────────┘ |
|                                                                    |
| [+ Add metric ▾]  ← dropdown of remaining press signals          |
|   ☐ Ink Viscosity (s)                                             |
|   ☐ Ink Temperature (°C)                                         |
|   ☐ Main Drive Current (A)                                       |
|   ☐ Nip Pressure (bar)                                           |
|   ... more ...                                                    |
|                                                                    |
| ── LAMINATOR ────────────────────────────────────────────────────  |
|                                                                    |
| ┌─ Nip Temperature (°C) ──────────────────────────────────────┐  |
| │  [~~~~~~~~~~~~chart~~~~~~~~~~~~]                               │ |
| └────────────────────────────────────────────────────────────────┘ |
| ┌─ Web Speed (m/min) ─────────────────────────────────────────┐   |
| │  [~~~~~~~~~~~~chart~~~~~~~~~~~~]                               │ |
| └────────────────────────────────────────────────────────────────┘ |
|                                                                    |
| [+ Add metric ▾]                                                  |
|                                                                    |
| ... (Slitter, Coder, Energy, Environment, Vibration) ...         |
|                                                                    |
| CollatrEdge v0.1.0 — running                                     |
+------------------------------------------------------------------+
```

Key design points:
- **Curated defaults** per equipment group render on page load (the most operationally important signals)
- **"Add metric" dropdown** per equipment group lists remaining numeric signals not in the defaults
- Selecting a metric from the dropdown appends a new chart below the defaults
- Added charts can be removed with an ✕ button on the chart card
- Grouped by equipment prefix
- Time range selector (all charts share the same range)
- Boolean and counter signals excluded from charts (meaningless as line charts)
- Each chart uses the existing `<collatr-line-chart>` web component
- Add metric state is client-side only (no persistence) — page reload resets to defaults

**Curated default metrics per equipment group:**

| Equipment | Default Signals | Rationale |
|-----------|----------------|-----------|
| Press | line_speed, web_tension, dryer_temp_zone_1 | Core process: speed, tension, thermal |
| Laminator | nip_temp, web_speed | Thermal + speed tracking |
| Slitter | speed, web_tension | Core operating signals |
| Coder | ink_level, printhead_temp | Consumable + thermal |
| Energy | line_power | Power draw = activity proxy |
| Environment | ambient_temp, ambient_humidity | Both signals (only 2) |
| Vibration | main_drive_x | Primary axis, others available via picker |

Unknown equipment groups: show all numeric signals by default (no curation possible).

## Tasks

### Task 12.0: Signal descriptor system

**Files:** `src/web/signal-descriptors.ts` (new)

Create the signal metadata system:

1. Define `SignalDescriptor` type:
   ```typescript
   interface SignalDescriptor {
     name: string;          // Full signal name, e.g. "press.line_speed"
     equipment: string;     // Equipment prefix, e.g. "press"
     signal: string;        // Signal portion, e.g. "line_speed"
     displayName: string;   // Human-readable, e.g. "Line Speed"
     unit: string;          // e.g. "m/min", "°C", "" for unitless
     type: "numeric" | "boolean" | "counter" | "enum";
     category: "process" | "status" | "counter" | "environmental";
   }
   ```

2. Define `EquipmentGroup` type:
   ```typescript
   interface EquipmentGroup {
     id: string;            // Equipment prefix
     displayName: string;   // Human-readable name
     order: number;         // Render priority
     signals: SignalDescriptor[];
   }
   ```

3. Build the static unit/type lookup table from the signal metadata reference above.

4. Define `defaultTrendSignals` per equipment group — the curated list of signals that appear by default on the trends page (see Curated Default Metrics table in Page Designs). Stored as a `Map<string, string[]>` mapping equipment prefix to signal names (without prefix).

5. Implement `buildSignalDescriptors(metricNames: string[]): EquipmentGroup[]` — takes a list of metric names (from the adapter's live metrics or local store) and returns grouped, ordered equipment groups with signal descriptors. Each `EquipmentGroup` includes a `defaultTrendSignals: string[]` property listing the full signal names that should render by default on the trends page.

6. The function must handle unknown signals gracefully: derive equipment from prefix, display name from signal name (replace underscores with spaces, title case), type defaults to "numeric", unit defaults to "". Unknown equipment groups show all numeric signals as trend defaults.

**Tests:** Unit tests for `buildSignalDescriptors()` — known signals get correct metadata, unknown signals get reasonable defaults, grouping and ordering work correctly, empty input returns empty array, default trend signals populated correctly for known and unknown equipment.

### Task 12.1: Dashboard page rewrite — equipment cards

**Files:** `src/web/views/dashboard.tsx` (rewrite), `src/web/views/fragments/equipment-card.tsx` (new), `src/web/views/fragments/signal-value.tsx` (new)

Rewrite the dashboard page:

1. **Equipment cards**: One card per equipment group. Server-rendered from signal descriptors. Each card shows:
   - Equipment name + status indicator (derived from `*.running` or `*.machine_state` boolean/enum signals)
   - All numeric signals: label, value, unit
   - All boolean signals: coloured indicator dot + label
   - Counter signals: value with comma formatting
   - Enum signals (machine_state, coder.state): state label + coloured badge

2. **Dryer temp/setpoint pairing**: When both `dryer_temp_zone_N` and `dryer_setpoint_zone_N` exist, render as "78.2 / 80 °C" (actual / setpoint).

3. **Signal value component**: Reusable fragment that renders a signal value based on its type (numeric with unit, boolean indicator, counter, enum badge).

4. **Datastar signals initialisation**: Build the `data-signals` attribute dynamically from the signal descriptor list. Each signal becomes a Datastar signal with initial value "—".

5. **Navigation**: Add nav links for Dashboard (active) and Trends.

6. **Keep existing elements**: Network policy banner, pipeline status card, data export form, footer.

7. **Remove**: The 4 hardcoded trend charts from the landing page.

**Tests:** Update `test/unit/web/views/dashboard.test.ts` — verify HTML output contains equipment group cards, signal labels, correct data-text attributes for Datastar binding, navigation links.

### Task 12.2: SSE stream update — dynamic signal names

**Files:** `src/web/routes/stream.ts` (modify)

The existing `flattenMetrics()` already sends all metrics. This task ensures the signal names in the SSE stream match the Datastar signal names used in the new dashboard.

1. Review `flattenMetrics()` — the existing `sanitiseSignalName()` converts `press.line_speed` → `press_line_speed`. Verify this matches the signal names used in dashboard data-text attributes.

2. Ensure `chartTs` is still emitted for the trends page.

3. If any signal name mapping divergences exist between the SSE stream and the dashboard, fix them.

This task may be a no-op if the existing stream output already matches. Verify and document.

**Tests:** Update stream tests to verify signal names for representative packaging profile metrics (not just the old temperature/pressure/lineSpeed/humidity).

### Task 12.3: Trends page — hybrid curated + metric picker

**Files:** `src/web/views/trends.tsx` (new), `src/web/public/components/metric-picker.js` (new), `src/web/server.ts` (add route)

Build the trends page with the hybrid approach (Option C):

1. **Route**: Add `GET /trends` to the Elysia server.

2. **Page component**: `TrendsPage` queries the adapter for available metric names (from the local store via `getLocalStore()?.listMetricNames()`), groups them by equipment using `buildSignalDescriptors()`, and renders:
   - **Default charts**: One chart per curated default signal (from `EquipmentGroup.defaultTrendSignals`). These render server-side and load history on `connectedCallback`.
   - **"Add metric" dropdown**: Per equipment section. Lists all remaining numeric signals for that group (those not in the defaults). Selecting one dynamically appends a new `<collatr-line-chart>` element to the section.

3. **Time range selector**: Client-side buttons that re-fetch chart data with different `from` parameters: Last Hour, Last Shift (8h), Last 24h, Last Week. Default: Last Hour. Changing the range triggers `_loadHistory()` on all visible chart elements with updated `from`/`to` query parameters.

4. **Chart rendering**: Reuse the existing `<collatr-line-chart>` web component. Each chart gets:
   - `metric` attribute: the metric name for `/api/chart/history`
   - `color` attribute: assign from a palette per equipment group
   - `unit` attribute: from signal descriptor
   - `height`: 200px

5. **Metric picker component**: `metric-picker.js` — a lightweight vanilla JS module (no web component needed, just functions):
   - Renders a `<select>` or button+dropdown per equipment section
   - On selection: creates a new chart card `<div>` with a `<collatr-line-chart>` element and an ✕ remove button
   - Appends the card to the equipment section
   - Removes the selected metric from the dropdown (can't add duplicates)
   - On ✕ click: removes the chart card and re-adds the metric to the dropdown
   - State is client-side only — page reload resets to defaults

6. **Equipment sections**: Collapsible sections per equipment group. Equipment header with group name. Default: all expanded.

7. **Excluded signals**: Boolean and counter type signals are excluded from both default charts and the picker dropdown.

8. **Live updates**: The trends page does NOT use SSE for live point appending. It loads historical data on page load and when the time range changes. The dashboard is for live monitoring; trends is for historical analysis.

9. **Navigation**: Dashboard and Trends links, Trends active.

10. **Layout**: Reuse the existing `Layout` component.

**Tests:** Unit test for `TrendsPage` — verify HTML contains chart elements for default signals with correct metric/unit attributes, excludes boolean signals, has time range controls, has "add metric" dropdown with non-default signals listed. Integration test that the `/trends` route returns 200 with correct content type.

### Task 12.4: Staleness detection and visual indicators

**Files:** `src/web/views/fragments/signal-value.tsx` (modify), `src/web/public/components/staleness.js` (new)

Add staleness detection so a production manager can see at a glance which signals are healthy:

1. **Per-signal timestamp tracking**: The SSE stream already sends `chartTs` as a global timestamp. Extend to track per-signal last-update time. Add a new signal `_lastUpdate_<signalName>` (or use a client-side approach with a small JS module that tracks when each signal value last changed).

2. **Visual staleness states**:
   - Fresh (< 30s since last change): default colour
   - Stale (30-60s): amber text/border
   - Dead (> 60s): red text/border + "No data" indicator

3. **Implementation**: A lightweight client-side JS module that observes Datastar signal changes and applies CSS classes to parent elements. Uses `requestAnimationFrame` or `setInterval(5000)` to update staleness state.

4. **CSS classes**: `.signal-fresh`, `.signal-stale`, `.signal-dead` with appropriate colours.

**Tests:** Unit test for the staleness logic (given timestamps, returns correct state). Visual rendering tested as part of dashboard test.

### Task 12.5: CSS refinements and responsive layout

**Files:** `src/web/views/layout.tsx` (CSS update)

Update the CSS for the new layout:

1. **Equipment cards**: Styled consistently. Full-width cards (not 2-column grid — equipment cards contain too many signals for half-width). Card header with equipment name and status badge.

2. **Signal grid within cards**: 3-4 column responsive grid for signal values. Collapses to 2 columns on tablet, 1 on mobile.

3. **Boolean indicators**: Small coloured dots (10px) with hover tooltip showing signal name.

4. **Counter formatting**: Tabular numeric font, comma-separated thousands.

5. **Enum badges**: Coloured pill badges matching the state colour table.

6. **Navigation bar**: Subtle tabs/links in the header.

7. **Trends page**: Full-width charts with subtle section dividers between equipment groups.

8. **Print-friendly**: Basic print styles so the dashboard can be printed for audits (PRD §17 mentions BRC assessors reviewing printable summaries).

**Tests:** Visual inspection (no automated CSS tests). Verify HTML structure supports the CSS classes in dashboard/trends tests.

### Task 12.6: Integration test with factory simulator data

**Files:** `test/integration/web-ui.test.ts` (update), `test/integration/web-ui-trends.test.ts` (new)

Update integration tests:

1. **Dashboard test**: Start a pipeline with the packaging config (or a subset that exercises multiple equipment groups). Verify the dashboard HTML includes equipment cards for press, laminator, slitter. Verify signal names are present in the HTML. Verify SSE stream sends signals matching the config.

2. **Trends page test**: Verify `/trends` returns HTML with chart elements. Verify `/api/chart/metrics` returns metric names matching the config. Verify `/api/chart/history` returns data for a known metric.

3. **Backward compatibility**: Ensure the export endpoint, certificate page, and health endpoint still work.

**Tests:** Integration tests using the existing test pipeline setup pattern.

## Task Dependencies

```
12.0 (signal descriptors)
  ├──> 12.1 (dashboard rewrite)
  │      └──> 12.2 (SSE stream verification)
  │      └──> 12.4 (staleness detection)
  ├──> 12.3 (trends page)
  └──> 12.5 (CSS refinements) — can start after 12.1
  
12.6 (integration tests) — after 12.1 + 12.3
```

Tasks 12.1 and 12.3 can proceed in parallel after 12.0. Task 12.5 can be done alongside or after 12.1.

## Acceptance Criteria

1. The dashboard shows live values for ALL configured inputs, grouped by equipment
2. No hardcoded signal names anywhere in the frontend (except the unit/type lookup table in `signal-descriptors.ts`)
3. Boolean signals render as coloured indicators, not raw 0/1 values
4. Enum signals (machine_state, coder.state) show human-readable labels
5. Counter signals show comma-formatted values
6. The trends page shows historical charts for all numeric signals, grouped by equipment
7. Both pages have navigation to switch between them
8. The UI works with any valid Edge config, not just the packaging config
9. All existing tests pass (1048+)
10. New tests for signal descriptors, dashboard rendering, trends page, and integration

## Risks

1. **MQTT signal names are dynamic** — MQTT signals arrive from wildcard topic subscriptions. Their names aren't in the config the same way Modbus/OPC-UA are. They'll appear in `getLiveMetrics()` once data arrives. The signal descriptor system handles this via the "unknown signal" fallback path.

2. **Large number of signals may crowd the UI** — The packaging config has 78 signal registrations (many are duplicates across Modbus + OPC-UA). Deduplication: the adapter's `getLiveMetrics()` already deduplicates by metric name. The equipment card layout handles 20+ signals per group through the responsive grid.

3. **ECharts bundle size** — Already loaded (598KB gzipped). No additional concern for the trends page since it uses the same `<collatr-line-chart>` component.

### Task 12.7: Review fix — extract duplicate collectMetricNames (F-02)

**Files:** `src/web/views/dashboard.tsx`, `src/web/views/trends.tsx`

Extract the duplicate `collectMetricNames()` function into a shared module. Both `dashboard.tsx` and `trends.tsx` contain identical implementations. Move to `src/web/signal-descriptors.ts` (alongside `buildSignalDescriptors` which it naturally feeds into) or a new `src/web/adapter-helpers.ts`. Both consumer files must import from the shared location.

**Tests:** Verify existing tests still pass — no new tests needed since the function behaviour is unchanged.

### Task 12.8: Review fix — staleness test imports actual module (F-04)

**Files:** `test/unit/web/staleness.test.ts`, `src/web/public/components/staleness.js`

The staleness test re-implements `classifyStaleness()` in TypeScript instead of importing it from the actual `staleness.js` module. The JS file already exports via `module.exports` (line 159-161) for exactly this purpose. Update the test to `require()` the real function. If Bun's test runner has issues with the `document` guard in the module, mock `document` as undefined.

**Tests:** The existing staleness classification tests must pass using the imported function rather than the re-implementation.

### Task 12.9: Pipeline stats in status panel (agent.* metrics)

**Files:** `src/web/adapter.ts`, `src/web/views/dashboard.tsx`, `src/web/views/fragments/status-panel.tsx`, `src/web/views/fragments/equipment-card.tsx`

The dashboard currently shows Uptime, Heap, and RSS in the Pipeline Status panel — but the operational counters (Metrics Gathered, Metrics Written, Metrics Dropped, Gather Errors, Write Errors) are missing. The `StatsCollector` interface in `src/core/stats.ts` already tracks these values, and the `InternalInput` plugin emits them as `agent.*` metrics.

The problem is two-fold:
1. The WebUIAdapter doesn't expose `StatsCollector` — it only has `getMemoryUsage()` and `getUptime()`
2. The `agent.*` metrics appear as an "Agent" equipment group in the equipment cards, where they don't belong — they're internal observability, not production data

Fix:
1. Add `getStats(): StatsCollector | null` to the `WebUIAdapter` interface
2. Wire it from `PipelineWebUIAdapter` constructor (accept `StatsCollector` parameter)
3. Render the counters in the Pipeline Status panel: Metrics Gathered, Metrics Written, Metrics Dropped, Gather Errors, Write Errors — formatted as simple value cards alongside the existing Uptime/Heap/RSS
4. Update `StatusPanelFragment` (SSE) to include the counters so they update live
5. Filter `agent.*` metrics out of `collectMetricNames()` so they don't appear as equipment cards
6. Add `agent.*` signal descriptors to the lookup table with appropriate metadata (for the internal metrics that still flow through the store for export/history)

**Tests:** Unit tests for the status panel rendering with stats. Verify `agent.*` metrics are excluded from equipment cards. Integration test that stats appear in the pipeline status section.

## Non-Goals (deferred)

- Multi-series overlay charts (e.g. 3 dryer zones on one chart)
- Persistent metric picker state (current selections lost on page reload)
- Threshold configuration in the UI (traffic-light with configurable thresholds)
- Signal grouping configuration (beyond auto-prefix)
- Sparkplug/Hub-aware features (Ghost Features from PRD §17)
