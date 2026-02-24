# Phase 7 Independent Code Review: Sparkplug B Hub Link

**Reviewer:** Independent sub-agent (second-pass review)
**Date:** 2026-02-24
**Scope:** All Phase 7 source and test files, downstream impact analysis
**Internal review reference:** `plans/phase-7-review.md` (20 findings, 16 fixed)

---

## Summary

Phase 7 delivers a well-structured Sparkplug B Hub Link implementation with clean codec/session separation, proper DI for testing, and comprehensive lifecycle management. The internal review was thorough — it caught critical issues (missing `seq`, CONNACK race, Set iteration mutation) and the fix pass resolved them correctly. However, this independent review found **8 new issues** that the internal review missed, including 2 must-fix protocol correctness problems and a significant data leakage concern with `_device_id` tags persisting into local store and other outputs.

---

## Findings

### 🔴 Must Fix

#### F-1: `addMetric()` mutates the caller's metric object by adding `_device_id` tag

**File:** `src/core/accumulator.ts:67-70`
**Severity:** 🔴 Must Fix

The `addMetric()` method directly mutates the incoming metric:

```typescript
addMetric(metric: Metric): void {
  if (this._deviceId && !metric.hasTag("_device_id")) {
    metric.addTag("_device_id", this._deviceId);  // ← mutates caller's object
  }
  void this.channel.send(metric).then(...)
}
```

This is an aliasing/mutation bug. If a processor calls `acc.addMetric(originalMetric)`, the original metric is permanently modified — all subsequent references to that metric (in other processors, aggregators, or debug logging) will now have a `_device_id` tag they didn't expect.

Contrast with `addFields()` which creates a *new* metric via `createMetric()`, so the injection is safe.

**Fix:** Call `metric.copy()` before mutating, or create the tag in a new metric:
```typescript
addMetric(metric: Metric): void {
  let m = metric;
  if (this._deviceId && !metric.hasTag("_device_id")) {
    m = metric.copy();
    m.addTag("_device_id", this._deviceId);
  }
  void this.channel.send(m).then(...)
}
```

**Why internal review missed it:** Finding 2 in the internal review identified that `addMetric()` was missing `_device_id` injection entirely, and the fix added it — but added it as a mutation rather than a copy. The fix introduced this new bug.

---

#### F-2: NDEATH Will message not updated after `rebirth()` — bdSeq correlation broken

**File:** `src/hub/hub-link.ts:240-250` (rebirth method)
**Severity:** 🔴 Must Fix

PRD §9 states: *"The NDEATH Will message carries the same bdSeq as the corresponding NBIRTH, allowing Hub to correlate births and deaths."*

On `rebirth()`, `bdSeq` is incremented and a new NBIRTH is published with the new `bdSeq`. However, **the MQTT Will message is not updated**. The Will message was set during `start()` with the original `bdSeq=0`. If the broker delivers the Will message after a rebirth (e.g., on ungraceful disconnect after rebirth), the bdSeq in NDEATH won't match the most recent NBIRTH.

The MQTT protocol does not support updating the Will message after CONNECT. The Sparkplug B specification addresses this: after rebirth, the edge node should disconnect and reconnect with a new Will message carrying the updated bdSeq.

**Fix:** `rebirth()` should:
1. Disconnect the current MQTT session
2. Set a new Will message with the new `bdSeq`
3. Reconnect
4. Publish NBIRTH + all DBIRTHs

This is how Eclipse Tahu (reference Sparkplug B implementation) handles it. The current implementation where `rebirth()` only re-publishes NBIRTH without reconnecting means a post-rebirth crash will produce an NDEATH with stale `bdSeq`, and the Hub will fail to correlate the death with the most recent birth.

**Alternative (simpler, for MVP):** Document this as a known limitation and add a TODO. The Hub will still see the NDEATH, it just can't correlate it precisely. Most Hub implementations handle this by treating any NDEATH as "this node is dead, re-request birth on reconnect." But this is a protocol deviation and should be flagged.

---

### 🟡 Should Fix

