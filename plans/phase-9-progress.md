# Phase 9 Progress — Local Web UI

## Status: IN PROGRESS

## Tasks

| ID | Description | Status |
|----|-------------|--------|
| 9.0 | WebUIAdapter — read-only pipeline facade | ✅ |
| 9.1 | Elysia HTTP server + static asset embedding | ⬜ |
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

## Test Counts

| After Task | Tests | Assertions | Files |
|------------|-------|------------|-------|
| Baseline (Phase 8.5) | 773 | 2827 | 53 |
| 9.0 | 799 | 2905 | 54 |
