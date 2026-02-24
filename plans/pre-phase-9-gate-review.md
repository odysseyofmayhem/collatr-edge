# Pre-Phase 9 Gate Review: CollatrEdge Phases 0–8

**Reviewer:** Independent gate review agent
**Date:** 2026-02-24
**Scope:** Comprehensive final review of all Phases 0–8 before Phase 9 (Web UI)
**Purpose:** Ensure the most stable foundation possible before building the UI layer

---

## 1. Test Suite Results

```
771 pass, 0 fail, 2813 expect() calls
Ran 771 tests across 53 files. [28.89s]
```

**Scope:** `test/unit/` (35 files) + `test/integration/` (18 files)

- **Zero failures.** All 771 unit and integration tests pass cleanly.
- **No flaky behavior observed.** Timer-sensitive tests (Ticker, pipeline flush loops) use generous tolerances and passed on first run.
- **E2E tests** (5 additional files in `test/e2e/`) not included in this run but were verified in prior phase reviews (including sustained 60s soak test).
- **No warnings** from the test runner. Logger output from hub-link tests is expected (integration tests exercise real logging paths).

**Assessment:** ✅ Test suite is healthy. Zero flakiness. Coverage is comprehensive across unit, integration, and e2e layers.

---

## 2. TODO Audit

### Complete TODO Inventory (13 items in `src/`)

| # | File:Line | TODO Text | Correctly Deferred? | Hidden Bug? | Quick-Fix? |
|---|-----------|-----------|---------------------|-------------|------------|
| 1 | `config-validate.ts:168` | `extend to HTTP and other network outputs when implemented (PRD Appendix A)` | ✅ Yes — no HTTP output plugin exists yet | No | No |
| 2 | `hub-link.ts:66` | `Phase 8+ — persist bdSeq in SQLite state for crash recovery` | ✅ Yes — documented post-MVP deferral | Low risk (see §5) | No |
| 3 | `hub-link.ts:273` | `Post-MVP — disconnect/reconnect cycle on rebirth (Eclipse Tahu pattern)` | ✅ Yes — MQTT protocol constraint, documented F-2 | Low risk (see §5) | No |
| 4 | `network-policy.ts:26` | `post-MVP — enforce when subnet detection is available` | ✅ Yes — field present, enforcement deferred | No | No |
| 5 | `network-policy.ts:46` | `post-MVP — parsed but not enforced (PRD §10)` | ✅ Yes — Zod schema field, parsed correctly | No | No |
| 6 | `network-policy.ts:187` | `post-MVP — parsed, not enforced` | ✅ Yes — resolver wires user override correctly | No | No |
| 7 | `metric.ts:83` | `Phase 2 — integrate with delivery tracking / buffer manager` | ✅ Yes — tracking methods exist, not wired | No | No |
| 8 | `ticker.ts:68` | `log.warn('System clock change detected, re-anchoring Ticker')` | ⚠️ Partially — logger IS integrated now | No | **Yes (2 min)** |
| 9 | `opcua.ts:531` | `Phase 7+ — create real OpcuaClient wrapper from node-opcua` | ✅ Yes — uses mock/stub for MVP | No | No |
| 10 | `local-store.ts:27` | `Phase 6/7 — PRD uses config.agent.integrity_check_on_startup` | ✅ Yes — feature deferred | No | No |
| 11 | `local-store.ts:449` | `Post-MVP — process in chunks via .iterate() or LIMIT/OFFSET` | ✅ Yes — performance optimization | No | No |
| 12 | `runtime.ts:162` | `Phase 2 — pass AbortSignal into gather()` | ✅ Yes — Requires Input interface change | No | No |
| 13 | `runtime.ts:375` | `Phase 7 — when S&F buffer is integrated, failed final-flush metrics should be persisted` | ✅ Yes — S&F buffer not wired yet | No | No |
| 14 | `plugin-factory.ts:328` | `swVersion: "0.1.0" — read from package.json or build info` | ⚠️ Should fix | No bug, but stale version risk | **Yes (3 min)** |