#### F-3: `_device_id` tag leaks into local store, S&F buffer, file output, stdout output

**Files:** `src/core/accumulator.ts`, `src/plugins/outputs/local-store.ts`, `src/buffer/store-forward.ts`, `src/plugins/outputs/stdout.ts`, `src/plugins/outputs/file.ts`
**Severity:** 🟡 Should Fix (Priority 1)

The `_device_id` tag is injected by `ChannelAccumulator` on every metric from every aliased input. This is an *internal routing tag* used only by `MqttOutput.writeSparkplug()` to group metrics by device. However, this tag flows through the entire pipeline into **every output**:

1. **Local Store (`local-store.ts`):** The `_device_id` tag is included in:
   - The `tags` JSON column (serialized via `tagsToJSON()`)
   - The `tags_hash` computation (via `tagsHash()`)
   - The `tag_index` table (stored in the `tags` column, used in the primary key composite)
   - CSV export (appears as a column in `exportCSV()`)
   
   This means the same metric `temperature` from device `plc_01` has a different `tags_hash` than the same metric without `_device_id`. If `_device_id` is ever removed from the pipeline (e.g., config change removes the alias), historical data will have a different hash and won't group correctly with new data.

2. **S&F Buffer (`store-forward.ts`):** `encodeMetric()` serializes the full metric including all tags. `_device_id` is persisted in the buffer's `payload` BLOB. This is less concerning since the buffer is transient, but it means buffered metrics replay with the internal tag.

3. **File output (`file.ts`):** In CSV mode, `_device_id` appears as a tag column. In JSON mode, it's in the `tags` object.

4. **Stdout output (`stdout.ts`):** Both `toJSON()` and `toLineProtocol()` include all tags.

**Impact analysis:**
- Local store queries that group by tags will include `_device_id` in the grouping, potentially confusing downstream analytics
- CSV exports will contain `_device_id` — production managers seeing this in Excel will be confused by an internal routing tag
- The `tag_index` table will grow larger (separate entries for the same measurement name with different `_device_id` values vs without)
- If an input's alias changes, the metric's `tags_hash` changes, breaking continuity in the local store

**Fix options (in priority order):**
1. **Strip `_device_id` in `MqttOutput.writeSparkplug()` only (already done), but also strip it in the main pipeline loop before broadcasting to outputs.** Add a post-processor step in `runMainLoop()` that strips internal tags (prefixed with `_`) before broadcasting.
2. **Move device routing to metric metadata** instead of tags. Add an optional `sourceDeviceId` field to the Metric interface (or a metadata Map). The MQTT output reads this field for routing. No tag pollution.
3. **Accept the leakage and document it.** The `_device_id` tag becomes useful metadata (which device produced this data). But this needs to be a conscious design decision, not an accident.

Option 2 is cleanest but requires Metric interface changes. Option 1 is quickest. Option 3 might actually be the right call — `_device_id` *is* useful metadata for querying local store data by device. But it needs to be documented and the underscore-prefix naming convention needs to be established.

---

#### F-4: `publishNBirth()` resets `seq` to 0 *after* publishing, creating a double-use of seq=0

**File:** `src/hub/hub-link.ts:291`
**Severity:** 🟡 Should Fix

```typescript
private async publishNBirth(): Promise<void> {
  // ... encode and publish ...
  await this.client.publish(topic, payload, { qos: 0 });
  this.seq = 0;  // ← resets AFTER publish
}
```

The `encodeNBirth()` call hardcodes `seq: 0` in the payload. Then after publishing, `this.seq = 0` is set. The next message (e.g., DBIRTH) will use `this.seq` (which is 0), then call `this.nextSeq()` to set it to 1.

But look at `publishDeviceBirth()`:
```typescript
const payload = encodeDBirth({ seq: this.seq, ... });
await this.client.publish(topic, payload, { qos: 0 });
this.seq = this.nextSeq();
```

After NBIRTH publishes with seq=0 and sets `this.seq = 0`, the DBIRTH reads `this.seq` which is 0, encodes seq=0 in the DBIRTH payload, then increments to 1. **So both NBIRTH and the first DBIRTH have seq=0.** 

