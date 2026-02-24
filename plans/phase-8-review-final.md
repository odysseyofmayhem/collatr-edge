# Phase 8 Code Review: Network Policy & Standalone Operation

**Reviewer:** Claude Opus 4.6 (independent context, fresh eyes)
**Date:** 2026-02-24
**Scope:** All source and test files changed/created in Phase 8 (commits a377d9d to HEAD)
**PRD References Checked:** PRD ss10, ss16, ss7, ss8, Appendix A
**Test Suite:** 779 tests, 0 failures (verified)

---

## Review Summary

Phase 8 is a solid, well-structured implementation. The core `NetworkPolicy` type, resolver, and enforcement machinery are clean and follow the PRD closely. The immutable `NetworkPolicy` class, the Zod schema, and the fail-fast startup enforcement all match the design philosophy described in PRD ss10. Test coverage is comprehensive for the implemented features, with 782 lines of dedicated unit tests for network-policy alone, plus integration tests exercising the full config-to-pipeline path.

There are no critical blocking issues. The findings below are refinements: one is a logic nuance that produces misleading error messages in a specific scenario, and the rest are minor gaps in PRD compliance and edge case coverage.

---

## PRD Compliance Table

| Module | PRD Section | Compliant? | Notes |
|--------|------------|------------|-------|
| `network-policy.ts` — Zod schema | ss10 | Yes | All fields present, defaults correct |
| `network-policy.ts` — Mode presets | ss10 table | Partial | Missing `allow_local_subnet` field (see Finding Y1) |
| `network-policy.ts` — ResolvedEgressRules | ss10 | Yes | All 4 fields: allowDns, allowMqttHub, allowedHosts, unrestricted |
| `network-policy.ts` — ResolvedIngressRules | ss10 | Yes | allowLocalWebui, allowLocalApi, allowedCidrs |
| `network-policy.ts` — checkEgress | ss10 | Yes* | Correct logic; one misleading error message path (see Finding Y2) |
| `network-policy.ts` — PolicyViolationError | ss10 | Yes | Includes target, reason, mode; message format matches PRD |
| `network-policy.ts` — NetworkPolicy immutability | ss10 | Yes | Object.freeze on instance, egress, and ingress |
| `config.ts` — networkPolicy in AgentConfig | ss7, ss10 | Yes | Field present, parsed, resolved |
| `config.ts` — warning on hub+policy conflict | ss10 | Yes | Warning produced, not hard error, correct message |
| `config.ts` — default to connected when absent | ss7, ss10 | Yes | Backward-compatible default |
| `plugin-factory.ts` — hub broker validation | ss10, ss16 | Yes | Validated before HubLink creation, PolicyViolationError thrown |
| `plugin-factory.ts` — networkPolicy to MQTT output | ss10 | Yes | Passed via constructor, 4th parameter |
| `plugin-factory.ts` — networkPolicy in PipelineOptions | ss10 | Yes | Propagated for runtime logging |
| `mqtt.ts` — plain mode enforcement | ss10, ss16 | Yes | All servers validated in connect(), PolicyViolationError on denial |
| `mqtt.ts` — sparkplug mode enforcement | ss10, ss16 | Yes | Hub broker validated in plugin-factory before HubLink creation |
| `mqtt.ts` — parseMqttServerUrl | ss10 | Yes | Handles mqtt://, mqtts://, tcp://, ssl:// schemes |
| `runtime.ts` — startup logging | ss8 step 20, ss10 | Yes | Logs mode and summary at start() |
| `runtime.ts` — lifecycle ordering | ss8 | Yes | Policy logging before output connect, PolicyViolationError propagates |
| `config-validate.ts` — policy reporting | ss7, ss10 | Yes | Reports mode, egress rules, ingress rules |
| `config-validate.ts` — conflict detection | ss10 | Yes | Detects MQTT output/policy conflicts, produces warnings |

---

## Findings

### 🔴 Must Fix (before Phase 9)