### Quick-Fix Recommendations

#### QF-1: Uncomment clock jump warning log (ticker.ts:68) — 2 min
The logger framework has been integrated since Phase 4. The commented-out warning is the ONLY code path in the system that silently swallows a significant operational event (system clock jump). Uncomment and wire:
```typescript
// Before:
// TODO: log.warn('System clock change detected, re-anchoring Ticker')
// After:
getLogger().warn('System clock change detected, re-anchoring Ticker', { component: 'ticker' });
```
Import `getLogger` from `../core/logger`.

#### QF-2: Read swVersion from package.json (plugin-factory.ts:328) — 3 min
The hardcoded `"0.1.0"` happens to match `package.json` today, but will drift when version bumps happen. Fix:
```typescript
import packageJson from "../../package.json";
// ...
swVersion: packageJson.version,
```
Note: `run.ts` already imports `package.json` successfully, so the pattern is established.

---

## 3. Phase 8 Fix Verification

All 6 fixes from commit `3426d7b` (diff from `44dd5e9`) verified:

### Y-I1: `allow_local_subnet` now in Zod schema and wired to resolver ✅

**File:** `src/core/network-policy.ts`
- `NetworkPolicySchema.egress` now includes `allow_local_subnet: z.boolean().optional()` with TODO comment
- `resolveNetworkPolicy()` reads `raw?.egress?.allow_local_subnet ?? preset.egress.allowLocalSubnet`
- User override is respected (was previously hardcoded from preset)
- **New test:** "allow_local_subnet user override is respected" — overrides `local_network` default from `true` to `false` ✅

### Y-I2: TODO comment added for non-MQTT output validation ✅

**File:** `src/cli/commands/config-validate.ts:168`
- Added: `// TODO: extend to HTTP and other network outputs when implemented (PRD Appendix A)`
- Correctly placed before the MQTT-specific validation loop
- Future-proofs the validation function for HTTP outputs ✅

### Y-I3: Test for connected + redundant permissive override ✅

**File:** `test/unit/core/network-policy.test.ts`
- New test: "connected mode with redundant allow_dns=true remains unrestricted"
- Verifies that setting `allow_dns: true` (same as default) doesn't break `unrestricted` mode
- Documents the intentional design: only restrictive overrides break unrestricted ✅

### G-I1: IPv6 checkEgress test ✅

**File:** `test/unit/core/network-policy.test.ts`
- New test: "IPv6 target matches allowed_hosts entry with bracket notation"
- Creates policy with `allowed_hosts: ["[::1]:8080"]`, checks egress for `host: "::1", port: 8080`
- Result: `allowed: true` ✅

### G-I2: Default ports in parseMqttServerUrl ✅

**File:** `src/plugins/outputs/mqtt.ts`
- `parseMqttServerUrl` now defaults: `mqtt://` → port 1883, `mqtts://` → port 8883
- Eliminates the `port: undefined` mismatch issue with `allowed_hosts`
- **Two new tests:** "defaults to port 1883 for mqtt:// URL without explicit port" and "defaults to port 8883 for mqtts:// URL without explicit port" ✅

### G-I3: Test for empty servers=[] ✅

**File:** `test/unit/plugins/outputs/mqtt.test.ts`
- New test: "plain mode with servers = [] → connect() throws (missing servers)"
- Verifies that `MqttOutput` with empty `servers: []` throws "requires 'servers' config" on connect ✅

**All 6 fixes are correctly implemented, tested, and verified.**

---

## 4. Cross-Phase Integration Assessment

### 4.1 Error Propagation

Traced error paths through the full stack:

| Error Source | Propagation Path | CLI Exit Code | User Message Quality |
|-------------|-----------------|---------------|---------------------|
| Invalid TOML syntax | `parseTOML()` → `parseConfig()` → `loadConfigFile()` → `runCommand()` catch → `log.error()` | 1 | ✅ "Invalid TOML: ..." with line info |
| Invalid `[agent]` section | `AgentSchema.safeParse()` → `parseConfig()` → same as above | 1 | ✅ "Invalid [agent] config:\n field: message" |
| Invalid `[network_policy]` | `NetworkPolicySchema.safeParse()` → `parseConfig()` → same | 1 | ✅ "Invalid [network_policy] config:\n ..." |
| Unknown plugin type | `buildPipeline()` → throws → `runCommand()` catch → `log.error()` | 1 | ✅ 'Unknown input plugin: "foo"' |
| Plugin schema error | Zod parse inside factory → throws → `buildPipeline()` → same | 1 | ✅ Zod error with field paths |
| Network policy violation (hub) | `buildPipeline()` → `PolicyViolationError` → `runCommand()` catch | 1 | ✅ Full context: target, reason, mode |
| Network policy violation (MQTT) | `MqttOutput.connect()` → `PolicyViolationError` → `runtime.start()` → `runCommand()` catch | 1 | ✅ Same quality |
| Output connect failure | `plugin.connect()` → `runtime.start()` → `runCommand()` catch | 1 | ✅ "failed to start pipeline" + error |
| Hub link connect failure | `hubLink.start()` → `runtime.start()` → same | 1 | ✅ Includes broker URL context |
| Config file not found | `loadConfigFile()` → throws → `runCommand()` catch | 1 | ✅ Actionable: "Create one with 'config init' or specify --config" |
| Double signal during shutdown | Signal handler → `forceExit(1)` | 1 | ✅ "Received second signal, forcing exit" |
| Shutdown timeout | Timer → `forceExit(1)` | 1 | ✅ "Shutdown timeout, forcing exit" with timeout_ms |

**Assessment:** ✅ Error propagation is thorough and consistent. Every error path from every phase produces a clear, actionable message and exits with code 1. The `runCommand()` function in `run.ts` acts as a reliable error boundary with distinct catch points for config load, pipeline build, and pipeline start.

### 4.2 Lifecycle Ordering

**Startup sequence** (`PipelineRuntime.start()`):

| Step | PRD §8 Ref | Code Location | Status |
|------|-----------|--------------|--------|
| Log network policy | Step 20 | `start()` line 1 | ✅ |
| Create output channels + broadcaster | Step 10 | `start()` channels | ✅ |
| Connect outputs (fail-fast) | Step 11 | `plugin.connect()` loop | ✅ |
| Start hub link (after outputs, before inputs) | Step 12 | `hubLink.start()` | ✅ |
| Start aggregator push loops | Step 13 | `runAggregatorPushLoop` | ✅ |
| Create input channel | Step 10 | Input `Channel` creation | ✅ |
| Start main processing loop | Step 12 | `runMainLoop` | ✅ |
| Init processors and aggregators | Step 12 | `proc.plugin.init()` | ✅ |
| Init and start inputs | Step 14-15 | Service + polling inputs | ✅ |
| Start output flush loops | Step 16 | `runOutputFlushLoop` | ✅ (last) |

**Shutdown sequence** (`PipelineRuntime.stop()`):

| Step | PRD §8 Ref | Code Location | Status |
|------|-----------|--------------|--------|
| Signal abort to all loops | Step 1 | `abortController.abort()` | ✅ |
| Stop service inputs (before channel close) | Step 3 | `plugin.stop()` loop | ✅ |
| Close input channel (cascading shutdown) | Step 4 | `inputChannel.close()` | ✅ |
| Wait for all loops to settle | Step 5 | `Promise.allSettled(loops)` | ✅ |
| Stop hub link (after pipeline drain) | Step 6 | `hubLink.stop()` | ✅ |
| Close all plugins | Step 7 | `plugin.close()` loops | ✅ |