Per Sparkplug B spec, NBIRTH is the *only* message at seq=0. The next message (DBIRTH) should be seq=1.

**Fix:** After `publishNBirth()`, set `this.seq = 1` (or set it to 0 before the publish and increment after):
```typescript
private async publishNBirth(): Promise<void> {
  // ... encode and publish ...
  await this.client.publish(topic, payload, { qos: 0 });
  this.seq = 1; // next message starts at 1
}
```

Or better: `publishNBirth()` should use the same `this.seq` / `this.nextSeq()` pattern as other publish methods, but starting from 0:
```typescript
this.seq = 0; // Reset before NBIRTH
const payload = encodeNBirth({ ... }); // seq: 0 is hardcoded
await this.client.publish(topic, payload, { qos: 0 });
this.seq = this.nextSeq(); // now 1
```

---

#### F-5: `RealMqttClient.onConnect()` / `onError()` / etc. overwrite deferred handlers, losing earlier registrations

**File:** `src/core/mqtt-client.ts:103-120`
**Severity:** 🟡 Should Fix

In `hub-link.ts:start()`, the flow is:
1. `this.client.onClose(handler)` — sets `_deferredClose`
2. `this.client.onConnect(handler)` — sets `_deferredConnect`
3. `this.client.onError(handler)` — sets `_deferredError`
4. `this.client.connect(...)` — creates underlying client, wires deferred handlers, clears them
5. (later) `this.client.onError(replacementHandler)` — calls `this.client.on("error", handler)` which **adds** a second listener

Step 5 is a subtle bug in `RealMqttClient`: after `connect()`, calling `onError()` again calls `this.client.on("error", handler)`, which in Node.js EventEmitter style *adds* a new listener without removing the old one. So the connection-rejection handler from step 3 remains active even after step 5 replaces it. If an error occurs after startup, BOTH handlers fire — the old one tries to reject an already-resolved Promise, which is harmless but wasteful.

Before `connect()`, the deferred pattern means only one handler is stored per event type. But the on*() methods don't track whether they've been called before, so re-registering after connect keeps adding listeners.

**Fix:** `RealMqttClient.on*()` methods should `removeAllListeners(eventName)` before adding the new one, or track the current handler and swap it. The `hub-link.ts` pattern of re-registering `onError()` after connect should work cleanly.

---

#### F-6: `rebirth()` re-publishes DBIRTH only for devices with non-empty `initialMetrics`

**File:** `src/hub/hub-link.ts:252-257`
**Severity:** 🟡 Should Fix

```typescript
async rebirth(): Promise<void> {
  // ...
  for (const [deviceId, device] of this.devices) {
    if (device.initialMetrics.length > 0) {
      await this.publishDeviceBirth(deviceId, device.initialMetrics);
    }
  }
}
```

In `runtime.ts:433`, devices are registered with `initialMetrics: []` (empty):
```typescript
this.options.hubLink.registerDevice({
  deviceId: input.alias,
  ...
  initialMetrics: [],  // ← always empty at registration
});
```

This means after a rebirth, NO DBIRTH will be re-published for any device, because `initialMetrics` is always empty. The `initialMetrics` are never updated after the first DBIRTH auto-publish (which uses the runtime metrics from `publishDeviceData()`, not `device.initialMetrics`).

The rebirth sequence should re-publish DBIRTH for all devices that previously had a DBIRTH published, using their most recently known metric set. Currently the `deviceBirthPublished` set is cleared in `rebirth()` before the DBIRTH loop, so the auto-DBIRTH on next `publishDeviceData()` will fire — but this means there's a window where the Hub thinks the device exists (from NBIRTH) but has no DBIRTH, which is a protocol gap.

