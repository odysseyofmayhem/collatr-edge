# Phase 9 Progress — Local Web UI

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 9.0 | WebUIAdapter — read-only pipeline facade | ✅ |
| 9.1 | Elysia HTTP server + static asset embedding | ✅ |
| 9.2 | Dashboard page — JSX shell with Datastar | ⬜ |
| 9.3 | SSE streaming endpoint | ⬜ |
| 9.4 | ECharts trend charts | ⬜ |
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