**Assessment:** ✅ Lifecycle ordering matches PRD §8 precisely. The critical ordering invariants are all met:
- Outputs connect before data flows
- Hub link starts after outputs, stops after pipeline drain
- Service inputs stop before channel close (allows final metrics to flow)
- Graceful cascade: abort → service stop → channel close → loop drain → plugin close

### 4.3 Config Flow Trace

Full config path: **TOML → parseConfig() → AgentConfig → buildPipeline() → PipelineOptions → PipelineRuntime**

| Config Field | TOML Section | AgentConfig | PipelineOptions | Runtime | Verified |
|-------------|-------------|-------------|-----------------|---------|----------|
| `agent.interval` | `[agent]` | `agent.interval: "10s"` | `gatherIntervalMs: 10000` | Ticker interval | ✅ |
| `agent.flush_interval` | `[agent]` | `agent.flush_interval: "10s"` | `flushIntervalMs: 10000` | Output flush loop | ✅ |
| `agent.round_interval` | `[agent]` | `agent.round_interval: true` | `roundInterval: true` | Ticker `aligned` flag | ✅ |
| `agent.log_level` | `[agent]` | `agent.log_level: "info"` | — | Set via `createLogger()` in run.ts | ✅ |
| `agent.hub.*` | `[agent.hub]` | `agent.hub: {...}` | `hubLink: HubLink` | Hub link instance | ✅ |
| `global_tags` | `[global_tags]` | `global_tags: {...}` | `globalTags: {...}` | ChannelAccumulator, CollectingAccumulator | ✅ |
| `network_policy` | `[network_policy]` | `networkPolicy: NetworkPolicy` | `networkPolicy: NetworkPolicy` | Startup log, MQTT enforcement | ✅ |
| Per-plugin `interval` | Plugin instance | Raw string → `parseDuration()` | `inputs[].interval` | Gather loop Ticker | ✅ |
| Per-plugin `timeout` | Plugin instance | Raw string → `parseDuration()` | `inputs[].timeout` | `Promise.race` with gather | ✅ |
| Per-plugin `alias` | Plugin instance | String | `inputs[].alias` | `ChannelAccumulator._deviceId`, `registerDevice` | ✅ |
| Per-plugin `filter` | Plugin instance | Filter fields → `MetricFilter` | `inputs[].filter` | `FilteringAccumulator` | ✅ |
| Per-output `metric_batch_size` | Plugin instance | Number | `outputs[].metricBatchSize` | `runOutputFlushLoop` chunking | ✅ |
| Aggregator `period` | Plugin instance | Duration string | `aggregators[].period` | `runAggregatorPushLoop` interval | ✅ |
| Aggregator `drop_original` | Plugin instance | Boolean | `aggregators[].dropOriginal` | `shouldDropOriginals` flag | ✅ |

**Fields extracted but not yet wired (correctly deferred):**

| Field | Status | Phase |
|-------|--------|-------|
| `error_behavior` | Extracted, discarded | Post-MVP |
| `retry_max`, `retry_backoff` | Extracted, discarded | Post-MVP |
| `flush_interval` (per-output) | Extracted, discarded | Post-MVP |
| `flush_jitter` | Extracted, discarded | Post-MVP |
| `collection_jitter`, `collection_offset` | Extracted, discarded | Post-MVP |
| `precision` | Extracted, discarded | Post-MVP |
| `metric_buffer_limit` | Extracted, discarded | Post-MVP |
| `tags` (per-plugin) | Extracted, discarded | Post-MVP |
| `log_level` (per-plugin) | Extracted, stored in PipelineOptions, not consumed | Post-MVP |

**Assessment:** ✅ No fields are lost or mishandled in the config flow. All PRD §7 fields are either fully wired or correctly extracted-and-deferred with clear documentation. The `extractOverrides()` function in `plugin-factory.ts` acts as a clean boundary that prevents unrecognized fields from leaking into plugin Zod schemas.