**Fix:** Track the last-known metrics for each device (update in `publishDeviceBirth()`) and use those in `rebirth()`:
```typescript
private lastKnownMetrics = new Map<string, Metric[]>();

async publishDeviceBirth(deviceId: string, metrics: Metric[]): Promise<void> {
  this.lastKnownMetrics.set(deviceId, metrics);
  // ... existing code ...
}

async rebirth(): Promise<void> {
  // ...
  for (const [deviceId] of this.devices) {
    const metrics = this.lastKnownMetrics.get(deviceId);
    if (metrics && metrics.length > 0) {
      await this.publishDeviceBirth(deviceId, metrics);
    }
  }
}
```

---

#### F-7: NBIRTH published with QoS 0 — should be QoS 1 per Sparkplug B spec

**File:** `src/hub/hub-link.ts:288`
**Severity:** 🟡 Should Fix

All publishes in `hub-link.ts` use `{ qos: 0 }`. The Sparkplug B specification requires:
- **NBIRTH, NDEATH:** QoS 0 (NDEATH is in the Will, which has its own QoS setting — already set to QoS 1 in `setWill()`)
- **DBIRTH, DDEATH:** QoS 0
- **DDATA, NDATA:** QoS 0

Actually, reviewing the Sparkplug B specification more carefully, QoS 0 is standard for all Sparkplug B messages because the seq number mechanism provides its own message-loss detection (seq gaps trigger rebirth). The current implementation is correct.

**Retracted — not a finding.** QoS 0 is correct per Sparkplug B spec.

---

#### F-8: No graceful handling when `publishDeviceData()` is called for an unregistered device

**File:** `src/hub/hub-link.ts:195-196`
**Severity:** 🟡 Should Fix

```typescript
async publishDeviceData(deviceId: string, metrics: Metric[]): Promise<void> {
  if (!this.deviceBirthPublished.has(deviceId)) {
    await this.publishDeviceBirth(deviceId, metrics);
  }
  // ...
}

async publishDeviceBirth(deviceId: string, metrics: Metric[]): Promise<void> {
  const device = this.devices.get(deviceId);
  if (!device) return;  // ← silently returns
  // ...
}
```

If `publishDeviceData()` is called with a `deviceId` that was never registered (e.g., metrics from an input without an alias that somehow got a `_device_id` tag, or the "unknown" fallback from `MqttOutput.writeSparkplug()`), `publishDeviceBirth()` silently returns. Then `publishDeviceData()` continues and tries to get aliases from `this.aliases.get(deviceId)` which returns `undefined`, causing it to return early too. The metrics are silently dropped.

This is especially concerning because `MqttOutput.writeSparkplug()` groups metrics by `_device_id` tag with a fallback to `"unknown"`:
```typescript
const deviceId = metric.getTag(DEVICE_ID_TAG) ?? "unknown";
```

Metrics without `_device_id` (e.g., from inputs without aliases, or metrics that lost the tag through processing) will all be routed to device `"unknown"`, and then **silently dropped** because `"unknown"` is never registered.

**Fix:** Either:
1. Log a warning when `publishDeviceData()` is called for an unregistered device
2. Auto-register the device on first data (with `pluginType: "unknown"`)
3. In `MqttOutput.writeSparkplug()`, skip metrics without `_device_id` instead of routing to "unknown"

---

### 🟢 Nice to Have

#### F-9: `encodeDBirth()` attaches device properties only to the first metric

**File:** `src/hub/sparkplug-codec.ts:182-192`
**Severity:** 🟢 Nice to Have

```typescript
if (spMetrics.length > 0) {
  const props = { ... };
  spMetrics[0]!.properties = props;
}
```

The Sparkplug B spec says device properties should be included in DBIRTH. Attaching them to the first metric works but is fragile — if the metric ordering changes, a Hub consumer looking for properties on a specific metric name will break. The more robust approach is to include a dedicated "device info" metric or attach properties to all metrics.

This is cosmetic and works fine with standard Hub implementations (Ignition, EMQX). 

---

## PRD Compliance Table