**None.** No critical issues found. The implementation is correct, tests pass, and the core security guarantees (fail-fast startup, DNS blocking, policy immutability) are properly enforced.

---

### 🟡 Should Fix

#### Y1: `allow_local_subnet` missing from mode presets (Priority 2)

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/network-policy.ts` (lines 60-105)

**PRD ss10 table** includes a row for `allow_local_subnet`:

| Rule | connected | local_network | standalone |
|------|-----------|---------------|------------|
| `allow_local_subnet` | `true` | `true` | `false` |

The phase plan explicitly defers this as post-MVP ("Requires subnet detection at runtime"). However, Rule 8 (Interface Compliance Check) says: "don't silently drop fields even if the current phase doesn't use them. If a field is present in the PRD interface but not needed yet, include it with a `// TODO: Phase N` comment."

The `ResolvedEgressRules` interface and `MODE_PRESETS` object should include `allowLocalSubnet` as a field with the correct defaults per mode, even though it is not enforced in `checkEgress` yet. This prevents interface drift -- Phase 9 or post-MVP code will expect this field to exist.

**Recommendation:** Add `allowLocalSubnet: boolean` to `ResolvedEgressRules`, set correct defaults in `MODE_PRESETS`, include a `// TODO: post-MVP — enforce when subnet detection is available` comment. Do not add enforcement logic (that is correctly deferred).

---

#### Y2: Hub check masks "not in allowed_hosts" for non-Hub MQTT targets (Priority 2)

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/network-policy.ts` (lines 248-257)

**Scenario:** `local_network` mode with `allowedHosts = ["192.168.1.50:8086"]` and a target `{ host: "192.168.1.10", port: 1883, protocol: "mqtt" }`.

The egress check flow:
1. Not unrestricted -- continue
2. DNS check -- target is an IP, passes
3. allowedHosts check -- `192.168.1.10:1883` not in `["192.168.1.50:8086"]` -- no match, continue
4. Hub check -- protocol is "mqtt" AND `allowMqttHub === false` -- **DENIED** with "Hub/MQTT connectivity disabled"

But this target is a plain local MQTT broker, not the Hub. The correct denial reason should be "Host 192.168.1.10:1883 not in allowed_hosts" (step 5). The Hub check at step 4 catches ALL mqtt/mqtts targets that weren't in allowedHosts, not just Hub-specific targets.

**Impact:** Misleading error messages. An operator targeting a local EMQX broker will see "Hub/MQTT connectivity disabled" when the real issue is that they forgot to add the broker to `allowed_hosts`. The error message even suggests "Enable allow_mqtt_hub", which is wrong advice for local brokers.

**Recommendation:** Move the Hub check (step 4) to fire only when the target is plausibly a Hub endpoint, or change the error message to be more generic ("MQTT egress to X denied -- target not in allowed_hosts and MQTT Hub connectivity is disabled"). Alternatively, move step 5 (not-in-allowed_hosts denial) before step 4, so that when `allowedHosts` is non-empty and the target didn't match, the "not in allowed_hosts" denial fires first. The Hub check then only triggers when `allowedHosts` is empty.

---

#### Y3: `matchesAllowedHosts` silently fails when target port is undefined and entry has a port (Priority 2)

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/network-policy.ts` (lines 314-326)

When `allowedHosts` contains `"192.168.1.50:8086"` and the target has `port: undefined`, the match fails because:
- `parsed.port` is `8086` (defined)
- `target.port !== undefined` is `false`
- Falls through to `return false`

This could happen if `parseMqttServerUrl` receives a URL without an explicit port (e.g., `mqtt://broker` resolves to `{ host: "broker", port: undefined }`). If an operator adds `broker:1883` to allowed_hosts but their MQTT config uses `mqtt://broker` (no port), the match will silently fail.

**Impact:** Low in practice for MQTT (URLs typically include ports), but worth documenting and testing.

**Recommendation:** Add a test case for this edge case in `network-policy.test.ts` to document the behavior. Consider whether a target with `port: undefined` should match an entry with a specific port (this is a design decision -- the current deny-by-default behavior is the safer choice but should be explicitly tested and documented).

