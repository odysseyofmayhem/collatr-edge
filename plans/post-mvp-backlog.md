# Post-MVP Backlog

Items deferred during Phases 1–8.5 that must be addressed after MVP launch. Ordered by priority within each category. Each item includes source, rationale for deferral, and enough detail to start implementation immediately.

**Decision authority:** Lee (2026-02-24). Deferrals confirmed during pre-Phase 9 gate review.

---

## 🔴 High Priority (first post-MVP sprint)

### 1. Store-and-Forward Buffer → Runtime Integration

**What:** The S&F buffer (`src/buffer/store-forward.ts`) exists and is fully tested at the component level (14 tests in `test/unit/buffer/store-forward.test.ts`), but it is NOT wired into the `PipelineRuntime` flush loop. Metrics currently go directly from the output broadcaster to `output.write()` with no buffering or retry persistence.

**Why it matters:** Hub delivery resilience. If the MQTT broker is temporarily unreachable, metrics are lost. The buffer would persist them to SQLite and retry on reconnection. This is PRD §22 Scenario 4 (S&F recovery).

**Why deferred:** Minimum half a day of work. The buffer exists and is tested at the component level. MVP demo scenarios 1-3 and 5 don't need it. Scenario 4 documented as stretch.

**Effort:** 4–8 hours. Requires:
- Inserting buffer between broadcaster and `output.write()` in `runOutputFlushLoop()`
- Buffer instantiation in `plugin-factory.ts` (per-output, using alias for table naming)
- `beginTransaction()` → `output.write()` → `acceptAll()` / `keepAll()` flow
- Failed final-flush metrics persisted on shutdown (`runtime.ts:375` TODO)
- Integration tests for the full buffer → flush → retry cycle

**Files:** `src/pipeline/runtime.ts`, `src/pipeline/plugin-factory.ts`, `src/buffer/store-forward.ts`
**TODOs:** `runtime.ts:375` ("when S&F buffer is integrated, failed final-flush metrics should be persisted")

---

### 2. Sparkplug B Connection Lifecycle (Tahu Pattern)

**What:** After reconnection (network blip), the Hub link does NOT re-publish NBIRTH. The edge node enters a "zombie state" where the Hub thinks it's dead until an explicit NCMD/Rebirth is sent. Additionally, the Will message carries a stale `bdSeq` after rebirth because MQTT doesn't support updating the Will after CONNECT.

**Why it matters:** This is the #1 protocol correctness issue. In a real deployment with intermittent connectivity (common in manufacturing), the edge will frequently enter zombie state.

**Why deferred:** Full connection lifecycle redesign. All four sub-issues (D-1, D-2, D-3, F-2) should be tackled together as one piece of work.

**Sub-issues:**
- **D-1:** Heartbeat timer not paused during rebirth — seq interleaving risk (Phase 7 fix verification)
- **D-2:** Concurrent `publishDeviceData()` duplicate DBIRTH race (Phase 7 fix verification)
- **D-3:** No reconnection-triggered NBIRTH re-publish — zombie state after network blip (Phase 7 fix verification)
- **F-2:** NDEATH Will stale bdSeq after rebirth — MQTT protocol cannot update Will after CONNECT (Phase 7 independent review)

**Effort:** 1–2 days. Requires:
- `rebirth()` must disconnect → set new Will with updated bdSeq → reconnect → NBIRTH → all DBIRTHs
- Heartbeat timer must be paused during rebirth (D-1)
- `publishDeviceData()` needs a mutex or queue to prevent concurrent DBIRTH races (D-2)
- Reconnection handler must trigger full NBIRTH + DBIRTH cycle (D-3)
- Stale Will bdSeq addressed by the disconnect/reconnect pattern (F-2)

**Files:** `src/hub/hub-link.ts`, `src/core/mqtt-client.ts`
**Review refs:** Phase 7 independent review (F-2), Phase 7 fix verification (D-1, D-2, D-3)

---

### 3. bdSeq Persistence in SQLite

**What:** `bdSeq` (birth/death sequence number) starts at 0 on every process restart. After a crash and restart, the Hub may see the same `bdSeq=0` and misinterpret it as a new edge node rather than a restarted one.