| Module | PRD Section | Compliance | Issues |
|--------|-------------|------------|--------|
| `sparkplug-codec.ts` | §9 (data types, aliases, msg format) | ✅ Compliant | Type mapping correct. All 6 FieldValue types handled. FNV-1a alias per spec. seq in all message types. |
| `sparkplug-codec.ts` | Appendix C (topic map payloads) | ✅ Compliant | NBIRTH has bdSeq, Rebirth, Config Version, Properties, Agent Metrics. NDEATH has bdSeq. DBIRTH has full metrics with aliases. |
| `hub-link.ts` | §9 (session lifecycle) | ⚠️ Mostly compliant | Will message bdSeq not updated on rebirth (F-2). Seq double-use at 0 (F-4). DBIRTH not re-published on rebirth for devices with empty initialMetrics (F-6). |
| `hub-link.ts` | §9 (topic structure) | ✅ Compliant | All topics match `spBv1.0/{group_id}/{msgType}/{edge_node_id}[/{device_id}]`. |
| `hub-link.ts` | §9 (sequence numbers) | ⚠️ Mostly compliant | bdSeq wraps at 255 ✅. seq wraps at 255 ✅. seq resets on NBIRTH ⚠️ (double-use, F-4). bdSeq not persisted (documented TODO). |
| `hub-link.ts` | §9 (control plane) | ✅ Compliant | NCMD/Rebirth handled. Config push deferred (documented). NDATA heartbeat works. |
| `mqtt.ts` (output) | §19 (outputs.mqtt) | ✅ Compliant | Sparkplug mode routes by device. Plain mode publishes JSON. Config schema correct. |
| `mqtt-types.ts` | §9 (MQTT interface) | ✅ Compliant | All methods present. publish, setWill, connect, subscribe, disconnect. |
| `mqtt-client.ts` | §9 (single connection) | ⚠️ Mostly compliant | Handler overwrite issue (F-5). Otherwise clean wrapper. |
| `accumulator.ts` | §9 (device routing) | ⚠️ Issues | `addMetric()` mutates caller's metric (F-1). `_device_id` leaks to all outputs (F-3). |
| `config.ts` | §9 (hub schema) | ✅ Compliant | All fields: enabled, group_id, edge_node_id, broker, tls_cert, tls_key, heartbeat_interval. |
| `plugin-factory.ts` | §8 (startup), §9 (hub creation) | ✅ Compliant | Hub link created when enabled. Stats collector wired. MQTT output gets hub link reference. |
| `runtime.ts` | §8 (lifecycle ordering) | ✅ Compliant | Hub link starts after output connect, stops after pipeline drain. Device registration before input start. |
| `plugin-schemas.ts` | — | ✅ Compliant | `outputs.mqtt` registered. |
| `config-init.ts` | Appendix A | ✅ Compliant | Hub section included for connected mode. MQTT output template with sparkplug and plain examples. |

---

## Internal Review Quality Grade: **B+**

The internal review (`phase-7-review.md`) was thorough and well-structured:

**Strengths:**
- Caught 4 critical must-fix issues including the protocol-breaking missing `seq`
- Identified the `addMetric()` `_device_id` gap and the Set mutation bug
- CONNACK race condition catch was excellent
- Fix pass was clean — 16/20 findings resolved in a single commit
- All deferred items were justified

**Weaknesses:**
- The `addMetric()` fix (Finding 2) introduced a new mutation bug (F-1 in this review)
- Did not check downstream impact of `_device_id` tags on other outputs/stores (F-3)
- Missed the NDEATH Will message / bdSeq stale correlation after rebirth (F-2)
- Missed the seq double-zero issue (F-4)
- Missed the rebirth DBIRTH gap for empty initialMetrics (F-6)
- Did not analyze the `"unknown"` device fallback path in MQTT output (F-8)

The internal review caught the obvious issues well but missed some of the deeper protocol-level and cross-module interaction issues that require reading the Sparkplug B spec more carefully and tracing data flow across module boundaries.

---

## `_device_id` Tag Persistence Impact Analysis

### Current Behavior

`_device_id` is injected by `ChannelAccumulator` when an input has an alias. It flows through:

```
Input (with alias) → Accumulator (injects _device_id) → Channel → Processors → Aggregators → Broadcaster → ALL output channels
```

### Impact by Component

