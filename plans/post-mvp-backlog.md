# Post-MVP Backlog

Items deferred during Phases 1–8 that must be addressed immediately after MVP launch. Ordered by priority within each category.

---

## 🔴 High Priority (address in first post-MVP sprint)

### 1. Store-and-Forward Buffer → Runtime Integration

**What:** The S&F buffer (`src/buffer/store-forward.ts`) exists and is fully tested at the component level (14 tests in `test/unit/buffer/store-forward.test.ts`), but it is NOT wired into the `PipelineRuntime` flush loop. Metrics currently go directly from the output broadcaster to `output.write()` with no buffering or retry persistence.

**Why it matters:** Hub delivery resilience. If the MQTT broker is temporarily unreachable, metrics are lost. The buffer would persist them to SQLite and retry on reconnection. This is PRD §22 Scenario 4 (S&F recovery) — explicitly recorded as post-MVP stretch.

**Effort:** 4–8 hours. Requires:
- Inserting buffer between broadcaster and `output.write()` in `runOutputFlushLoop()`
- Buffer instantiation in `plugin-factory.ts` (per-output, using alias for table naming)
- `beginTransaction()` → `output.write()` → `acceptAll()` / `keepAll()` flow
- Failed final-flush metrics persisted on shutdown (`runtime.ts:375` TODO)
- Integration tests

**Files:** `src/pipeline/runtime.ts`, `src/pipeline/plugin-factory.ts`, `src/buffer/store-forward.ts`
**TODOs:** `runtime.ts:375`

---

### 2. Sparkplug B Connection Lifecycle (Tahu Pattern)

**What:** After reconnection (network blip), the Hub link does NOT re-publish NBIRTH. The edge node enters a "zombie state" where the Hub thinks it's dead until an explicit NCMD/Rebirth is sent. Additionally, the Will message carries a stale `bdSeq` after rebirth because MQTT doesn't support updating the Will after CONNECT.

**Why it matters:** This is the #1 protocol correctness issue. In a real deployment with intermittent connectivity (common in manufacturing), the edge will frequently enter zombie state.

**Effort:** 1–2 days. Requires:
- `rebirth()` must disconnect → set new Will with updated bdSeq → reconnect → NBIRTH → all DBIRTHs
- Heartbeat timer must be paused during rebirth (D-1)
- `publishDeviceData()` needs a mutex or queue to prevent concurrent DBIRTH races (D-2)
- Reconnection handler must trigger full NBIRTH + DBIRTH cycle (D-3)
- Stale Will bdSeq addressed by the disconnect/reconnect pattern (F-2)

**Files:** `src/hub/hub-link.ts`, `src/core/mqtt-client.ts`
**Review refs:** Phase 7 independent review F-2, fix verification D-1/D-2/D-3

---

### 3. bdSeq Persistence in SQLite

**What:** `bdSeq` (birth/death sequence number) starts at 0 on every process restart. After a crash and restart, the Hub may see the same `bdSeq=0` and misinterpret it as a new edge node rather than a restarted one.

**Why it matters:** Sparkplug B protocol correctness. The Hub uses bdSeq to correlate NBIRTH with NDEATH.

**Effort:** 2–4 hours. Requires:
- SQLite state file (small key-value store) for hub link persistent state
- Read bdSeq on startup, increment, write before NBIRTH
- Wire into hub-link.ts constructor

**Files:** `src/hub/hub-link.ts`
**TODO:** `hub-link.ts:66`

---

## 🟡 Medium Priority (address in second post-MVP sprint)

### 4. Per-Plugin Error Behavior Configuration

**What:** `error_behavior` is extracted from plugin config but discarded. The current behavior (log + continue for inputs/processors, log + retry for outputs) is the sane default, but operators can't customise it.

**Effort:** 4–6 hours. Wire `error_behavior` through PipelineOptions, implement `"retry"`, `"skip"`, `"fatal"` behaviors in the gather and flush loops.

**Files:** `src/pipeline/plugin-factory.ts`, `src/pipeline/runtime.ts`