---

#### Y4: `config-validate.ts` `detectOutputPolicyConflicts` skips Sparkplug MQTT outputs (Priority 2)

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/cli/commands/config-validate.ts` (lines 178-179)

```typescript
const isSparkplug = instance.sparkplug as boolean | undefined;
if (isSparkplug) continue;
```

The comment says "hub conflict handled by config.warnings already." This is true -- the `parseConfig` function generates a warning when `hub.enabled && !allowMqttHub`. However, `config-validate` should also warn when Sparkplug MQTT output is configured but Hub is NOT enabled. In that case, there is no `config.warnings` entry, and the Sparkplug output would fail at runtime when it tries to use a null HubLink.

**Impact:** Missing validation for a specific config error (Sparkplug output without enabled Hub).

**Recommendation:** Add a validation check in `detectOutputPolicyConflicts` or the main validation flow: if an MQTT output has `sparkplug: true` but `agent.hub.enabled` is not `true`, emit a warning.

---

### 🟢 Nice to Have

#### G1: `isIpAddress` regex does not validate IPv4 octet ranges

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/network-policy.ts` (lines 155-163)

```typescript
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
```

This regex matches `999.999.999.999` as a valid IPv4 address. For the DNS blocking check, this is a false positive (treating an invalid IPv4 as "not a hostname"), which means DNS blocking would not trigger for `999.999.999.999`. In practice, no real MQTT broker would have such an address, and the net effect is that an invalid IP is treated as an IP rather than triggering DNS blocking -- which is the safer direction.

**Recommendation:** Not urgent. If desired, use a stricter regex or the built-in `net.isIP()` (from Node.js) to validate properly.

---

#### G2: No test for `parseMqttServerUrl` with unparseable URL

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/test/unit/plugins/outputs/mqtt.test.ts`

The `parseMqttServerUrl` function has a fallback for unparseable URLs:
```typescript
catch {
  return { host: server, protocol: "mqtt", description };
}
```

There is no test exercising this catch branch. An unparseable URL like `"not-a-url"` would return `{ host: "not-a-url", protocol: "mqtt" }`, which is then passed to `checkEgress`. This is handled safely (hostname triggers DNS check), but the branch should have test coverage per Rule 9.

**Recommendation:** Add a test case: `parseMqttServerUrl("not-a-url", "test")` returns the raw string as host.

---

#### G3: Integration test `network-policy-enforcement.test.ts` does not test `file` or `local_store` outputs pass through in standalone mode

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/test/integration/network-policy-enforcement.test.ts`

The test file covers stdout passing through in local_network mode but does not explicitly test that `local_store` and `file` outputs are never blocked in any mode. The acceptance criteria (plan item 7) states: "No false positives: Local-only outputs (local_store, file, stdout) are never blocked."

**Recommendation:** Add one test: standalone mode with `local_store` output starts and stops cleanly.

---

#### G4: `summary()` uses emojis in log output

**File:** `/Users/leemcneil/Projects/DoublyGood/collatr-edge/src/core/network-policy.ts` (lines 290-307)

The `summary()` method returns strings with emoji prefixes ("🌐 CONNECTED", "🏠 LOCAL NETWORK", "🔒 STANDALONE"). These are logged at startup via `getLogger().info()`. On headless industrial systems writing to journald or syslog, emoji characters may not render correctly.

**Recommendation:** Consider making the emoji prefix optional or using ASCII markers for the log-format version. Low priority -- the PRD ss10 "Accidental Isolation Prevention" section uses the same emoji conventions in its spec.

---

## Test Coverage Assessment

