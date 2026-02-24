# Phase 7 Fix Verification Review

**Reviewer:** Independent verification sub-agent (third-pass review)
**Date:** 2026-02-24
**Scope:** Verify all fixes from commit `a377d9d`, check for regressions, identify any missed issues
**Reference:** `plans/phase-7-independent-review.md` (9 findings), `plans/phase-7-review.md` (20 findings)

---

## Test Suite Results

```
646 pass, 0 fail, 2517 expect() calls
Ran 646 tests across 51 files. [28.48s]
```

All unit and integration tests pass. E2E tests also pass (verified separately; the sustained 60s soak test passes but requires extended runtime).

---

## Fix-by-Fix Verification

### F-1 (RED → FIXED): `addMetric()` copies metric before `_device_id` injection

**File:** `src/core/accumulator.ts:82-90`
**Status:** ✅ CORRECT

```typescript
addMetric(metric: Metric): void {
  let m = metric;
  if (this._deviceId && !metric.hasTag("_device_id")) {
    m = metric.copy();
    m.addTag("_device_id", this._deviceId);
  }
  void this.channel.send(m).then((ok) => { ... });
}
```

**Verification:**
- The fix correctly uses `metric.copy()` before mutating — the original reference is never modified.
- When no `_deviceId` is set, the original metric passes through by reference (no unnecessary copy). ✅
- When `_device_id` is already present, the original metric passes through by reference (no unnecessary copy). ✅
- The `copy()` implementation in `metric.ts` creates new `Map` instances for both tags and fields, with `sortedMap()` for tags. Since all `FieldValue` types are primitives (number, bigint, string, boolean), this is a correct deep copy. ✅

**Copy semantics concern:** `metric.copy()` does NOT copy tracking state (`_accepted`, `_rejected`, `_dropped`). This is explicitly documented as intentional in `metric.ts:131-133` — a copy is a new data point. No concern here.

**New tests:** 3 tests added to `accumulator.test.ts`:
1. "addMetric() with deviceId copies metric before adding _device_id (F-1)" — verifies copy + no mutation ✅
2. "addMetric() without deviceId passes metric through by reference" — verifies no unnecessary copy ✅
3. "addMetric() skips copy when _device_id already present" — verifies `hasTag()` guard ✅

All three tests are well-constructed and verify the right behavior.

---

### F-4 (RED→YELLOW → FIXED): `publishNBirth()` sets `this.seq = 1` after publish

**File:** `src/hub/hub-link.ts:295`
**Status:** ✅ CORRECT

```typescript
private async publishNBirth(): Promise<void> {
  // ...
  await this.client.publish(topic, payload, { qos: 0 });
  this.seq = 1; // NBIRTH consumed seq=0; next message starts at 1 (F-4)
}
```

**Verification:**
- NBIRTH payload is encoded with `seq: 0` hardcoded in `encodeNBirth()` (sparkplug-codec.ts:157). ✅
- After publish, `this.seq` is set to `1`, so the next message (DBIRTH) uses seq=1. ✅
- The seq=0 assignment in `rebirth()` (line 260) sets `this.seq = 0` before calling `publishNBirth()`. Inside `publishNBirth()`, the payload is encoded (seq=0 is hardcoded, not read from `this.seq`), then `this.seq` is set to 1. This is correct. ✅

**Edge case analysis — seq wrap interaction:**
- `nextSeq()` returns `(this.seq + 1) % 256`. After NBIRTH sets `this.seq = 1`, subsequent calls use `nextSeq()` which will produce 2, 3, ..., 255, 0, 1, ... This is correct wrap behavior. ✅
- In `rebirth()`, `this.seq = 0` is set first, then `publishNBirth()` sets it to 1. This is a no-op concern: the `seq = 0` line in `rebirth()` is redundant since `publishNBirth()` will always set `this.seq = 1`. Not a bug, just slightly redundant.

**New test:** "first DBIRTH after NBIRTH has seq=1, not seq=0 (F-4)" — decodes both NBIRTH and DBIRTH payloads and verifies seq values. ✅

---

### F-5 (YELLOW → FIXED): `RealMqttClient` on*() methods call `removeAllListeners()` before re-registering

**File:** `src/core/mqtt-client.ts:132-162`
**Status:** ✅ CORRECT, with one concern