---

### 5. Per-Output Flush Interval

**What:** `flush_interval` is extracted per-output but not wired. All outputs share `agent.flush_interval`. Some outputs (e.g., local store) may want faster flushing than Hub outputs.

**Effort:** 2–3 hours. Each output gets its own `runOutputFlushLoop` with its own interval.

**Files:** `src/pipeline/runtime.ts`, `src/pipeline/plugin-factory.ts`

---

### 6. AbortSignal for Gather Cancellation

**What:** When a gather timeout fires, the timed-out `gather()` call continues running in the background. `Promise.race()` doesn't cancel the loser. On constrained devices (Pi 4), this wastes resources.

**Effort:** 4–6 hours. Requires changing the `Input` interface to accept `AbortSignal`, updating all input plugins, and wiring abort into the gather loop.

**Files:** All input plugins, `src/core/plugin-types.ts`, `src/pipeline/runtime.ts`
**TODO:** `runtime.ts:162`

---

### 7. metric_buffer_limit Enforcement

**What:** Per-output buffer limits are extracted from config but not enforced. Channel capacity (10,000) acts as an implicit global limit with drop-oldest, but per-output limits are not wired.

**Effort:** 2–3 hours. Wire metric_buffer_limit through PipelineOptions to per-output channel capacity.

**Files:** `src/pipeline/plugin-factory.ts`, `src/pipeline/runtime.ts`

---

### 8. StatsCollector Full Wiring

**What:** `SimpleStatsCollector` is created but only partially wired. `metricsGathered` is incremented (via internal input), and heartbeat NDATA uses it. But `metricsWritten`, `metricsDropped`, `writeErrors`, `gatherErrors` are not incremented by the runtime.

**Effort:** 2–3 hours. Increment counters in the appropriate runtime loops (flush loop for writes/drops/errors, gather loop for gather errors).

**Files:** `src/pipeline/runtime.ts`, `src/core/stats.ts`

---

## 🟢 Low Priority (address when context arises)

### 9. allow_local_subnet Enforcement

**What:** `allow_local_subnet` is parsed from config and stored in `ResolvedEgressRules` but not enforced in `checkEgress()`. Enforcement requires detecting the local subnet at runtime.

**Effort:** 4–6 hours. Use `os.networkInterfaces()` to detect local subnets, check egress targets against them.

**Files:** `src/core/network-policy.ts`

---

### 10. Local Store CSV Export Chunking

**What:** CSV export loads all metrics for a time range into memory. For large ranges (weeks of data), this could exceed available memory on constrained devices.

**Effort:** 2–3 hours. Use `.iterate()` or LIMIT/OFFSET pagination.

**Files:** `src/plugins/outputs/local-store.ts:449`

---

### 11. OPC-UA Client Wrapper

**What:** OPC-UA plugin uses node-opcua directly. A dedicated wrapper (like `RealMqttClient` for MQTT) would improve testability and allow mocking without the full node-opcua mock.

**Effort:** 4–6 hours.

**Files:** `src/plugins/inputs/opcua.ts:531`

---

### 12. Device Properties on Dedicated Metric in DBIRTH

**What:** Device properties (plugin_type, plugin_alias) are attached to the first metric in DBIRTH. A dedicated "device_info" metric would be more robust.

**Effort:** 1 hour.

**Files:** `src/hub/sparkplug-codec.ts`
**Review ref:** Phase 7 independent review F-10

---

### 13. Metric Delivery Tracking

**What:** `Metric.accept()`, `reject()`, `drop()` methods exist but are write-only. They're intended for the buffer manager to track per-metric delivery status.

**Effort:** Part of S&F buffer integration (item #1).

**Files:** `src/core/metric.ts:83`

---

## Notes

- Items 1–3 should be tackled together as they all relate to Hub connectivity resilience
- Item 2 (Tahu pattern) is the single largest post-MVP architectural change
- Items 4–8 are independent quality-of-life improvements
- Items 9–13 are low-risk, low-urgency refinements
- All items have corresponding TODOs in the source code