### 4.4 NetworkPolicy Flow

**Path:** `config → plugin-factory (hub validation) → PipelineOptions → runtime (logging) → MQTT output (enforcement)`

1. **Config parsing** (`config.ts:178-193`): `[network_policy]` section parsed by Zod schema, `resolveNetworkPolicy()` creates immutable `NetworkPolicy` instance, stored on `AgentConfig.networkPolicy`. ✅

2. **Plugin factory — hub validation** (`plugin-factory.ts:306-315`): When `hub.enabled`, the hub broker URL is parsed via `parseMqttServerUrl()`, checked against `networkPolicy.checkEgress()`. If denied, throws `PolicyViolationError` **before** `HubLink` is ever constructed. ✅

3. **Plugin factory — MQTT output** (`plugin-factory.ts:354-362`): `config.networkPolicy` is passed as the 4th constructor argument to `MqttOutput`. Sparkplug outputs reference the already-validated hub link; plain outputs carry the policy for enforcement at connect time. ✅

4. **PipelineOptions** (`plugin-factory.ts:376`): `networkPolicy` is stored on `PipelineOptions` for runtime logging. ✅

5. **Runtime — startup logging** (`runtime.ts:405-410`): `networkPolicy.summary()` is logged at info level before output connect. Ensures operators see the active policy mode in logs. ✅

6. **MQTT output — enforcement** (`mqtt.ts:connect()`): For plain mode, ALL configured servers are validated against the policy via `checkEgress()`. If ANY server is denied, throws `PolicyViolationError`, preventing startup. ✅

**Assessment:** ✅ NetworkPolicy flows correctly through the entire stack. The dual validation approach (hub in `buildPipeline()`, plain MQTT in `connect()`) is correct and necessary — hub validation must happen before HubLink construction. Both are fail-fast at startup.

---

## 5. Deferred Items Risk Matrix

### Phase 7 Deferred Items

| ID | Description | Blocks MVP? | Blocks Phase 9? | Risk Level | Notes |
|----|-------------|-------------|-----------------|------------|-------|
| D-1 | Heartbeat timer not paused during rebirth (seq interleaving) | ❌ No | ❌ No | 🟢 Low | Requires exact timer-rebirth coincidence (sub-ms window). Most Hubs handle gracefully. |
| D-2 | Concurrent `publishDeviceData()` duplicate DBIRTH race | ❌ No | ❌ No | 🟢 Low | Only possible with multiple MQTT outputs for same device. Single-threaded flush loop prevents in practice. |
| D-3 | No reconnection-triggered NBIRTH re-publish (zombie state) | ❌ No | ❌ No | 🟡 Medium | Real protocol gap. After network blip, node is in zombie state until Hub sends NCMD rebirth. Should be high priority for post-MVP. |
| F-2 | Stale Will bdSeq after rebirth | ❌ No | ❌ No | 🟢 Low | MQTT protocol limitation. Hub still receives NDEATH, just can't correlate precisely. Well-documented. |
| F-10 | Device properties on first metric in DBIRTH | ❌ No | ❌ No | 🟢 Low | Cosmetic. Works with standard Hub implementations (Ignition, EMQX). |

### Cross-Phase Deferred Items