| Component | Sees `_device_id`? | Impact | Severity |
|-----------|-------------------|--------|----------|
| **Local Store** | ✅ Yes | Stored in `tags` JSON, affects `tags_hash`, `tag_index`. Changes metric grouping identity. Appears in CSV export. | Medium |
| **S&F Buffer** | ✅ Yes | Stored in `payload` BLOB via `encodeMetric()`. Replayed with tag on recovery. | Low |
| **File Output** | ✅ Yes | Appears in JSON output and as CSV column. Visible to end users. | Medium |
| **Stdout Output** | ✅ Yes | Appears in both JSON and line protocol format. | Low (debug tool) |
| **MQTT Output (Sparkplug)** | ✅ Yes → stripped | Works correctly: copies metric, strips tag, routes by device. | None |
| **MQTT Output (Plain)** | ✅ Yes | Tag included in JSON payload. May confuse downstream consumers. | Low |
| **Processors (rename, filter)** | ✅ Yes | `_device_id` participates in `tagpass`/`tagdrop` filters. Could be matched or filtered unintentionally. | Low |
| **Aggregators (basicstats)** | ✅ Yes | Metrics with different `_device_id` values are treated as separate series. This is actually correct behavior — you want per-device aggregation. | Positive |

### Recommendation

The `_device_id` tag is a **useful piece of metadata** (which input produced this data) and its presence in local store/file output is arguably valuable. However:

1. It should be **documented** as a system-injected tag (convention: `_` prefix = internal)
2. The `_` prefix convention should be established in CLAUDE.md or the PRD
3. Users should be able to strip it via `tagdrop = ["_device_id"]` on outputs where they don't want it
4. The mutation bug in `addMetric()` (F-1) must be fixed regardless

**Verdict:** Accept `_device_id` leakage as intentional metadata. Document it. Fix the mutation bug.

---

## `seq` / Audit Trail Considerations

### Current State

The `seq` number is a Sparkplug B protocol concept — a 0-255 wrapping counter used for message-loss detection. It exists only in the MQTT wire protocol payloads and is not persisted anywhere in CollatrEdge.

### Do existing schemas need a `seq` column?

| Schema | Need `seq`? | Reasoning |
|--------|-------------|-----------|
| **Local Store** (`data_YYYY_MM_DD.db`) | ❌ No | The local store records *processed metrics*, not *what was sent to Hub*. `seq` is a transport concern, not a data concern. Adding `seq` would couple the local store to the Sparkplug protocol. |
| **S&F Buffer** (`buffer_*` tables) | ❌ No | The buffer stores metrics waiting to be sent. The `seq` is assigned at publish time by `HubLink`, not at buffer-insertion time. Adding `seq` at buffer time would be wrong — the actual `seq` depends on what else was published between buffer-insert and buffer-drain. |
| **Audit Log** | 🟡 Maybe (post-MVP) | For compliance-sensitive deployments, logging what was sent to Hub (topic, seq, timestamp) would enable audit trail reconstruction. This could be a separate `hub_send_log` table or an audit log entry type. |

### Can the local store reconstruct what was sent to Hub?

**No, and it shouldn't need to.** The local store records what data was collected. The Hub records what data was received. The `seq` numbers are ephemeral transport metadata. If you need to audit "was this metric sent to Hub?", that's a job for:
1. The S&F buffer acknowledgment model (metrics are removed after successful delivery)
2. Hub-side logging (what arrived)
3. A future audit log entry at send time

### Recommendation

No schema changes needed for `seq`. Post-MVP: consider a `hub_audit` table for regulated deployments that need to prove what was transmitted.

---

## GO / NO-GO Decision

### 🟡 CONDITIONAL GO — Fix F-1 and F-4 before Phase 8

**Must fix before Phase 8:**
- **F-1** (`addMetric()` mutation): This is a correctness bug that will cause subtle issues when processors generate metrics. Quick fix (add `.copy()` call).
- **F-4** (seq double-zero): Both NBIRTH and first DBIRTH have seq=0. This is a protocol violation that could cause Hub implementations to flag a missed message. Quick fix (set `this.seq = 1` after NBIRTH publish).

