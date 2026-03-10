# Phase 12: WebUI Redesign -- Code Review

**Reviewer:** Claude Code (fresh context, separate from implementing agent)
**Date:** 2026-03-10
**Phase plan:** `plans/phase-12-webui-redesign.md`
**PRD refs:** SS17 Local Web UI, SS10 Network Policy, SS11 Local Data Store

---

## Executive Summary

Phase 12 replaces the hardcoded 4-signal dashboard with a config-driven, equipment-grouped live overview and adds a dedicated `/trends` page. The implementation is well-structured, closely follows the phase plan, and the test suite is thorough. One must-fix issue: `staleness.js` is not registered in the server's static asset map, so it will 404 at runtime. Several should-fix items around code duplication and hardcoded values.

**Test results:** 265 web-related tests pass, 0 failures.

---

## Findings

### Must Fix

**F-01: `staleness.js` missing from server static asset map**
Severity: **Must Fix**
Files: `src/web/server.ts`, `src/web/views/layout.tsx`

`layout.tsx` line 32 emits `<script type="module" src="/static/components/staleness.js"></script>`, and the file exists at `src/web/public/components/staleness.js`. However, `server.ts` does NOT import it with `{ type: "file" }` and does NOT add it to `ASSET_MAP`. The existing asset map entries are:

```
datastar.js, echarts.min.js, components/line-chart.js, components/metric-picker.js
```

`components/staleness.js` is missing. Requesting `/static/components/staleness.js` will return a **404 response**, meaning staleness detection is completely non-functional at runtime. All of the staleness CSS classes (`signal-fresh`, `signal-stale`, `signal-dead`) will never be applied.

This is a silent failure -- no error in the console (the browser will log a 404 on the module script load but the dashboard will otherwise appear to work normally, just without staleness indication).

**Fix:** Add to `server.ts`:
```typescript
import stalenessPath from "./public/components/staleness.js" with { type: "file" };
// and in ASSET_MAP:
"components/staleness.js": stalenessPath as string,
```

---

### Should Fix

**F-02: Duplicated `collectMetricNames()` function**
Severity: **Should Fix**
Files: `src/web/views/dashboard.tsx` (line 149), `src/web/views/trends.tsx` (line 60)

These two files contain identical `collectMetricNames()` functions (same signature, same body). This violates DRY and creates a maintenance risk -- a bug fix in one copy could miss the other.

**Fix:** Extract to a shared module (e.g., `src/web/adapter-helpers.ts` or export from `signal-descriptors.ts`).

---

**F-03: Hardcoded version string "v0.1.0" in page footers**
Severity: **Should Fix**
Files: `src/web/views/dashboard.tsx` (line 258), `src/web/views/trends.tsx` (line 230)

Both pages hardcode `CollatrEdge v0.1.0` in their footers. This should come from `package.json` or a build-time constant. When the version changes, these will silently remain at "0.1.0".

This is a Rule 10 concern (no hardcoded config overrides). While technically cosmetic, it will cause user-visible incorrect information.

**Fix:** Import version from `package.json` or pass it through the adapter.

---

**F-04: Staleness test duplicates classification logic instead of importing it**
Severity: **Should Fix**
Files: `test/unit/web/staleness.test.ts` (lines 15-22), `src/web/public/components/staleness.js`

The test file re-implements `classifyStaleness()` in TypeScript rather than importing the actual function from `staleness.js`. The comment acknowledges this ("We re-implement the logic here to test thresholds since the JS module is a browser module with DOM dependencies").

The `staleness.js` file does export via `module.exports` at line 159-161 for exactly this purpose, but the test ignores it. If the logic in `staleness.js` diverges from the re-implementation (e.g., thresholds change), the tests would still pass while the actual code is wrong.

**Fix:** Import the actual function from the JS module. The CommonJS export already exists. If Bun's test runner has issues with the `document` guard, mock `document` as undefined.

---

**F-05: SSE stream interval constants are hardcoded, not configurable**
Severity: **Should Fix (Priority 2)**
Files: `src/web/routes/stream.ts` (lines 85-86)