**Why it matters:** Sparkplug B protocol correctness. The Hub uses bdSeq to correlate NBIRTH with NDEATH.

**Why deferred:** Requires designing a small SQLite key-value state store for hub link. Should be done alongside item #2 (Tahu pattern).

**Effort:** 2–4 hours. Requires:
- SQLite state file (small key-value store) for hub link persistent state
- Read bdSeq on startup, increment, write before NBIRTH
- Wire into hub-link.ts constructor

**Files:** `src/hub/hub-link.ts`
**TODO:** `hub-link.ts:66` ("Phase 8+ — persist bdSeq in SQLite state for crash recovery")

---

## 🟡 Medium Priority (second post-MVP sprint)

### 4. Per-Plugin Error Behavior Configuration

**What:** `error_behavior` is extracted from plugin config but discarded. The current behavior (log + continue for inputs/processors, log + retry for outputs) is the sane default, but operators can't customise it.

**Why deferred:** Current defaults are correct. Configurable error behavior is a quality-of-life improvement, not a correctness issue.

**Effort:** 4–6 hours. Wire `error_behavior` through PipelineOptions, implement `"retry"`, `"skip"`, `"fatal"` behaviors in the gather and flush loops.

**Files:** `src/pipeline/plugin-factory.ts`, `src/pipeline/runtime.ts`

---

### 5. Per-Output Flush Interval

**What:** `flush_interval` is extracted per-output but not wired. All outputs share `agent.flush_interval`. Some outputs (e.g., local store) may want faster flushing than Hub outputs.

**Why deferred:** Single flush interval is adequate for MVP. Per-output is convenience, not correctness.

**Effort:** 2–3 hours. Each output gets its own `runOutputFlushLoop` with its own interval.

**Files:** `src/pipeline/runtime.ts`, `src/pipeline/plugin-factory.ts`

---

### 6. AbortSignal for Gather Cancellation

**What:** When a gather timeout fires, the timed-out `gather()` call continues running in the background. `Promise.race()` doesn't cancel the loser. On constrained devices (Pi 4), this wastes resources.

**Why deferred:** Requires changing the `Input` interface to accept `AbortSignal`, touching all input plugins.

**Effort:** 4–6 hours. Requires changing the `Input` interface, updating all input plugins, and wiring abort into the gather loop.

**Files:** All input plugins, `src/core/plugin-types.ts`, `src/pipeline/runtime.ts`
**TODO:** `runtime.ts:162` ("Phase 2 — pass AbortSignal into gather()")

---

### 7. metric_buffer_limit Enforcement

**What:** Per-output buffer limits are extracted from config but not enforced. Channel capacity (10,000) acts as an implicit global limit with drop-oldest, but per-output limits are not wired.

**Why deferred:** Global channel capacity provides adequate backpressure for MVP.

**Effort:** 2–3 hours. Wire metric_buffer_limit through PipelineOptions to per-output channel capacity.

**Files:** `src/pipeline/plugin-factory.ts`, `src/pipeline/runtime.ts`

---

### 8. StatsCollector Full Wiring

**What:** `SimpleStatsCollector` is created but only partially wired. `metricsGathered` is incremented (via internal input), and heartbeat NDATA uses it. But `metricsWritten`, `metricsDropped`, `writeErrors`, `gatherErrors` are not incremented by the runtime.

**Why deferred:** Partial stats are sufficient for MVP observability. Full wiring is incremental work.

**Effort:** 2–3 hours. Increment counters in the appropriate runtime loops (flush loop for writes/drops/errors, gather loop for gather errors).

**Files:** `src/pipeline/runtime.ts`, `src/core/stats.ts`

---

### 9. integrity_check_on_startup as Agent-Level Config

**What:** PRD §8 step 6 defines `integrity_check_on_startup` as a global agent-level setting. Currently it's per-output on `local-store` only. This should be an `[agent]` config field that applies to all SQLite databases (local-store + S&F buffer).

