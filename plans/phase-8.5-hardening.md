# Phase 8.5: Pre-Web-UI Hardening

**Purpose:** Quick fixes and small improvements before Phase 9 (Web UI). Low risk, high value.
**Estimated Duration:** < 1 hour total
**Prerequisite:** Phase 8 complete, gate review passed (all GO)

---

## Tasks

### 8.5.0: Ticker clock jump warning log (2 min)

**File:** `src/core/ticker.ts:68`

The clock jump detection code works correctly but the warning log is commented out with a TODO saying "Deferred until logging framework is integrated." The logger has been available since Phase 6. This is the ONLY silent operational event in the codebase.

**Fix:**
1. Add `import { getLogger } from "../core/logger";` at top of ticker.ts
2. Replace the commented-out TODO with:
   ```typescript
   getLogger().warn("system clock change detected, re-anchoring ticker", {
     component: "ticker",
     wall_elapsed_ms: Math.round(wallElapsedMs),
     mono_elapsed_ms: Math.round(monoElapsedMs),
     interval_ms: interval,
   });
   ```
3. Remove the old `// Deferred until logging framework is integrated.` comment
4. No new tests needed — the clock jump detection itself is already tested in `ticker.test.ts`

---

### 8.5.1: Read swVersion from package.json (3 min)

**File:** `src/pipeline/plugin-factory.ts:328`

The Sparkplug B NBIRTH payload includes `swVersion` as a device property. Currently hardcoded to `"0.1.0"`. This will drift when the version is bumped. The import pattern is already established in `src/cli/commands/run.ts` and `src/cli/commands/version.ts`.

**Fix:**
1. Add `import packageJson from "../../package.json";` at top of plugin-factory.ts
2. Replace `swVersion: "0.1.0", // TODO: read from package.json or build info` with:
   ```typescript
   swVersion: packageJson.version,
   ```
3. No new tests needed — version.test.ts already validates package.json is importable

---

### 8.5.2: parseMqttServerUrl IPv6 test (5 min)

**File:** `test/unit/plugins/outputs/mqtt.test.ts`

The `parseMqttServerUrl` function handles IPv6 URLs via the `URL` constructor, but there's no test proving it works. Add test coverage for this edge case.

**Fix:**
Add to the `parseMqttServerUrl` describe block:
```typescript
it("parses mqtt://[::1]:1883 (IPv6 bracket notation)", () => {
  const result = parseMqttServerUrl("mqtt://[::1]:1883", "test");
  expect(result.host).toBe("::1");
  expect(result.port).toBe(1883);
  expect(result.protocol).toBe("mqtt");
});

it("parses mqtts://[2001:db8::1]:8883 (IPv6 with explicit port)", () => {
  const result = parseMqttServerUrl("mqtts://[2001:db8::1]:8883", "test");
  expect(result.host).toBe("2001:db8::1");
  expect(result.port).toBe(8883);
  expect(result.protocol).toBe("mqtts");
});
```

---

### 8.5.3: Structured config warnings (15 min)

**File:** `src/core/config.ts`

Currently `AgentConfig.warnings` is `string[]`. Phase 9 Web UI will want to display warnings with severity indicators and categorisation. Refactor to a structured type now to avoid retrofitting.

**Fix:**
1. Define a `ConfigWarning` interface in config.ts:
   ```typescript
   export interface ConfigWarning {
     code: string;           // Machine-readable: "hub_policy_conflict", "sparkplug_no_hub", etc.
     severity: "warning";    // Future: could add "info" | "error"
     message: string;        // Human-readable (existing string content)
   }
   ```
2. Change `AgentConfig.warnings` from `string[]` to `ConfigWarning[]`
3. Update the hub/policy conflict warning in `parseConfig()`:
   ```typescript
   warnings.push({
     code: "hub_policy_conflict",
     severity: "warning",
     message: `Hub credentials configured but network_policy ("${networkPolicy.mode}") prevents Hub connectivity. ...`,
   });
   ```
4. Update `config-validate.ts` — `detectOutputPolicyConflicts()` currently returns `string[]`. Change to return `ConfigWarning[]`. Update all warning creation sites with appropriate codes:
   - `"sparkplug_no_hub"` — Sparkplug MQTT without hub enabled
   - `"mqtt_server_blocked"` — MQTT server blocked by policy
   - `"hub_policy_conflict"` — Hub enabled but policy blocks it
5. Update `config-validate.ts` display logic to use `warning.message` (backward compat for display)
6. Update all tests that check warning content — they should check both `.code` and `.message`

**Warning codes to define:**
| Code | Where produced | Description |
|------|---------------|-------------|
| `hub_policy_conflict` | `parseConfig()` | Hub enabled but network policy blocks Hub |
| `sparkplug_no_hub` | `detectOutputPolicyConflicts()` | Sparkplug MQTT output without hub enabled |
| `mqtt_server_blocked` | `detectOutputPolicyConflicts()` | MQTT server URL blocked by network policy |

---

### 8.5.4: Per-plugin metadata in runtime lifecycle logs (15 min)

**Files:** `src/pipeline/runtime.ts`

`logLevel` and `alias` are already extracted from config and stored in `PipelineOptions` for every plugin type. The full per-plugin child logger injection (changing every plugin constructor) is deferred as an architecture decision. But the runtime can log plugin lifecycle events with alias and type metadata right now, giving Phase 9's log viewer useful per-plugin filtering.

**Fix:**
1. In `runtime.ts` gather loop, log gather timing with plugin alias:
   ```typescript
   getLogger().debug("gather complete", { 
     component: "pipeline",
     plugin: input.alias ?? "input",
     plugin_type: input.pluginType,
     duration_ms: elapsed,
   });
   ```
2. In `runtime.ts` flush loop, log flush with output alias
3. In `runtime.ts` startup, log each plugin with its alias and type
4. This gives Phase 9's log viewer useful per-plugin metadata without architectural changes

**Note:** Full per-plugin child logger injection (passing Logger instances to plugin constructors or using async context) is deferred to post-MVP. See `post-mvp-backlog.md` item #14.

---

## Deferred from Phase 8.5

**integrity_check_on_startup agent-level config** (was 8.5.5): Requires config schema refactor and plumbing through PipelineOptions → plugin-factory → local-store. Not blocking Phase 9. The per-output `integrity_check` field on local-store still works. Moved to `post-mvp-backlog.md`.

---

## Order of Operations

Tasks are independent — can be done in any order. Suggested:
1. 8.5.0 (ticker log) — trivial, 2 min
2. 8.5.1 (swVersion) — trivial, 3 min
3. 8.5.2 (IPv6 test) — trivial, 5 min
4. 8.5.3 (structured warnings) — touches config + validate + tests, 15 min
5. 8.5.4 (plugin logging) — touches runtime, 15 min