`SIGNAL_INTERVAL_MS = 1000` and `ELEMENT_INTERVAL_MS = 2000` are module-level constants. These are reasonable defaults, but per Rule 10, if the PRD envisions these as tunable (especially for resource-constrained Raspberry Pi targets), they should be wirable from config.

This is a lower priority since the PRD does not explicitly define these as configurable, but the pattern of hardcoding timing values has been flagged in prior phase reviews.

---

**F-06: Staleness thresholds (30s/60s) are hardcoded in client-side JS**
Severity: **Should Fix (Priority 2)**
Files: `src/web/public/components/staleness.js` (lines 16-18)

The phase plan (Task 12.4) specifies "Fresh < 30s, Stale 30-60s, Dead > 60s" and the implementation matches. However, these are hardcoded in the JS with no mechanism to override them from config. For inputs with different polling intervals (e.g., MQTT at 60s publish rate vs Modbus at 1s), a 30s "stale" threshold may cause false staleness warnings on slow-publishing signals.

This is a known limitation and the plan acknowledges it as deferred. Noting it for awareness.

---

### Nice to Have

**F-07: StatusBadge logic duplicated between dashboard.tsx and trends.tsx**
Severity: **Nice to Have**
Files: `src/web/views/dashboard.tsx` (lines 70-83), `src/web/views/trends.tsx` (lines 193-200)

The dashboard has a `StatusBadge` component, while the trends page inlines the same status label logic. Extracting the status badge to a shared fragment would reduce duplication.

---

**F-08: Trends page `colourOffset` mutation pattern**
Severity: **Nice to Have**
Files: `src/web/views/trends.tsx` (lines 178, 222-224)

The `TrendsPage` function uses a mutable `let colourOffset = 0` that is mutated inside the `groups.map()` callback. While this works because JSX rendering is synchronous, it is a side-effectful pattern inside what looks like a pure map operation. A `reduce` or pre-computed offset array would be cleaner.

---

**F-09: `metric-picker.js` does not handle the case where `chart.data` or `chart.maxPoints` are undefined**
Severity: **Nice to Have**
Files: `src/web/public/components/metric-picker.js` (lines 176-179)

```js
chart.data = points.map(p => [p.timestamp, p.value])
if (chart.data.length > chart.maxPoints) {
  chart.data = chart.data.slice(chart.data.length - chart.maxPoints)
}
```