**Why deferred:** Config schema refactor needed. The per-output `integrity_check` field on local-store still works for MVP. Not blocking Phase 9 Web UI.

**Effort:** 2–3 hours. Requires:
- Add `integrity_check_on_startup: z.boolean().default(false)` to `AgentSchema` in config.ts
- Wire through `PipelineOptions.integrityCheckOnStartup`
- In `plugin-factory.ts`: when creating local-store, merge agent-level flag into plugin config before Zod parsing (`pluginConfig.integrity_check = pluginConfig.integrity_check ?? config.agent.integrity_check_on_startup`)
- Update `config-init.ts` templates with commented-out field
- Tests for config parsing and factory pass-through

**Files:** `src/core/config.ts`, `src/pipeline/plugin-factory.ts`, `src/plugins/outputs/local-store.ts`
**TODO:** `local-store.ts:27` ("Phase 6/7 — PRD uses config.agent.integrity_check_on_startup")

---

## 🟢 Low Priority (address when context arises)

### 10. allow_local_subnet Enforcement

**What:** `allow_local_subnet` is parsed from config and stored in `ResolvedEgressRules` but not enforced in `checkEgress()`. Enforcement requires detecting the local subnet at runtime (OS network interface inspection).

**Why deferred:** Requires `os.networkInterfaces()` subnet detection logic. Application-layer enforcement is sufficient for MVP.

**Effort:** 4–6 hours. Use `os.networkInterfaces()` to detect local subnets, check egress targets against them.

**Files:** `src/core/network-policy.ts`
**TODOs:** `network-policy.ts:26`, `network-policy.ts:46`, `network-policy.ts:187` (3 related TODOs)

---

### 11. Local Store CSV Export Chunking

**What:** CSV export loads all metrics for a time range into memory. For large ranges (weeks of data), this could exceed available memory on constrained devices (Pi 4 with 1-4GB RAM).

**Why deferred:** Performance optimization. Short time ranges (24h) work fine for MVP.

**Effort:** 2–3 hours. Use `.iterate()` or LIMIT/OFFSET pagination.

**Files:** `src/plugins/outputs/local-store.ts:449`
**TODO:** `local-store.ts:449` ("Post-MVP — process in chunks via .iterate() or LIMIT/OFFSET")

---

### 12. OPC-UA Client Wrapper

**What:** OPC-UA plugin uses node-opcua directly. A dedicated wrapper (like `RealMqttClient` for MQTT) would improve testability and allow mocking without the full node-opcua mock.

**Why deferred:** Current test approach works. Wrapper is a testability improvement, not a functional gap.

**Effort:** 4–6 hours.

**Files:** `src/plugins/inputs/opcua.ts:531`
**TODO:** `opcua.ts:531` ("Phase 7+ — create real OpcuaClient wrapper from node-opcua")

---

### 13. Device Properties on Dedicated Metric in DBIRTH

**What:** Device properties (plugin_type, plugin_alias) are attached to the first metric in DBIRTH. A dedicated "device_info" metric would be more robust and follow Sparkplug B best practice.

**Why deferred:** Cosmetic. Works with standard Hub implementations (Ignition, EMQX).

**Effort:** 1 hour.

**Files:** `src/hub/sparkplug-codec.ts`
**Review ref:** Phase 7 independent review F-10

---

### 14. Per-Plugin Child Logger Injection

**What:** `logLevel` and `alias` are extracted from config and stored in `PipelineOptions` for every plugin type, but plugins all call `getLogger()` which returns the global logger. Per-plugin child loggers with individual level overrides and context fields would give operators fine-grained log control.

**Why deferred:** Architecture decision needed on injection pattern. Either change every plugin constructor to accept a Logger instance, or introduce an async context / thread-local pattern. Phase 8.5 added plugin alias/type to runtime lifecycle logs as a lightweight alternative. Phase 9 log viewer can filter by the `component` field already in log lines.

**Effort:** 4–8 hours (depends on injection pattern chosen).

**Options:**
1. Constructor injection — change `Input`/`Output`/`Processor`/`Aggregator` interfaces to accept `Logger`
2. Async context — `AsyncLocalStorage` to set current plugin context before lifecycle calls
3. Plugin base class — abstract class with logger field, all plugins extend it