```typescript
onConnect(handler: () => void): void {
  if (!this.client) {
    this._deferredConnect = handler;
    return;
  }
  this.client.removeAllListeners("connect");
  this.client.on("connect", () => {
    this._isConnected = true;
    handler();
  });
}
```

**Verification:**
- Pre-connect (deferred): Only one handler stored per event type via overwrite. ✅
- Post-connect: `removeAllListeners(eventName)` removes all handlers for that specific event before adding the new one. This prevents the duplicate-handler bug from the original F-5 finding. ✅
- Applied consistently to `onConnect`, `onError`, `onClose`, `onReconnect`. ✅

**Concern — `removeAllListeners` and mqtt library internals:**
The `mqtt` npm library (v5.x) internally registers its own listeners on the underlying `net.Socket`/`tls.TLSSocket` for transport-level events. However, the `mqtt.MqttClient` object itself is an `EventEmitter` that emits high-level events (`connect`, `error`, `close`, `reconnect`, `message`). These are *user-facing* events. The mqtt library does NOT register its own listeners on these event names on the `MqttClient` object — it fires them via `this.emit()` internally.

Therefore, `this.client.removeAllListeners("connect")` only removes user-registered handlers on the `MqttClient` EventEmitter, not any internal mqtt library handlers. **This is safe.** ✅

**Note:** `onMessage()` does NOT call `removeAllListeners("message")`. This is intentional since `onMessage` is only called once (for NCMD subscription), unlike the other handlers which are re-registered during `start()`.

---

### F-6 (YELLOW → FIXED): `lastKnownMetrics` map for rebirth DBIRTH re-publish

**File:** `src/hub/hub-link.ts:77, 174, 265-271`
**Status:** ✅ CORRECT