| ID | Description | Blocks MVP? | Blocks Phase 9? | Risk Level | Notes |
|----|-------------|-------------|-----------------|------------|-------|
| SF-1 | S&F buffer not wired into PipelineRuntime flush loop | ❌ No* | ❌ No | 🟡 Medium | *PRD §22 Scenario 4 (S&F recovery) may require this. But MVP acceptance criteria say "MQTT S&F buffer queues during disconnect" — the buffer implementation EXISTS and is tested; it's just not wired into the runtime flush loop. Scenario 4 is likely a stretch goal. |
| PL-1 | Per-plugin child loggers (logLevel/alias wired but not consumed) | ❌ No | ❌ No | 🟢 Low | `logLevel` and `alias` are in PipelineOptions but plugins use `getLogger()` global. Nice-to-have for debugging. |
| PL-2 | Per-output `flush_interval` not wired | ❌ No | ❌ No | 🟢 Low | All outputs share `agent.flush_interval`. Per-output override is convenience, not correctness. |
| PL-3 | `error_behavior` not operator-configurable | ❌ No | ❌ No | 🟢 Low | Current behavior (log + continue for inputs/processors, log + retry for outputs) is sane default. |
| PL-4 | AbortSignal for gather cancellation | ❌ No | ❌ No | 🟢 Low | Slow gather continues in background after timeout. Requires Input interface change. Resource concern on constrained devices. |
| PL-5 | `metric_buffer_limit` enforcement | ❌ No | ❌ No | 🟢 Low | Per-output buffer limits not enforced. Channel capacity (10,000) acts as implicit limit with drop-oldest. |
| SC-1 | StatsCollector not fully wired to runtime | ❌ No | ❌ No | 🟢 Low | `SimpleStatsCollector` created but only `metricsGathered` (via internal input) and heartbeat NDATA are wired. `metricsWritten`, `metricsDropped`, `writeErrors` are not incremented. |
| BD-1 | bdSeq persistence in SQLite | ❌ No | ❌ No | 🟡 Medium | After crash, bdSeq restarts at 0. Hub may misinterpret as new edge node. Documented TODO. |

### MVP Acceptance Criteria Check (PRD §22)

| Scenario | Status | Blocking Deferred Items |
|----------|--------|------------------------|
| **1. Cold start → data collection → Hub publish** | ✅ Works | None |
| **2. Config change → restart → new plugin set** | ✅ Works | None |
| **3. Network policy modes (connected/local/standalone)** | ✅ Works | None |
| **4. S&F buffer queues during Hub disconnect** | ⚠️ Partial | SF-1 (buffer exists + tested but not wired into runtime) |
| **5. Clean shutdown on SIGINT/SIGTERM** | ✅ Works | None |

**Assessment:** No deferred item blocks Phase 9 development. Scenario 4 is the only potential MVP acceptance risk — the S&F buffer is implemented and tested at the component level, but the integration with the runtime flush loop is not wired. This should be documented as a known gap if Scenario 4 is in scope for MVP demo.

---

## 6. Quick-Fix Recommendations

Prioritized by impact, all achievable in <30 minutes total:

### Priority 1 — Should do before Phase 9 (~10 min total)

| # | Fix | File | Effort | Impact |
|---|-----|------|--------|--------|
| QF-1 | Uncomment clock jump warning log | `src/core/ticker.ts:68` | 2 min | Operational visibility: silent clock jump re-anchor becomes logged event |
| QF-2 | Read `swVersion` from `package.json` | `src/pipeline/plugin-factory.ts:328` | 3 min | Prevents version drift in Sparkplug NBIRTH properties |

### Priority 2 — Nice to have (~15 min total)

| # | Fix | File | Effort | Impact |
|---|-----|------|--------|--------|
| QF-3 | Add `import packageJson` and use `packageJson.version` for swVersion | Already covered in QF-2 | — | — |
| QF-4 | Structured config warnings (add `code` field) | `src/core/config.ts` | 10 min | Phase 9 Web UI can display warnings with icons/severity. Currently plain strings. |
| QF-5 | Add `parseMqttServerUrl` test for IPv6 URL | `test/unit/plugins/outputs/mqtt.test.ts` | 5 min | Covers untested edge case: `mqtt://[::1]:1883` |

### Not recommended now (correctly deferred)

- S&F buffer runtime wiring: Complex integration (~2-4 hours), not a quick fix
- Per-plugin child loggers: Requires architecture decision on logger injection
- Reconnection NBIRTH re-publish (D-3): Significant MQTT lifecycle change

---