**Files:** All plugin files, `src/core/plugin-types.ts`, `src/pipeline/runtime.ts`, `src/core/logger.ts`

---

### 15. Metric Delivery Tracking

**What:** `Metric.accept()`, `reject()`, `drop()` methods exist but are write-only. They're intended for the buffer manager to track per-metric delivery status across outputs.

**Why deferred:** Part of S&F buffer integration (item #1). No value without the buffer wiring.

**Effort:** Part of item #1.

**Files:** `src/core/metric.ts:83`
**TODO:** `metric.ts:83` ("Phase 2 — integrate with delivery tracking / buffer manager")

---

### 16. Extend detectOutputPolicyConflicts to HTTP/Other Outputs

**What:** `detectOutputPolicyConflicts()` in `config-validate.ts` only checks MQTT outputs against the network policy. When HTTP output plugins are added, they need the same validation.

**Why deferred:** No HTTP output plugin exists yet.

**Effort:** 30 min (when HTTP output is implemented).

**Files:** `src/cli/commands/config-validate.ts`
**TODO:** `config-validate.ts:168` ("extend to HTTP and other network outputs when implemented")

---

### 17. Ingress Rules Enforcement

**What:** Network policy ingress rules (`allow_local_webui`, `allow_local_api`, `allowed_cidrs`) are parsed and stored but NOT enforced. Enforcement belongs in the Phase 9 Web UI HTTP server.

**Why deferred:** Parsed but enforcement is a Phase 9 concern — the web server needs to check incoming requests against ingress rules.

**Effort:** 2–4 hours (once web server exists).

**Files:** `src/core/network-policy.ts` (ingress rules already resolved), Phase 9 web server
**TODOs:** `network-policy.ts:46`, `network-policy.ts:187` ("parsed but not enforced")

---

## Implementation Notes

- **Items 1–3** should be tackled together as they all relate to Hub connectivity resilience
- **Item 2** (Tahu pattern) is the single largest post-MVP architectural change
- **Items 4–8** are independent quality-of-life improvements, can be parallelised
- **Item 9** was originally Phase 8.5.5, removed during gate review (config refactor not blocking Phase 9)
- **Items 10–17** are low-risk refinements, tackle when the relevant area is being worked on
- **All items have corresponding TODOs in the source code** with file:line references above
- **All review documents** are in `plans/phase-{7,8}-independent-review.md` and `plans/phase-7-fix-verification.md`

## Source of Deferrals

| Item | Original Phase | Review/Decision |
|------|---------------|-----------------|
| 1 (S&F wiring) | Phase 3/5 | Gate review: Scenario 4 stretch |
| 2 (Tahu pattern) | Phase 7 | Independent review D-1/D-2/D-3, F-2 |
| 3 (bdSeq persist) | Phase 7 | Independent review TODO |
| 4 (error_behavior) | Phase 1 | Config extraction, wiring deferred |
| 5 (per-output flush) | Phase 1 | Config extraction, wiring deferred |
| 6 (AbortSignal) | Phase 2 | Interface change deferred |
| 7 (buffer_limit) | Phase 1 | Config extraction, wiring deferred |
| 8 (StatsCollector) | Phase 4 | Partial wiring in Phase 7 |
| 9 (integrity_check) | Phase 8.5 | Lee decision 2026-02-24: config refactor, not blocking |
| 10 (local_subnet) | Phase 8 | By design: enforcement deferred |
| 11 (CSV chunking) | Phase 3 | Performance optimization |
| 12 (OPC-UA wrapper) | Phase 2 | Testability improvement |
| 13 (device properties) | Phase 7 | Independent review F-10 |
| 14 (child loggers) | Phase 8.5 | Lee decision 2026-02-24: architecture decision needed |
| 15 (delivery tracking) | Phase 2 | Part of S&F integration |
| 16 (HTTP policy) | Phase 8 | Independent review Y-I2 |
| 17 (ingress enforce) | Phase 8 | By design: Phase 9 concern |