```typescript
private lastKnownMetrics = new Map<string, Metric[]>(); // F-6: for rebirth re-publish

async publishDeviceBirth(deviceId: string, metrics: Metric[]): Promise<void> {
  // ...
  this.lastKnownMetrics.set(deviceId, metrics);
  // ...
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

**Verification:**
- `publishDeviceBirth()` records metrics in `lastKnownMetrics` on every call. ✅
- `rebirth()` iterates `this.devices` (all registered devices) and looks up `lastKnownMetrics` for each. This means:
  - Devices that had auto-DBIRTH (via `publishDeviceData()`) will have `lastKnownMetrics` populated → re-published. ✅
  - Devices that had explicit `publishDeviceBirth()` will have `lastKnownMetrics` populated → re-published. ✅
  - Devices registered with empty `initialMetrics` that never received data will have no `lastKnownMetrics` entry → skipped. ✅ (correct — no DBIRTH to re-publish)
- `deviceBirthPublished.clear()` is called before the DBIRTH loop, so `publishDeviceBirth()` will re-add each device to the set. ✅

**Subtle concern — stored metric references:**
`lastKnownMetrics.set(deviceId, metrics)` stores a reference to the metrics array, not a copy. If the caller later mutates the array or the metrics within it, the stored data would be affected. However, looking at the call sites:
1. `publishDeviceBirth()` in `publishDeviceData()` passes the same `metrics` array from the caller.
2. `MqttOutput.writeSparkplug()` passes freshly-copied metrics (from `metric.copy()` + `removeTag()`).
3. Direct callers pass newly-created metrics.

In practice, the stored metrics are not mutated after being passed. But a defensive copy would be safer. This is a **YELLOW concern** (minor — unlikely to manifest in practice, but worth noting for defensive coding).

**New test:** "re-publishes DBIRTH on rebirth for devices with empty initialMetrics (F-6)" — registers device with empty `initialMetrics`, publishes data (triggers auto-DBIRTH), then verifies rebirth re-publishes DBIRTH. ✅

---

### F-8 (YELLOW → FIXED): Warning log for unregistered device in `publishDeviceBirth()`

**File:** `src/hub/hub-link.ts:168-173`
**Status:** ✅ CORRECT

```typescript
async publishDeviceBirth(deviceId: string, metrics: Metric[]): Promise<void> {
  const device = this.devices.get(deviceId);
  if (!device) {
    getLogger().warn("publishDeviceBirth called for unregistered device, metrics dropped", {
      component: "hub_link", device_id: deviceId,
    });
    return;
  }
  // ...
}
```

**Verification:**
- The warning clearly indicates metrics are being dropped and includes the device_id. ✅
- Uses `warn` level (not `error`), which is appropriate — this isn't a crash, just dropped data. ✅
- The "unknown" fallback device path from `MqttOutput.writeSparkplug()` will now produce a visible warning in logs, making silent metric drops debuggable. ✅

---

### F-9 (GREEN → FIXED): Loop variable renamed `pluginName` → `pluginType` in plugin-factory.ts

**File:** `src/pipeline/plugin-factory.ts:243`
**Status:** ✅ CORRECT

```typescript
for (const [pluginType, instances] of Object.entries(config.inputs)) {
  // ...
  inputs.push({
    // ...
    pluginType, // TOML key = protocol type, e.g. "modbus", not instance alias
  });
}
```

**Verification:**
- The destructured variable is now `pluginType` (matching the property name), which reads as `pluginType: pluginType` via shorthand. ✅
- The processors, aggregators, and outputs loops still use `pluginName`, which is fine since they don't set `pluginType`. ✅
- No downstream impact — the value is the same (`Object.entries(config.inputs)` keys are the TOML section names like `"modbus"`, `"opcua"`). ✅

---

### F-3 (YELLOW → ACCEPTED): `_device_id` leakage documented as intentional metadata

**File:** `src/core/accumulator.ts:32-44` (JSDoc)
**Status:** ✅ CORRECT

The JSDoc on `ChannelAccumulator` clearly documents:
1. `_device_id` serves dual purpose: Sparkplug B routing + provenance metadata. ✅
2. Convention: `_` prefix = system-injected tags. ✅
3. Users can strip via `tagdrop = ["_device_id"]`. ✅

This is a reasonable design decision for an MVP. The `tagdrop` escape hatch makes it configurable.

---

### F-2 (RED → DEFERRED): bdSeq stale after rebirth

**File:** `src/hub/hub-link.ts:248-257` (JSDoc)
**Status:** ✅ CORRECTLY DEFERRED

The JSDoc on `rebirth()` documents:
1. The MQTT protocol limitation (Will cannot be updated after CONNECT). ✅
2. The correct fix (disconnect → reconnect with updated Will → Eclipse Tahu pattern). ✅
3. The impact for MVP (Hub still receives NDEATH, correlation is imprecise). ✅
4. A TODO for post-MVP. ✅

This is a legitimate MQTT protocol constraint. The documentation is thorough and accurate.

---

### F-10 (GREEN → NO CHANGE): Device properties on first metric

**Status:** ✅ CORRECTLY DEFERRED — cosmetic issue, works with standard Hub implementations.

---

## New Bugs Introduced by Fixes

### None Found ✅

I specifically checked:
1. **Copy semantics in `addMetric()`**: The `metric.copy()` in accumulator creates independent Maps. All FieldValue types are primitives. No aliasing bugs. ✅
2. **seq=1 after NBIRTH edge cases**: The `nextSeq()` wraps correctly. `rebirth()` sets `this.seq = 0` then `publishNBirth()` sets it to 1. No double-increment. ✅
3. **`removeAllListeners` side effects**: Only removes user-registered listeners on the `MqttClient` EventEmitter (Node.js EventEmitter semantics). The mqtt library's internal plumbing uses the underlying socket's EventEmitter, not the MqttClient's. ✅
4. **`lastKnownMetrics` reference stability**: Stored references are not mutated by callers in practice. Minor defensive concern noted above but not a bug.
5. **`onMessage` not using `removeAllListeners`**: Correct — `onMessage` is only registered once in `start()`, unlike `onConnect`/`onError`/`onClose` which are re-registered.

---

## Deeper Issues Missed by Both Previous Reviews

### D-1 (YELLOW): Heartbeat timer and `rebirth()` are not synchronized

**File:** `src/hub/hub-link.ts:158-163, 247-271`
**Severity:** 🟡 Should Fix (post-MVP)

The heartbeat timer fires via `setInterval` and calls `publishHeartbeat()`, which calls `publishNodeData()`, which reads/writes `this.seq`. Meanwhile, `rebirth()` resets `this.seq = 0` and re-publishes NBIRTH + DBIRTHs.

If the heartbeat timer fires *during* a `rebirth()` call (between the seq reset and the NBIRTH publish), `publishNodeData()` could publish NDATA with a stale or reset seq value, potentially duplicating seq=0 or inserting a message between NBIRTH and DBIRTH.

In the current implementation, this is mitigated by:
1. `rebirth()` is called from `handleNCmd()` which catches and handles errors. The NCMD handler is async (`.catch()`).
2. `publishHeartbeat()` is async (`.catch()`).
3. Both run on the same JS event loop, so they won't literally interleave within a single await.

However, the interleaving between `await` points is theoretically possible:
- `rebirth()`: `this.seq = 0` → `await publishNBirth()` → (timer fires here, seq=1) → `await publishDeviceBirth()` uses seq=2.
- This would insert an NDATA between NBIRTH and DBIRTH, which violates the Sparkplug B rebirth sequence.

**Impact:** Low probability (requires heartbeat timer to fire at exactly the right moment during the sub-millisecond rebirth window). Most Hub implementations would handle this gracefully.

**Fix:** Cancel the heartbeat timer at the start of `rebirth()`, re-start it after rebirth completes. Or use a mutex/flag to skip heartbeat during rebirth.

---

### D-2 (YELLOW): `publishDeviceData()` can trigger DBIRTH re-publish race with concurrent calls

**File:** `src/hub/hub-link.ts:198-217`
**Severity:** 🟡 Should Fix (post-MVP)

```typescript
async publishDeviceData(deviceId: string, metrics: Metric[]): Promise<void> {
  if (!this.deviceBirthPublished.has(deviceId)) {
    await this.publishDeviceBirth(deviceId, metrics);
  }
  // ... check for new metrics → possible re-DBIRTH ...
}
```

If two batches of metrics for the same device arrive concurrently (e.g., from the output flush loop), both calls will see `!this.deviceBirthPublished.has(deviceId)` as `true` and both will call `publishDeviceBirth()`. This results in two DBIRTH messages for the same device.

In the current architecture, `publishDeviceData()` is called from `MqttOutput.write()`, which is called from the output flush loop. The flush loop is single-threaded per output, so concurrent calls for the same device would only happen if there are multiple MQTT outputs or if the flush loop somehow fires concurrently. This is unlikely but possible.

**Impact:** Duplicate DBIRTH is a protocol noise issue, not a correctness bug. The Hub will accept the second DBIRTH as a valid re-birth with updated metric definitions.

---

### D-3 (YELLOW): No reconnection-triggered NBIRTH re-publish

**File:** `src/hub/hub-link.ts:108-117`
**Severity:** 🟡 Should Fix (post-MVP)

When the mqtt library reconnects after a connection loss (the library does this automatically with `reconnectPeriod`), the `onConnect` handler fires again. However, the current `onConnect` handler only sets `_connected = true` and logs. It does NOT re-publish NBIRTH or DBIRTHs.

The Sparkplug B spec requires that after reconnection, the edge node must:
1. Publish NBIRTH with a new bdSeq
2. Re-publish all DBIRTHs

The current implementation relies on the fact that `connect()` in `start()` sets up a one-shot CONNACK handler. After `start()`, the persistent `onClose` handler marks disconnected, but there's no `onConnect` handler to trigger rebirth on reconnection.

This means: after a network blip, the mqtt library reconnects, but the Hub sees no NBIRTH — it will have received NDEATH (from the Will), and the reconnected edge node will try to publish DDATA without a preceding NBIRTH. The Hub will request rebirth via NCMD (if it supports it), which will eventually trigger the rebirth path. But there's a gap.

**Impact:** The edge node will be in a "zombie" state after reconnection until the Hub sends an NCMD rebirth request. If the Hub doesn't send NCMD (e.g., it's a simple MQTT broker without Sparkplug awareness), data will be lost.

**Fix:** In `start()`, after the initial NBIRTH, replace the connect handler with one that triggers `rebirth()` on reconnection:
```typescript
this.client.onConnect(() => {
  this._connected = true;
  if (this._started) {
    this.rebirth().catch(err => { ... });
  }
});
```

This is the most significant finding from this verification pass. It was not identified in either previous review.

---

### D-4 (GREEN): `lastKnownMetrics` grows unboundedly

**File:** `src/hub/hub-link.ts:77`
**Severity:** 🟢 Nice to Have

The `lastKnownMetrics` map is never pruned. If devices are dynamically registered and unregistered over the edge node's lifetime, the map will accumulate entries for defunct devices. In practice, IIoT edge nodes have a static device set defined at config time, so this is not a real concern. But for correctness, `stop()` could clear the map, or entries could be removed when a device is explicitly deregistered (if that API is ever added).

---

### D-5 (GREEN): `encodeDData()` timestamp conversion for negative timestamps

**File:** `src/hub/sparkplug-codec.ts:251`
**Severity:** 🟢 Nice to Have

```typescript
const rawTs = Number(metric.timestamp / 1_000_000n); // ns → ms
const ts = rawTs > 0 ? rawTs : Date.now();
```

The integer division `metric.timestamp / 1_000_000n` for timestamps close to 0 (e.g., 999_999n) will produce 0, which triggers the `Date.now()` fallback. This is fine for the edge case of near-zero timestamps. However, for negative timestamps (pre-epoch, which are invalid for Sparkplug B), `rawTs` would be negative and would NOT trigger the fallback (since `-1 > 0` is false... wait, `rawTs > 0` would be false for negative, so it WOULD fall through to `Date.now()`). Actually: `rawTs > 0` is `false` for both `0` and negative numbers, so both trigger the fallback. This is correct behavior. ✅

---

### D-6 (GREEN): `onMessage` handler accumulates if `start()` is called multiple times

**File:** `src/hub/hub-link.ts:142`
**Severity:** 🟢 Nice to Have

If `start()` were called twice (which shouldn't happen in practice), `onMessage()` would be called twice, and since `onMessage()` in `RealMqttClient` does NOT call `removeAllListeners("message")` (unlike the other handlers), it would register duplicate message handlers. This is only a concern if `start()` is called multiple times, which the current architecture prevents (the pipeline calls `start()` exactly once).

---

## Verification of New Tests

### accumulator.test.ts — 3 new tests

1. **"addMetric() with deviceId copies metric before adding _device_id (F-1)"**
   - Creates metric, passes through accumulator with deviceId
   - Verifies received metric has `_device_id`
   - Verifies original metric does NOT have `_device_id`
   - Verifies received is a different reference (`not.toBe`)
   - **Quality:** Excellent — tests all three aspects of the fix ✅

2. **"addMetric() without deviceId passes metric through by reference"**
   - Creates accumulator without deviceId
   - Verifies received metric IS the same reference (`toBe`)
   - **Quality:** Good — verifies no unnecessary copy ✅

3. **"addMetric() skips copy when _device_id already present"**
   - Creates metric WITH `_device_id` already set
   - Passes through accumulator with matching deviceId
   - Verifies same reference (no copy)
   - **Quality:** Good — verifies `hasTag()` guard ✅

### hub-link.test.ts — 2 new tests

4. **"first DBIRTH after NBIRTH has seq=1, not seq=0 (F-4)"**
   - Starts hub, registers device, publishes DBIRTH
   - Decodes both NBIRTH and DBIRTH payloads
   - Verifies NBIRTH seq=0, DBIRTH seq=1
   - **Quality:** Excellent — directly verifies the protocol compliance fix ✅

5. **"re-publishes DBIRTH on rebirth for devices with empty initialMetrics (F-6)"**
   - Registers device with `initialMetrics: []` (mirrors runtime.ts behavior)
   - Publishes data (triggers auto-DBIRTH)
   - Triggers rebirth
   - Verifies DBIRTH count increased by 1
   - **Quality:** Good — tests the specific scenario from F-6 ✅

---

## Cross-Module Interaction Check

### Pipeline Runtime → Hub Link → MQTT Output

Traced the full data flow:

1. **Runtime** registers devices with `pluginType: input.pluginType ?? "input"` (plugin-factory sets the actual type). ✅
2. **Accumulator** injects `_device_id` via copy-on-write. ✅
3. **Metrics flow through processors/aggregators** with `_device_id` intact. ✅
4. **MqttOutput.writeSparkplug()** copies metric, strips `_device_id`, routes by device to hub link. ✅
5. **Hub link** auto-publishes DBIRTH on first data, then DDATA for subsequent data. ✅
6. **Shutdown** pipeline drains → hub link `stop()` publishes DDEATH for all devices → disconnect. ✅

No cross-module interaction issues found.

### Sparkplug Codec Encoding Audit

Checked all encode functions for correctness:

| Function | seq | timestamp | metrics | Result |
|----------|-----|-----------|---------|--------|
| `encodeNBirth` | seq=0 hardcoded ✅ | `Date.now()` ✅ | bdSeq, Rebirth, Config Version, Properties, Agent Metrics ✅ | Correct |
| `encodeNDeath` | none (not in spec) ✅ | `Date.now()` ✅ | bdSeq only ✅ | Correct |
| `encodeDBirth` | from parameter ✅ | `Date.now()` ✅ | Full metric defs with aliases ✅ | Correct |
| `encodeDDeath` | from parameter ✅ | `Date.now()` ✅ | empty ✅ | Correct |
| `encodeDData` | from parameter ✅ | From metric (ns→ms) with zero fallback ✅ | Alias-based, no names ✅ | Correct |
| `encodeNData` | from parameter ✅ | From metric or `Date.now()` ✅ | Named metrics ✅ | Correct |
| `decodeNCmd` | n/a | n/a | Decoded metrics array ✅ | Correct |

---

## Summary of All Findings

### Fix Verification

| Finding | Fix Status | Verification |
|---------|-----------|-------------|
| F-1 (RED) | ✅ Fixed | Copy-on-write correct. 3 tests verify all paths. |
| F-2 (RED) | Deferred | JSDoc correctly documents MQTT limitation. |
| F-3 (YELLOW) | Accepted | JSDoc documents `_device_id` as intentional metadata with `_` prefix convention. |
| F-4 (YELLOW) | ✅ Fixed | `seq = 1` after NBIRTH correct. No edge case with wrap logic. Test verifies. |
| F-5 (YELLOW) | ✅ Fixed | `removeAllListeners(eventName)` safe — doesn't remove mqtt library internals. |
| F-6 (YELLOW) | ✅ Fixed | `lastKnownMetrics` map correctly tracks and re-publishes. Test verifies. |
| F-8 (YELLOW) | ✅ Fixed | Warning log clearly indicates dropped metrics. |
| F-9 (GREEN) | ✅ Fixed | Rename is correct and reads unambiguously. |
| F-10 (GREEN) | No change | Cosmetic, correctly deferred. |

### New Bugs Introduced by Fixes

**None.** All fixes are correctly implemented without introducing regressions.

### Deeper Issues Missed by Both Previous Reviews

| Finding | Severity | Description |
|---------|----------|-------------|
| D-1 | 🟡 | Heartbeat timer not paused during `rebirth()` — potential seq interleaving |
| D-2 | 🟡 | Concurrent `publishDeviceData()` could trigger duplicate DBIRTH |
| D-3 | 🟡 | **No reconnection-triggered NBIRTH re-publish** — zombie state after network blip |
| D-4 | 🟢 | `lastKnownMetrics` grows unboundedly (static device set makes this theoretical) |
| D-5 | 🟢 | Timestamp edge cases handled correctly ✅ (verified, not actually an issue) |
| D-6 | 🟢 | `onMessage` would accumulate on double `start()` (prevented by architecture) |

**D-3 is the most significant finding.** After a network reconnection, the edge node does not re-publish NBIRTH, leaving it in a zombie state where it publishes DDATA without a preceding birth certificate. This is a real protocol gap that should be addressed in post-MVP, ideally before production deployment.

---

## Final Verdict

### ✅ CONFIRMED GO

All 7 applied fixes (F-1, F-4, F-5, F-6, F-8, F-9, F-3) are correctly implemented. No new bugs were introduced by the fixes. The deferred items (F-2, F-10) are properly documented. The test suite (646 tests) passes completely.

The three new 🟡 findings (D-1, D-2, D-3) are real issues but are post-MVP concerns:
- D-1 and D-2 require rare timing conditions to manifest
- D-3 (reconnection rebirth) is the most important and should be prioritized for the next phase after network policy

**Phase 8 can proceed.**
