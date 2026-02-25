# Phase 9 Progress — Local Web UI

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 9.0 | WebUIAdapter — read-only pipeline facade | ✅ |
| 9.1 | Elysia HTTP server + static asset embedding | ✅ |
| 9.2 | Dashboard page — JSX shell with Datastar | ✅ |
| 9.3 | SSE streaming endpoint | ✅ |
| 9.4 | ECharts trend charts | ✅ |
| 9.5 | CSV export with dual timestamps | ⬜ |
| 9.6 | OPC-UA certificate helper page | ⬜ |
| 9.7 | Config parsing + CLI wiring | ⬜ |
| 9.8 | Integration tests + acceptance criteria | ⬜ |

## Decisions & Notes

### Task 9.0 — WebUIAdapter

**Approach: Metric sink via Broadcaster observer.** Added `setObserver()` to `Broadcaster<T>` — a single callback that receives every value before it's copied to consumer channels. This is the cleanest tap point because ALL metrics going to outputs (both originals from the processor chain and aggregated summaries from BroadcastAccumulator) pass through the broadcaster. No new Channel consumer, no backpressure concerns.

**State tracking on PipelineRuntime.** Added `_state: PipelineState` and `_startedAt: number | null` fields with public getters. State transitions: `stopped` → `starting` (at entry of `start()`) → `running` (at end of `start()`) → `stopping` (at entry of `stop()`) → `stopped` (at end of `stop()`).

**Adapter decoupling.** The `PipelineWebUIAdapter` constructor takes `PipelineOptions` (for plugin metadata/network policy) and a `PipelineStateSource` interface (for reading state/startedAt). This structural typing means the adapter doesn't depend on the PipelineRuntime class directly — any object with `state` and `startedAt` getters works, including test mocks.

**Plugin health MVP.** For MVP, all plugins report `ok` when pipeline is running, `stopped` otherwise. Last activity is tracked per input alias via the `_device_id` tag injected by ChannelAccumulator. Error tracking per-plugin is post-MVP.

**Live metric quality.** Set to `1.0` (good) for all metrics. OPC-UA quality status code mapping is post-MVP.

**Files created:** `src/web/adapter.ts`
**Files modified:** `src/core/channel.ts` (Broadcaster observer), `src/pipeline/runtime.ts` (state tracking, metric sink, public getters)
**Tests:** `test/unit/web/adapter.test.ts` (24 tests), `test/unit/core/broadcaster.test.ts` (+2 observer tests)

### Task 9.1 — Elysia HTTP Server + Static Asset Embedding

**Dependencies added:** `elysia@1.4.25`, `@elysiajs/html@1.4.0` (Kita JSX), `@starfederation/datastar-sdk@1.0.0-RC.3`

**TSConfig updated:** Added `"jsx": "react-jsx"` and `"jsxImportSource": "@kitajs/html"` for server-side JSX support. Added `.tsx` to include patterns.

**Asset embedding pattern.** Used `import ... with { type: 'file' }` for all three static assets (datastar.js 30KB, echarts.min.js 1.1MB, line-chart.js 3KB). These imports resolve to filesystem paths in dev and `$bunfs/` paths in compiled binaries. Assets are served via an `ASSET_MAP` lookup — unknown paths return 404.

**Gzip compression.** Implemented lazy gzip with in-memory cache. On first request with `Accept-Encoding: gzip`, the asset is compressed via `Bun.gzipSync()` and cached. Subsequent requests serve the cached compressed bytes. Non-gzip clients get the raw file. All static responses have `Cache-Control: public, max-age=31536000, immutable`.

**Elysia type workaround.** After `.use(html())`, the Elysia generic type becomes deeply nested. Defined `WebApp = Elysia<any>` type alias to avoid generic explosion in lifecycle function signatures. Used `as unknown as WebApp` cast.

**Pre-existing test fix.** The adapter test `heapUsed <= heapTotal` was consistently failing under full suite GC pressure. V8 can temporarily report `heapUsed > heapTotal` during GC. Changed assertion to `heapUsed < rss && heapTotal < rss` which is always valid.