### What is well tested:
- All 3 mode presets (connected, local_network, standalone) with correct egress/ingress defaults
- Override merging for both egress and ingress rules
- `connected` mode losing `unrestricted` when any egress override is applied
- DNS blocking for hostnames in non-connected modes
- Hub check with allowMqttHub on/off
- Host:port matching, host-only matching, multiple allowed_hosts entries
- Immutability (Object.freeze on policy, egress, ingress)
- `PolicyViolationError` construction, properties, and message format
- `parseHostPort` for IPv4, hostnames, IPv6 brackets, whitespace
- Config parsing: [network_policy] section, missing section defaults, invalid mode
- Hub/policy conflict warning generation
- Plugin factory: hub+standalone throws, hub+connected creates HubLink, networkPolicy passthrough
- MQTT output: all 3 modes enforced, backward compat (no policy), all-servers validation, DNS blocking
- Config validate: policy section in output, conflict warnings, clean validation
- Config init: all 3 mode templates parseable, standalone has no MQTT outputs
- Integration: full pipeline path from TOML to startup failure/success

### What has gaps:
- **Untested branch:** `parseMqttServerUrl` catch block (unparseable URL fallback)
- **Untested edge case:** Target with `port: undefined` vs. `allowed_hosts` entry with port
- **Missing integration test:** `local_store` output in standalone mode (acceptance criteria item 7)
- **No test for:** HTTP output or future network-connected outputs (not relevant yet, but worth noting as Phase 9+ adds HTTP outputs)
- **Step 4 checkEgress masking:** No test demonstrating that an MQTT target not in `allowedHosts` gets a misleading Hub-related error message (this tests the _bug_ described in Y2)

### Hard path coverage (Rule 9):
- Clock jump / timing: N/A for this phase
- Reconnection logic: N/A for this phase (policy is checked once at connect)
- Error recovery: Tested (PolicyViolationError propagation through pipeline startup)
- Branching conditions: All `if` branches in `checkEgress` are tested except the final fallback (line 283-286 -- unreachable for normal modes since connected is always unrestricted)
- Configurable behaviors: All mode presets tested, override merging tested, all egress rule combinations tested

---

## Lifecycle Ordering Assessment

PRD ss8 startup sequence relevant steps:
- Step 3: "Resolve network_policy mode -> concrete egress/ingress rules" -- **Compliant.** Done in `parseConfig()` before pipeline build.
- Step 4: "Validate all outputs against network policy (FAIL if any output violates)" -- **Compliant.** Hub broker validated in `buildPipeline()`. MQTT server URLs validated in `MqttOutput.connect()`. Both run during startup, before data flows.
- Step 11: "Connect outputs" -- **Compliant.** `output.connect()` in `runtime.start()` is where PolicyViolationError propagates.
- Step 20: "Log network policy mode" -- **Compliant.** Logged in `runtime.start()` before output connect.

One ordering observation: The hub broker is validated in `buildPipeline()` (before `runtime.start()`), while MQTT plain-mode servers are validated in `MqttOutput.connect()` (during `runtime.start()`). This is a consistent approach -- hub validation is earlier because it needs to happen before `HubLink` construction. Both are "fail at startup" which matches PRD ss10 requirements.

---

## Phase 9 Readiness Assessment

**Ready to proceed.** Phase 8 provides a solid foundation for Phase 9 (Web UI):

1. **Ingress rules are parsed and stored** on the `NetworkPolicy` object (`allowLocalWebui`, `allowLocalApi`, `allowedCidrs`). Phase 9 can read these to configure Web UI binding and CIDR allowlists without any changes to Phase 8 code.

2. **NetworkPolicy is available in PipelineOptions**, so the Web UI can access it for the startup banner (PRD ss10: "the local Web UI displays the network policy prominently").

3. **No regressions.** All 779 tests pass. No existing functionality was broken.

4. **Config validation is comprehensive.** The `config validate` command reports the full network policy, detects output/policy conflicts, and properly handles all error cases (invalid TOML, invalid agent, invalid network_policy, missing file).

**Pre-Phase 9 fix recommendations:**
- Fix Y2 (misleading error message for non-Hub MQTT targets) -- this affects user experience when debugging startup failures
- Add Y1 (allow_local_subnet field) -- prevents interface drift when Phase 9 or post-MVP code expects it
- The Y3 and Y4 findings can be addressed during Phase 9 when the context arises (Priority 2)