**Should fix during early Phase 8 (when context arises):**
- **F-2** (Will message bdSeq stale after rebirth): Document as known limitation for MVP. The Hub will still function — it just can't precisely correlate post-rebirth deaths. Fix properly when connection lifecycle management is enhanced.
- **F-3** (`_device_id` leakage): Accept and document. The tag is actually useful metadata. Establish `_` prefix convention.
- **F-5** (handler overwrite in RealMqttClient): Low risk since the duplicate handler is harmless. Fix when touching mqtt-client.ts next.
- **F-6** (rebirth DBIRTH gap): Fix by tracking last-known metrics per device. The auto-DBIRTH on next data publish provides a workaround, but there's a brief protocol gap.
- **F-8** (silent drop of "unknown" device metrics): Add a warning log at minimum.

**Phase 8 can proceed** after F-1 and F-4 are fixed. These are both single-line fixes with no architectural impact. The remaining findings are either documented limitations (F-2), design decisions to formalize (F-3), or low-probability edge cases (F-5, F-6, F-8).

---

## Appendix: Test Coverage of Hard Paths

| Hard Path | Tested? | Notes |
|-----------|---------|-------|
| MQTT publish failure mid-batch (sparkplug) | ❌ No | `writeSparkplug()` catches errors per device group but no test exercises this |
| Hub link connection loss during operation | ❌ No | `onClose` handler sets `_connected = false` but no test verifies behavior of publish calls while disconnected |
| Reconnection after connection loss | ❌ No | The underlying `mqtt` library handles reconnect, but Hub link doesn't re-publish NBIRTH on reconnect |
| Partial publish failure (some devices succeed, others fail) | ❌ No | Each device group is published independently with try/catch, but untested |
| `publishDeviceData()` for unregistered device | ❌ No | Silent drop path (F-8) |
| `addMetric()` with pre-existing `_device_id` tag | ⚠️ Implicit | The `!metric.hasTag("_device_id")` guard exists but isn't specifically tested |
| NBIRTH when no devices registered | ✅ Yes | `start()` tests verify NBIRTH without devices |
| Multiple rebirth in sequence | ❌ No | Only single rebirth tested |
| Heartbeat publish failure | ⚠️ Implicit | `publishHeartbeat()` has error catch, but not specifically tested |
| `bdSeq` wrap at 255 | ❌ No | Only seq wrap tested, not bdSeq |

---

## Files Reviewed

### Source
- `src/hub/sparkplug-codec.ts` ✅
- `src/hub/hub-link.ts` ✅
- `src/plugins/outputs/mqtt.ts` ✅
- `src/core/mqtt-types.ts` ✅
- `src/core/mqtt-client.ts` ✅
- `src/core/accumulator.ts` ✅
- `src/core/config.ts` ✅
- `src/pipeline/runtime.ts` ✅
- `src/pipeline/plugin-factory.ts` ✅
- `src/plugins/inputs/mqtt-consumer.ts` ✅
- `src/core/plugin-schemas.ts` ✅
- `src/cli/commands/config-init.ts` ✅
- `src/plugins/outputs/local-store.ts` ✅ (downstream impact)
- `src/plugins/outputs/stdout.ts` ✅ (downstream impact)
- `src/plugins/outputs/file.ts` ✅ (downstream impact)
- `src/buffer/store-forward.ts` ✅ (downstream impact)
- `src/core/metric.ts` ✅ (tag mutation analysis)

### Tests
- `test/unit/spike/sparkplug-payload.test.ts` ✅
- `test/unit/core/mqtt-client.test.ts` ✅
- `test/unit/hub/sparkplug-codec.test.ts` ✅
- `test/unit/hub/hub-link.test.ts` ✅
- `test/unit/plugins/outputs/mqtt.test.ts` ✅
- `test/integration/hub-link-pipeline.test.ts` ✅
- `test/integration/mqtt-output-pipeline.test.ts` ✅
- `test/integration/sparkplug-lifecycle.test.ts` ✅
- `test/helpers/mock-mqtt-client.ts` ✅