**Files created:** `src/web/server.ts`, `src/web/public/datastar.js`, `src/web/public/echarts.min.js`, `src/web/public/components/line-chart.js`
**Files modified:** `tsconfig.json` (JSX config), `package.json` (new deps), `test/unit/web/adapter.test.ts` (fix flaky heap test)
**Tests:** `test/unit/web/server.test.ts` (15 tests)

## Test Counts

| After Task | Tests | Assertions | Files |
|------------|-------|------------|-------|
| Baseline (Phase 8.5) | 773 | 2827 | 53 |
| 9.0 | 799 | 2905 | 54 |
| 9.1 | 814 | 2936 | 55 |
| 9.2 | 835 | 3013 | 56 |
| 9.3 | 849 | 3045 | 57 |
| 9.4 | 877 | 3096 | 58 |

### Task 9.3 — SSE Streaming Endpoint

**SDK-based SSE stream.** Used `ServerSentEventGenerator.stream()` from `@starfederation/datastar-sdk/web`. The SDK returns a standard `Response` with correct SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`). Elysia passes the Response through to the client. `keepalive: true` keeps the stream open until the client disconnects.

**Mixed signals + elements in one stream.** One SSE connection serves both `patchSignals` (live metric values every 1s) and `patchElements` (status panel HTML every 2s). Pattern validated in Spike 3 and Spike 6. The stream loop uses a tick counter — signals on every tick, element patches on every 2nd tick.

**Signal flattening.** Adapter metrics are flattened into `{metricName_fieldName: value, chartTs: epochMs}` format. Signal names are sanitised to valid JS identifiers (special characters → underscores). `chartTs` tracks the latest metric timestamp in milliseconds for the ECharts data-effect bridge.

**Fragment components.** Created `src/web/views/fragments/status-panel.tsx` (full status panel with uptime, memory, and plugin table) and `src/web/views/fragments/plugin-table.tsx` (standalone plugin health table). The status panel fragment has `id="status-panel"` matching the dashboard target div for morph.

**Client disconnect handling.** The stream loop is wrapped in try/catch — when the client disconnects, the SDK throws (or the controller is cancelled), and we break out cleanly. No resource leaks.

**Files created:** `src/web/routes/stream.ts`, `src/web/views/fragments/status-panel.tsx`, `src/web/views/fragments/plugin-table.tsx`
**Files modified:** `src/web/server.ts` (SSE route registration)
**Tests:** `test/unit/web/routes/stream.test.ts` (14 tests — 6 flattenMetrics unit, 7 SSE endpoint with metrics, 1 empty metrics handling)

### Task 9.2 — Dashboard Page (JSX Shell with Datastar)

**Layout/Dashboard separation.** Created `src/web/views/layout.tsx` as the base HTML layout (head, scripts, styles) and `src/web/views/dashboard.tsx` as the main dashboard page component. The Layout wraps content with `<!DOCTYPE html>`, inline CSS, and script tags for Datastar (module), ECharts (UMD), and the line-chart web component.

**Server-rendered initial state.** The dashboard renders initial values from the WebUIAdapter on first load — pipeline status badge, plugin health table, uptime, memory, network policy banner — so the page is immediately readable before SSE connects. No spinner or "Loading..." for the initial render.

**Datastar RC.7 colon syntax.** All attributes follow RC.7 rules: `data-init` for SSE stream, `data-signals` (object form) for signal store, `data-text` for bindings, `data-effect` for ECharts bridge, `data-show` for conditional visibility. No hyphen-keyed attributes (`data-on-click`, `data-signals-name`, `data-on-load`) — these silently fail in RC.7.

**Single SSE stream.** One `data-init="@get('/api/dashboard/stream')"` wraps the entire live section. This stream will deliver both `patchSignals` (live metric values + chart timestamps) and `patchElements` (status panel and plugin table fragments). Pattern validated in Spike 6.

**Network policy banner.** Colour-coded per PRD §10: red for standalone, amber for local_network, green for connected. Uses `data-show` to hide the connected banner (non-connected modes are the warning states). When no network policy is configured, no banner renders at all.

**ECharts bridge.** Four `collatr-line-chart` web components with `data-effect` bridge pattern (Spike 4 recommended). Each chart bridges via `document.getElementById('chart-X')?.addPoint($chartTs, parseFloat($signalName))`. The initial signal guard in the web component (`timestamp < 1e12`) prevents the 0-value data-effect from creating a bad data point.

**CSV export form.** Plain HTML form with `method="get"` and `action="/api/export"` — no JavaScript involved in the export flow. Datastar is not needed for form submission (Spike 6 validated pattern).

**Route registration.** Added `GET /` to `server.ts` returning `DashboardPage({ adapter })` as `text/html`. The adapter parameter is now used (was `_adapter` in 9.1).

**Files created:** `src/web/views/layout.tsx`, `src/web/views/dashboard.tsx`
**Files modified:** `src/web/server.ts` (dashboard route, adapter wiring)
**Tests:** `test/unit/web/views/dashboard.test.ts` (21 tests — 18 JSX rendering, 3 HTTP route)

### Task 9.4 — ECharts Trend Charts (Historical Load + Live SSE Append)

**WebUIAdapter extension.** Added `getLocalStore(): LocalStoreOutput | null` to the `WebUIAdapter` interface and `PipelineWebUIAdapter` implementation. The adapter constructor now accepts an optional `LocalStoreOutput` parameter. This exposes the local data store for historical chart queries and metric name discovery without coupling routes to the store directly.

**LocalStoreOutput extension.** Added `listMetricNames(): string[]` method that queries the `tag_index` table across all daily files for unique metric names. Uses `SELECT DISTINCT name FROM tag_index` — efficient since tag_index is a catalogue, not a full table scan of metrics.

**Chart data endpoints.** Created `src/web/routes/chart-data.ts` with two endpoints:
- `GET /api/chart/history?metric=<name>&from=<iso>&to=<iso>` — queries `LocalStoreOutput.query()` for the time range, filters by metric name, extracts the first numeric field value, and returns JSON `[{timestamp, value}, ...]`. Default range is last 24h (PRD §17: "last 24 hours"). Capped at 2000 points with uniform downsampling (every Nth point).
- `GET /api/chart/metrics` — returns sorted list of available metric names from `LocalStoreOutput.listMetricNames()`.

**Validation ordering.** Metric parameter and date validation happen before the local store null check. This ensures proper 400 errors for invalid requests even when no store is configured.

**Downsample algorithm.** Simple uniform stride: `step = length / maxPoints`, take `floor(i * step)` for each output index. Always includes the first point (index 0) and replaces the last output point with the actual last data point to preserve the full time range. Adequate for trend visualisation — not a statistical downsample.

**Line chart web component update.** Updated `src/web/public/components/line-chart.js`:
- Added `_loadHistory()` in `connectedCallback` — fetches `/api/chart/history?metric=<attr>` on mount
- Added `metric` attribute for specifying which metric to fetch history for
- Increased `maxPoints` from 200 to 1000 (per task spec)
- Historical data is loaded into `this.data` and rendered immediately
- Live points from SSE `data-effect` bridge continue to append after history load
- Guard: `timestamp < 1e12` filters initial signal 0-values (spike 4 finding)

**Dashboard wiring.** Added `metric` attribute to all four `<collatr-line-chart>` elements in `dashboard.tsx`: `metric="temperature"`, `metric="pressure"`, `metric="lineSpeed"`, `metric="humidity"`. These names match the signal names used in the `data-effect` bridge expressions.

**Mock adapter updates.** Added `getLocalStore: () => null` to all existing mock adapters in `stream.test.ts`, `dashboard.test.ts`, and `server.test.ts` to satisfy the extended interface.

**Files created:** `src/web/routes/chart-data.ts`
**Files modified:** `src/web/adapter.ts` (getLocalStore interface + impl), `src/plugins/outputs/local-store.ts` (listMetricNames), `src/web/server.ts` (chart-data route registration), `src/web/views/dashboard.tsx` (metric attributes on charts), `src/web/public/components/line-chart.js` (history loading, maxPoints 1000)
**Tests modified:** `test/unit/web/routes/stream.test.ts`, `test/unit/web/views/dashboard.test.ts`, `test/unit/web/server.test.ts` (mock adapter updates)
**Tests created:** `test/unit/web/routes/chart-data.test.ts` (28 tests — 5 downsample, 7 handleChartHistory, 3 handleChartMetrics, 4 HTTP endpoint, 9 line-chart.js validation)