If `chart.maxPoints` is undefined (which it may be before the web component's `connectedCallback` runs), the comparison `chart.data.length > undefined` evaluates to false, which happens to be the safe behaviour. But relying on undefined comparison for correctness is fragile.

---

**F-10: `escapeHtml` in metric-picker.js uses DOM for escaping**
Severity: **Nice to Have**
Files: `src/web/public/components/metric-picker.js` (lines 191-195)

The `escapeHtml` function creates a temporary DOM element for escaping. This is a valid pattern for browser code, but it creates a new element per call. For the expected call volume (handful of metric additions), this is fine. No action needed -- just noting the pattern.

---

## PRD Compliance Table

### signal-descriptors.ts (Task 12.0)

| Requirement | Status | Notes |
|---|---|---|
| SignalDescriptor interface fields | PASS | All 7 fields present and match plan |
| EquipmentGroup interface fields | PASS | Includes `defaultTrendSignals` |
| Static unit/type lookup table | PASS | All 78 signals from plan SS2.2-2.9 present |
| Equipment display names and order | PASS | 7 known groups with correct names/priority |
| Default trend signals per group | PASS | Matches curated defaults table in plan |
| Unknown signal graceful handling | PASS | Defaults to numeric, title-cased name |
| Unknown equipment show all numeric defaults | PASS | Correctly falls through |
| Machine state enum labels (0-5) | PASS | Matches plan colour table |
| Coder state enum labels (0-4) | PASS | Matches plan colour table |

### dashboard.tsx (Task 12.1)

| Requirement | Status | Notes |
|---|---|---|
| Equipment cards from config | PASS | One card per group, auto-generated |
| Dynamic data-signals init | PASS | Built from signal descriptors |
| Numeric signals with unit | PASS | Label + data-text + unit span |
| Boolean indicators (AD-7) | PASS | Alarm-aware colouring |
| Counter formatting (comma) | PASS | Uses toLocaleString expression |
| Enum badges with labels | PASS | Inline lookup expression |
| Dryer temp/setpoint pairing | PASS | Paired rendering when both exist |
| Equipment status indicator | PASS | From running/machine_state signals |
| Navigation links | PASS | Dashboard (active), Trends, Certificates |
| Network policy banner (SS10) | PASS | Standalone/local_network/connected |
| Pipeline status card | PASS | Retained from Phase 9 |
| Data export form | PASS | Retained from Phase 9 |
| No hardcoded trend charts | PASS | collatr-line-chart absent from dashboard |
| Empty state handling | PASS | "No signals yet" placeholder |

### equipment-card.tsx (Task 12.1)

| Requirement | Status | Notes |
|---|---|---|
| Signal type partitioning | PASS | Numeric, boolean, counter, enum separated |
| Dryer pair detection | PASS | Matches zone N temp + setpoint |
| Equipment status from signals | PASS | machine_state or running boolean |

### signal-value.tsx (Task 12.1)

| Requirement | Status | Notes |
|---|---|---|
| toDatastarName matches stream.ts sanitisation | PASS | Same regex: `/[^a-zA-Z0-9_]/g` -> `_` |
| Staleness data attributes | PASS | `data-staleness-signal` on all types |
| Alarm-aware boolean colouring | PASS | ALARM_WHEN_TRUE set correct |

### stream.ts (Task 12.2)

| Requirement | Status | Notes |
|---|---|---|
| Signal name alignment with dashboard | PASS | Single "value" field uses metric name only |
| chartTs still emitted | PASS | Present in flattenMetrics |
| Multi-field metrics use name_field format | PASS | Correct disambiguation |
| Float rounding to 2dp | PASS | Math.round(value * 100) / 100 |

### trends.tsx (Task 12.3)

| Requirement | Status | Notes |
|---|---|---|
| Route GET /trends | PASS | Added to server.ts |
| Default charts from curated signals | PASS | Uses defaultTrendSignals |
| Metric picker dropdown per group | PASS | Lists non-default numeric signals |
| Time range selector buttons | PASS | 1h, 8h, 24h, 168h |
| Boolean/counter signals excluded | PASS | Filtered to numeric only |
| collatr-line-chart with metric/color/unit/height | PASS | All attributes set |
| Equipment sections with headers | PASS | Ordered by priority |
| Navigation with Trends active | PASS | nav-active on /trends |
| Empty state | PASS | "No metrics yet" placeholder |
| No SSE on trends page | PASS | No data-init or stream reference |

### server.ts (Task 12.3)

| Requirement | Status | Notes |
|---|---|---|
| /trends route added | PASS | Returns HTML with text/html |
| metric-picker.js in ASSET_MAP | PASS | Imported and registered |
| staleness.js in ASSET_MAP | **FAIL** | **Missing -- see F-01** |

### staleness.js (Task 12.4)

| Requirement | Status | Notes |
|---|---|---|
| Per-signal timestamp tracking | PASS | MutationObserver + lastChanged map |
| Fresh/stale/dead classification | PASS | 30s/60s thresholds |
| CSS class application | PASS | signal-fresh/stale/dead |
| Periodic check interval | PASS | 5s setInterval |
| Initialisation on DOMContentLoaded | PASS | Correct guard |
| **Served to browser** | **FAIL** | **404 due to missing ASSET_MAP entry** |

### layout.tsx CSS (Task 12.5)

| Requirement | Status | Notes |
|---|---|---|
| Equipment card styles | PASS | Full-width, card-header, structured |
| Signal grid responsive | PASS | 4col -> 3col -> 2col -> 1col |
| Boolean indicator dots (10px) | PASS | bool-dot styling |
| Counter monospace font | PASS | SF Mono/Menlo/Consolas |
| Enum badge pill styles | PASS | Grey/amber/green/blue/red |
| Navigation bar styles | PASS | Subtle tabs with active state |
| Staleness CSS classes | PASS | Fresh/stale/dead with transitions |
| Print styles | PASS | Hides nav, picker, export form |

### metric-picker.js (Task 12.3)

| Requirement | Status | Notes |
|---|---|---|
| Add metric from dropdown | PASS | Creates chart card, removes option |
| Remove chart (X button) | PASS | Re-adds option to dropdown |
| Time range buttons | PASS | Reloads all charts with range |
| Client-side only state | PASS | No persistence |
| HTML escaping | PASS | Uses DOM textContent |
| Chart colour cycling | PASS | Matches server palette |

### Integration tests (Task 12.6)

| Requirement | Status | Notes |
|---|---|---|
| Dashboard with factory sim data | PASS | 7 equipment groups verified |
| Trends page returns 200 | PASS | Correct content type |
| SSE sends factory sim signals | PASS | Signal names verified |
| Backward compatibility (export) | PASS | Endpoint still works |
| Backward compatibility (certificates) | PASS | Page still returns |
| Backward compatibility (static assets) | PASS | JS files still served |

---

## Test Coverage Assessment

### Covered well
- Signal descriptor building (grouping, ordering, metadata, unknown handling, defaults)
- Dashboard HTML rendering (all signal types, equipment cards, navigation, empty state)
- Trends page HTML rendering (charts, picker, time range, excluded types, ordering)
- SSE stream flattenMetrics (single/multi field, sanitisation, rounding, booleans, bigints)
- SSE endpoint integration (signal events, element patches, timing)
- Staleness classification logic (boundaries, all three states)
- Staleness data attributes in HTML output
- Integration tests with factory sim data (all 7 equipment groups)
- Backward compatibility (export, certificates, static assets)

### Coverage gaps (not critical for this phase)
- No test verifies that `/static/components/staleness.js` returns 200 (this would have caught F-01)
- No test for `metric-picker.js` behaviour (client-side JS, would need browser testing)
- No test for staleness visual behaviour in a real browser (MutationObserver interaction)
- No test for trends page time range button JS interaction
- The dashboard test does not verify equipment card ordering within the HTML against the PRD priority table (the integration test does check this)

---

## Rules Compliance

| Rule | Status | Notes |
|---|---|---|
| Rule 1 (No hand-waving) | PASS | No skipped tests or dismissals |
| Rule 2 (Tests prove behaviour) | PASS | Tests verify data correctness and contracts |
| Rule 5 (PRD is spec) | PASS | Implementation matches phase plan |
| Rule 8 (Interface compliance) | PASS | SignalDescriptor, EquipmentGroup match plan |
| Rule 9 (Test hard paths) | PASS | Unknown signals, empty state, boundary cases |
| Rule 10 (No hardcoded overrides) | PARTIAL | Version string hardcoded (F-03), SSE intervals hardcoded (F-05) |
| Rule 11 (Handle async errors) | PASS | SSE stream catches errors, checks for abort/cancel |
| Rule 12 (Lifecycle ordering) | N/A | No lifecycle changes in this phase |
| Rule 13 (Per-instance not global) | N/A | No per-instance vs global concerns |

---

## Phase 13 Readiness Assessment

Phase 12 is **ready to proceed** once F-01 (staleness.js asset map) is fixed. The remaining should-fix items (F-02 through F-06) are non-blocking but should be addressed early in the next phase to prevent debt accumulation.

**Blockers:**
- F-01 must be fixed before Phase 12 can be considered complete. Without it, staleness detection is dead code.

**Recommended fix order:**
1. F-01 (staleness.js asset map) -- 1 minute fix, unblocks the feature
2. F-02 (duplicate collectMetricNames) -- 5 minute refactor
3. F-04 (staleness test imports) -- 10 minute fix, improves test fidelity
4. F-03 (hardcoded version) -- 10 minute fix
5. F-05, F-06 -- defer to when config wiring is addressed more broadly