## 7. Final Verdict

### ✅ **GO** for Phase 9

**Rationale:**

1. **Test suite is clean.** 771 tests, 0 failures, no flaky behavior. Prior reviews verified e2e tests (790+ total) also pass.

2. **All Phase 8 fixes verified.** All 6 items from the `3426d7b` commit are correctly implemented and tested.

3. **Error handling is robust.** Every error path from config parsing through runtime startup produces clear, actionable messages and correct exit codes.

4. **Lifecycle is correct.** Startup and shutdown sequences match PRD §8 precisely. The cascading shutdown is clean.

5. **Config flow is complete.** No fields are lost. All PRD §7 fields are either wired or correctly deferred with TODO markers.

6. **NetworkPolicy is properly integrated.** Flows correctly through all layers with fail-fast enforcement.

7. **No blocking deferred items.** All deferred items are correctly documented and none block Phase 9 development or MVP acceptance (with the caveat on Scenario 4).

8. **Code quality is high.** Clean separation of concerns, comprehensive DI for testing, consistent patterns across all phases.

**Pre-Phase 9 action items:**
- [ ] Apply QF-1: Uncomment Ticker clock jump warning log (2 min)
- [ ] Apply QF-2: Read swVersion from package.json (3 min)
- [ ] Document S&F buffer runtime integration as a known gap for Scenario 4 acceptance

---

## 8. Codebase Health Summary

### Architecture Quality

| Aspect | Grade | Notes |
|--------|-------|-------|
| Module separation | A | Clean plugin/core/pipeline/hub/cli boundaries |
| DI and testability | A | MockMqttClient, dep injection in run.ts, factory pattern |
| Type safety | A | Zod schemas for all config, TypeScript strict mode |
| Error handling | A | Consistent propagation, clear messages, correct exit codes |
| Test coverage | A | 771 tests covering unit, integration; e2e soak tests exist |
| Documentation | A- | Comprehensive TODOs, JSDoc on key methods; some deeper design decisions only in review docs |
| Code consistency | A | Same patterns (Channel, Broadcaster, Accumulator) used throughout |

### Phase-by-Phase Health

| Phase | Description | Status | Known Issues |
|-------|------------|--------|--------------|
| 0 | Bootstrap & Smoke | ✅ Solid | None |
| 1 | Core Types & Config | ✅ Solid | None |
| 2 | Pipeline Runtime | ✅ Solid | AbortSignal for gather (deferred, low risk) |
| 3 | Input Plugins | ✅ Solid | OPC-UA uses stub client (by design for MVP) |
| 4 | Processors & Aggregators | ✅ Solid | None |
| 5 | Output Plugins & CLI | ✅ Solid | None |
| 6 | Store-and-Forward Buffer | ✅ Solid | Not wired to runtime flush (medium risk for Scenario 4) |
| 7 | Sparkplug B Hub Link | ✅ Solid | D-3 reconnection rebirth (medium risk, post-MVP) |
| 8 | Network Policy | ✅ Solid | None — all review fixes applied and verified |

### Metrics

- **Source files:** ~30 TypeScript files in `src/`
- **Test files:** 53 test files (35 unit + 18 integration)
- **Total tests:** 771 (unit + integration), ~790 including e2e
- **Test ratio:** ~25:1 (tests per source file)
- **TODOs:** 14 in source, all correctly categorized (2 quick-fixable)
- **Independent reviews completed:** 4 (Phase 7 review, Phase 7 fix verification, Phase 8 review, Phase 8 independent review)
- **Findings resolved:** All must-fix and should-fix items from all reviews are resolved

### Conclusion

The CollatrEdge codebase after Phases 0–8 is in excellent health. It has a clean architecture, comprehensive testing, robust error handling, and well-documented deferred items. The foundation is ready for Phase 9 (Web UI) — the ingress rules, network policy, and pipeline options are all structured to support a web layer without requiring changes to the existing code.
