# Phase 8 Independent Code Review: Network Policy & Standalone Operation

**Reviewer:** Independent sub-agent (Claude Opus 4, separate context from implementation agent)
**Date:** 2026-02-24
**Scope:** All source and test files created/modified in Phase 8
**Test Suite:** 766 tests, 0 failures (verified on `2026-02-24T19:40 UTC`)
**PRD References:** §10, §16, §7, §8, Appendix A

---

## 1. Internal Review Completeness Assessment

### Grade: **A-**

The internal review (`plans/phase-8-review-final.md`) is thorough, well-structured, and catches meaningful issues. Strengths:

1. **Correctly identified the Y2 check-ordering bug** — the most significant logic issue in the implementation. The internal review precisely traced the execution path that produces misleading error messages for non-Hub MQTT targets.

2. **PRD compliance table is comprehensive** — covers every module, every relevant PRD section, with accurate assessments.

3. **Lifecycle ordering analysis is excellent** — correctly notes the split between hub validation (in `buildPipeline`) and MQTT plain validation (in `connect()`) and explains why it's consistent.

4. **Test coverage assessment identifies real gaps** — the `parseMqttServerUrl` catch branch, the `port: undefined` edge case, and the `local_store` standalone test.

5. **Phase 9 readiness assessment is actionable** — identifies which fixes should happen before Phase 9 and why.

### What the internal review missed:

1. **The Y2 fix was already correctly applied** — The internal review described a bug in the check ordering (Hub check fires before "not in allowed_hosts"), but the fix commit (`e63c759`) reordered the checks correctly. The review describes the *pre-fix* state. This is fine for documentation but the fix verification section should have confirmed the new ordering explicitly.

2. **No analysis of HTTP output mentioned in Appendix A** — The PRD's full config example (Appendix A) includes an `[[outputs.http]]` plugin. The network policy enforcement currently only covers MQTT outputs. The `config-validate.ts` only runs `detectOutputPolicyConflicts` on MQTT instances. HTTP outputs targeting non-allowed hosts would not be caught at validation time. This is technically acceptable for MVP (no HTTP output plugin exists yet), but worth noting.

3. **`allow_local_subnet` override path not tested** — The internal review correctly identified the missing field (Y1, now fixed), but didn't note that `resolveNetworkPolicy` hardcodes `allowLocalSubnet: preset.egress.allowLocalSubnet` with a `// TODO: post-MVP` comment and ignores any user-provided override. If a user adds `allow_local_subnet = false` to their config, the Zod schema would accept it but the resolver would silently ignore it. The schema and resolver are inconsistent here.

4. **No mention of the `overflow_policy` field in Appendix A** — The full config example shows `overflow_policy = "disk_spill"` on the HTTP output. Not directly relevant to Phase 8 but shows the reviewer didn't cross-reference Appendix A for completeness.

5. **summary() emoji removal was noted but the fix was different** — G4 suggested making emojis optional. The fix actually removed emojis entirely, using bracket notation instead (`[CONNECTED]`, `[LOCAL NETWORK]`, `[STANDALONE]`). The review and fix are aligned in intent.

---

## 2. Fix Verification (All 8 Findings)

### Y1: `allow_local_subnet` missing from mode presets — ✅ VERIFIED

**Location:** `src/core/network-policy.ts` lines 26, 71, 83, 95

The `ResolvedEgressRules` interface now includes `allowLocalSubnet: boolean`. All three mode presets set the correct values per PRD §10:
- `connected`: `allowLocalSubnet: true` ✅
- `local_network`: `allowLocalSubnet: true` ✅
- `standalone`: `allowLocalSubnet: false` ✅

A `// TODO: post-MVP` comment is present. The `resolveNetworkPolicy` function assigns from preset (no user override yet). Tests verify the values in `MODE_PRESETS` tests.

### Y2: Hub check masks "not in allowed_hosts" — ✅ VERIFIED

**Location:** `src/core/network-policy.ts` lines 240-270

The check order has been correctly restructured:
1. Unrestricted check
2. DNS check (hostname + !allowDns)
3. **Allowed hosts check (if non-empty)** — matches → allow; no match → deny with "not in allowed_hosts"
4. **Hub check** — only fires when `allowedHosts` is empty
5. Mode-based fallback denial

This correctly prevents the misleading "Hub/MQTT connectivity disabled" message when a non-Hub MQTT target fails to match an `allowedHosts` entry. The test "denies MQTT target not in allowedHosts with specific 'not in allowed_hosts' reason" (line ~352 in `network-policy.test.ts`) explicitly validates this fix.

### Y3: `matchesAllowedHosts` silently fails with undefined port — ✅ VERIFIED

**Location:** `test/unit/core/network-policy.test.ts` line ~440

A test case was added: "target with port: undefined does not match entry with specific port (deny-by-default)". The test confirms that `port: undefined` against `"192.168.1.50:8086"` results in a denial with "not in allowed_hosts". The behavior is documented as intentional deny-by-default.

### Y4: `config-validate.ts` skips Sparkplug MQTT outputs — ✅ VERIFIED

**Location:** `src/cli/commands/config-validate.ts` lines 178-187, `test/unit/cli/config-validate.test.ts` line ~570

The `detectOutputPolicyConflicts` function now checks sparkplug outputs for a structural issue: `sparkplug=true` but `[agent.hub]` not enabled. It emits a warning:
```
MQTT output[N] has sparkplug=true but [agent.hub] is not enabled.
The pipeline will fail to start with this configuration.
```
The test "sparkplug MQTT output without hub enabled → warning" validates this. Hub + policy conflicts are still handled by `config.warnings` (from `parseConfig`).

### G1: `isIpAddress` regex does not validate IPv4 octet ranges — ✅ VERIFIED

**Location:** `src/core/network-policy.ts` lines 155-165

The `isIpAddress` function now validates octet ranges (0-255) after the regex match:
```typescript
if (IPV4_RE.test(host)) {
  return host.split(".").every((octet) => {
    const n = parseInt(octet, 10);
    return n >= 0 && n <= 255;
  });
}
```
The test "invalid IPv4-like address (999.999.999.999) is treated as hostname, not IP" validates that invalid octets trigger DNS-blocking behavior.

### G2: No test for `parseMqttServerUrl` with unparseable URL — ✅ VERIFIED

**Location:** `test/unit/plugins/outputs/mqtt.test.ts` line ~413

Test added: "handles unparseable URL — returns raw string as host" — verifies that `parseMqttServerUrl("not-a-url", "test_desc")` returns `{ host: "not-a-url", protocol: "mqtt", description: "test_desc" }`.

### G3: Missing integration test for `local_store` in standalone — ✅ VERIFIED

**Location:** `test/integration/network-policy-enforcement.test.ts` lines ~276-292

Test "standalone + local_store only → starts and stops cleanly" uses:
```toml
[network_policy]
mode = "standalone"

[[outputs.local_store]]
path = ":memory:"
```
Verifies that `start()` + `stop()` completes without error — local_store is never blocked.

### G4: `summary()` uses emojis in log output — ✅ VERIFIED

**Location:** `src/core/network-policy.ts` lines 278-296

Emojis have been removed from `summary()`. The method now uses bracket notation:
- `"[CONNECTED] unrestricted egress, full Hub connectivity"`
- `"[LOCAL NETWORK] egress: 2 allowed hosts, DNS off, Hub off"`
- `"[STANDALONE] no external data transmission"`

Tests verify the new format (e.g., `expect(s).toContain("[CONNECTED]")`).

---

## 3. Independent Findings

### 🔴 Must Fix

**None.** The implementation is correct and all security guarantees (fail-fast, DNS blocking, immutability) are properly enforced.

---

### 🟡 Should Fix

#### Y-I1: `allow_local_subnet` silently ignored in config override (Priority 2)

**File:** `src/core/network-policy.ts` line 200

The Zod schema does NOT include `allow_local_subnet` as a field, which means the TOML parser won't extract it from config. However, the `ResolvedEgressRules` interface includes it, and the resolver hardcodes it from presets:

```typescript
allowLocalSubnet: preset.egress.allowLocalSubnet, // TODO: post-MVP — no config override yet
```

This is consistent — a user cannot set this field in config, and the resolver doesn't look for it. **BUT** if a user writes `allow_local_subnet = true` in their `[network_policy.egress]` section, the Zod schema's `.optional()` pattern means extra keys are silently passed through. With `z.object()` (no `.strict()`), extra keys are stripped but no error is thrown.

**Impact:** Low. The field is correctly deferred as post-MVP. The current behavior is safe (user can't override it). However, a user who reads the PRD §10 table and tries to set `allow_local_subnet` will get silently ignored, which could be confusing.

**Recommendation:** Add a comment in the Zod schema noting that `allow_local_subnet` is intentionally absent (PRD post-MVP deferral). Consider adding a validation warning in `config-validate` if the field is present in raw config but being ignored. Alternatively, add it to the Zod schema as `.optional()` with a `// TODO: post-MVP — parsed but not enforced` comment, matching the Rule 8 pattern.

---

#### Y-I2: Non-MQTT network outputs not validated by `detectOutputPolicyConflicts` (Priority 2)

**File:** `src/cli/commands/config-validate.ts` lines 167-200

The `detectOutputPolicyConflicts` function only inspects `config.outputs.mqtt`. The PRD Appendix A full config example includes `[[outputs.http]]` with a URL targeting `http://192.168.10.200:8086`. If an HTTP output plugin were configured in a `local_network` or `standalone` config, `config validate` would not warn about the policy conflict.

Currently this is not a bug because:
- There is no HTTP output plugin implementation in MVP
- Only MQTT output has network policy enforcement in `connect()`

**Impact:** None today. But when HTTP output is added (likely Phase 9+), `detectOutputPolicyConflicts` will need updating. Without a `// TODO`, this could be missed.

**Recommendation:** Add a `// TODO: Phase N — extend to HTTP and other network outputs when implemented` comment in `detectOutputPolicyConflicts`.

---

#### Y-I3: `connected` mode with empty `egress` override loses `unrestricted` (Priority 2)

**File:** `src/core/network-policy.ts` lines 195-202

The `unrestricted` flag computation is:
```typescript
unrestricted: mode === "connected"
  && raw?.egress?.allowed_hosts === undefined
  && raw?.egress?.allow_dns !== false
  && raw?.egress?.allow_mqtt_hub !== false,
```

If a user writes:
```toml
[network_policy]
mode = "connected"

[network_policy.egress]
```

(empty egress section), the TOML parser produces `egress: {}`. The Zod parse produces `{ allow_dns: undefined, allow_mqtt_hub: undefined, allowed_hosts: undefined }`. Since `raw?.egress?.allowed_hosts === undefined` is true and the others are not `false`, `unrestricted` remains `true`. ✅ This is correct.

However, if a user writes:
```toml
[network_policy.egress]
allow_dns = true
```

This is `allow_dns: true` (not `false`), and the other fields are `undefined`. So `unrestricted` is true — which means `checkEgress` always returns `{ allowed: true }`, and the explicitly set `allow_dns = true` is irrelevant. This is semantically correct (connected mode IS unrestricted by default, and `allow_dns = true` is the default anyway), but it could surprise a user who expects that setting ANY egress field means they're taking manual control.

**Impact:** Edge case only. The current behavior is documented by the test "connected mode with explicit allowed_hosts loses unrestricted." The intent is clear: only restrictive overrides (`allow_dns = false`, `allow_mqtt_hub = false`, or explicit `allowed_hosts`) break unrestricted mode. Permissive redundant overrides (`allow_dns = true`) don't change behavior.

**Recommendation:** Add a test documenting this specific case: "connected mode with allow_dns=true (redundant) remains unrestricted". This makes the behavior explicit.

---

### 🟢 Nice to Have

#### G-I1: IPv6 in `allowed_hosts` untested end-to-end

**Files:** `src/core/network-policy.ts`, `test/unit/core/network-policy.test.ts`

The `parseHostPort` function handles IPv6 bracket notation (`[::1]:8080`) correctly, and has unit tests for this. However, there is no end-to-end test that:
1. Creates a policy with `allowed_hosts = ["[::1]:8080"]`
2. Checks egress against `{ host: "::1", port: 8080 }`

The current `parseHostPort("[::1]:8080")` returns `{ host: "::1", port: 8080 }`, and a target with `host: "::1"` would match correctly because `"::1" === "::1"`. However, different IPv6 representations of the same address (e.g., `::1` vs `0:0:0:0:0:0:0:1`) would NOT match, which is expected behavior for string-based matching but should be documented.

**Recommendation:** Add a test: `checkEgress({ host: "::1", port: 8080, ... })` against `allowed_hosts: ["[::1]:8080"]` → allowed.

#### G-I2: `parseMqttServerUrl` doesn't set default ports for known schemes

**File:** `src/plugins/outputs/mqtt.ts` lines 186-198

When parsing `mqtt://broker` (no port), the function returns `port: undefined`. The MQTT spec defines default ports: `mqtt://` → 1883, `mqtts://` → 8883. If a user configures `allowed_hosts = ["broker:1883"]` and `servers = ["mqtt://broker"]`, the allowed_hosts check would fail because the target has `port: undefined` and the entry has `port: 1883`.

This is a deny-by-default behavior (documented by Y3 fix), but it creates a subtle configuration mismatch that an operator would find confusing.

**Impact:** Low — in practice, operators almost always specify ports explicitly in MQTT server URLs. The edge case is unlikely but worth documenting.

**Recommendation:** Consider setting default ports in `parseMqttServerUrl` when the scheme is known:
```typescript
const port = url.port ? parseInt(url.port, 10) : (protocol === "mqtts" ? 8883 : 1883);
```
This would make `mqtt://broker` match `broker:1883` in `allowed_hosts`, which is the intuitive behavior. Alternatively, document this in a code comment.

#### G-I3: No test for MQTT output with `servers = []` (empty array)

**File:** `test/unit/plugins/outputs/mqtt.test.ts`

The `MqttOutput.connect()` throws `"MQTT output requires 'servers' config when not in sparkplug mode"` when `servers` is undefined or empty. There is no test for `servers = []` specifically (empty array). The Zod schema allows it (`z.array(z.string()).optional()`), so an empty `servers = []` would be accepted at parse time but rejected at `connect()`.

**Recommendation:** Add a unit test: `MqttOutput` with `servers: []` → `connect()` throws with "requires 'servers' config" message.

#### G-I4: Config warnings are strings, not structured objects

**File:** `src/core/config.ts` lines 210-215

Config warnings (e.g., "Hub credentials configured but network_policy prevents Hub connectivity") are stored as plain strings in `AgentConfig.warnings: string[]`. For the Web UI (Phase 9), structured warning objects (with severity, code, and message) would be more useful for rendering and filtering.

**Impact:** Phase 9 concern, not Phase 8.

**Recommendation:** Note as a Phase 9 consideration. Could be refactored when the Web UI needs to display warnings.

---

## 4. PRD Compliance Table

| PRD §10 Requirement | Implemented? | Notes |
|---------------------|-------------|-------|
| Three operating modes (connected, local_network, standalone) | ✅ Yes | All three modes with correct defaults |
| Mode as first-class config object | ✅ Yes | `[network_policy]` section with Zod schema |
| Mode presets expand to concrete rules | ✅ Yes | `MODE_PRESETS` object with all fields |
| `allow_dns` per mode | ✅ Yes | connected=true, others=false |
| `allow_mqtt_hub` per mode | ✅ Yes | connected=true, others=false |
| `allow_local_subnet` per mode | ✅ Yes | In presets + interface; enforcement deferred (correct) |
| `allowed_hosts` array | ✅ Yes | Host:port and host-only matching |
| `allow_local_webui` / `allow_local_api` | ✅ Yes | Parsed, stored; enforcement deferred to Phase 9 (correct) |
| `allowed_cidrs` per mode | ✅ Yes | Parsed with correct defaults per mode |
| User override merging | ✅ Yes | Egress and ingress overrides replace defaults |
| Enforcement at output plugin layer | ✅ Yes | MQTT output validates in `connect()` |
| Fail-fast startup | ✅ Yes | `PolicyViolationError` propagates from `connect()` |
| Clear FATAL error message | ✅ Yes | Includes target, reason, mode |
| DNS blocking as security guarantee | ✅ Yes | `isIpAddress()` check with octet validation |
| Hub conflict warning at startup | ✅ Yes | `parseConfig()` generates warning |
| Immutable NetworkPolicy | ✅ Yes | `Object.freeze()` on instance, egress, ingress |
| Startup logging of network policy | ✅ Yes | `runtime.ts` logs mode + summary |
| Config validate reports policy | ✅ Yes | Mode, egress, ingress all reported |
| Config validate detects conflicts | ✅ Yes | MQTT/policy conflicts + sparkplug/hub mismatch |
| Backward compatibility (no config → connected) | ✅ Yes | Default when `[network_policy]` absent |

| PRD §10 Deferred Items | Status | Notes |
|------------------------|--------|-------|
| DNS blocking at OS level | ✅ Correctly deferred | Post-MVP |
| Ingress enforcement (CIDR binding) | ✅ Correctly deferred | Phase 9 |
| Mode transition Sparkplug messages | ✅ Correctly deferred | Post-MVP |
| `allow_local_subnet` enforcement | ✅ Correctly deferred | Post-MVP, field present |
| NTP reachability check | ✅ Correctly deferred | Post-MVP |
| Runtime policy changes | ✅ Correctly deferred | Post-MVP |

| PRD §16 Security | Implemented? | Notes |
|-----------------|-------------|-------|
| Explicit egress control | ✅ Yes | Per-host allowlist |
| DNS blocking in non-connected modes | ✅ Yes | `isIpAddress()` check |
| Fail-fast startup validation | ✅ Yes | PolicyViolationError at startup |
| Zero network activity in standalone | ✅ Yes | All egress blocked, local outputs unaffected |

---

## 5. Test Coverage Assessment

### Coverage Summary

| Module | Unit Tests | Integration Tests | Hard Path Coverage |
|--------|-----------|------------------|-------------------|
| `network-policy.ts` | 69 tests | 8 integration | Excellent |
| `config.ts` (policy section) | 8 tests | Via integration | Good |
| `plugin-factory.ts` (policy) | 5 tests | 3 integration | Good |
| `mqtt.ts` (policy enforcement) | 9 tests + 6 parseMqttServerUrl | 3 integration | Good |
| `config-validate.ts` (policy) | 10 tests | — | Good |
| `config-init.ts` (templates) | 3 tests | — | Good |
| `runtime.ts` (policy logging) | — | 1 integration | Minimal (adequate) |

### Well-Tested Paths

- All 3 mode presets with full field verification
- Override merging (egress + ingress)
- Connected mode losing `unrestricted` on restrictive overrides
- All `checkEgress` branches: unrestricted, DNS block, allowed_hosts match/deny, Hub check, standalone deny, local_network deny
- Host:port matching, host-only matching, multiple entries
- IPv6 bracket parsing in `parseHostPort`
- Invalid IPv4 octet validation
- Policy immutability
- PolicyViolationError construction and properties
- Config parsing of `[network_policy]` section
- Hub + policy conflict warning generation
- Plugin factory hub validation + MQTT policy passthrough
- MQTT output enforcement for all 3 modes
- All-servers validation (second server blocked)
- DNS blocking in MQTT output
- Backward compatibility (no policy = no enforcement)
- Config validate: policy reporting, conflict detection, sparkplug without hub
- Config init: all 3 templates parseable, standalone has no MQTT outputs
- Integration: full TOML → parseConfig → buildPipeline → PipelineRuntime path

### Gaps

1. **No test for MQTT output with `servers = []`** (empty array) — throws at connect time but untested
2. **No end-to-end test for IPv6 in `allowed_hosts`** — `parseHostPort` tested, but no `checkEgress` test with IPv6
3. **No test for connected mode with redundant permissive override** (e.g., `allow_dns = true`) — behavior is correct but undocumented by tests
4. **No test for `parseMqttServerUrl` with IPv6 URL** (e.g., `mqtt://[::1]:1883`)
5. **No test for what happens when `connect()` is called twice** on MqttOutput with a policy — not a Phase 8 concern specifically, but the policy check runs on every `connect()` call

### Rule 9 (Hard Paths) Compliance

- ✅ Error recovery: PolicyViolationError propagation tested through all layers
- ✅ Branching conditions: Every `if` in `checkEgress` has test coverage
- ✅ Configurable behaviors: All 3 modes, override merging, all egress rule combinations
- ✅ Edge cases: undefined ports, invalid IPs, empty allowed_hosts, multiple entries

---

## 6. Cross-Module Interaction Verification

### Config → Plugin Factory → Runtime → Outputs flow

```
parseConfig()
  ├─ Parses [network_policy] → Zod validates → resolveNetworkPolicy() → NetworkPolicy
  ├─ Stores on AgentConfig.networkPolicy
  └─ Generates warnings if hub+policy conflict

buildPipeline()
  ├─ Reads config.networkPolicy
  ├─ Validates hub broker against policy (before HubLink creation) ← FAIL FAST
  ├─ Passes networkPolicy to MqttOutput constructor
  └─ Stores networkPolicy in PipelineOptions

PipelineRuntime.start()
  ├─ Logs networkPolicy.summary()
  ├─ Calls output.connect() for each output
  │   └─ MqttOutput.connect()
  │       ├─ Sparkplug mode: hub already validated in buildPipeline ← NO-OP
  │       └─ Plain mode: validates each server against networkPolicy ← FAIL FAST
  └─ PolicyViolationError propagates → fatal startup failure
```

**Verified:** This flow is correct and well-tested. The integration tests exercise the full path from TOML to startup failure/success.

**Key insight:** Hub broker validation happens in `buildPipeline()` (synchronous, before `start()`), while plain MQTT server validation happens in `connect()` (async, during `start()`). Both are fail-fast at startup, which matches PRD §10's requirement. The split is necessitated by HubLink needing to exist before any Sparkplug MQTT output can reference it.

---

## 7. Decision

### **GO for Phase 9**

Phase 8 is a strong implementation. The network policy system is:

1. **Correct** — enforces all specified egress rules at the right layer
2. **Complete** — all PRD §10 fields present, all modes working, all deferred items properly documented
3. **Well-tested** — 69 unit tests + 8 integration tests covering happy paths, error paths, and edge cases
4. **Secure** — fail-fast startup, DNS blocking, immutable policy objects, clear error messages
5. **Backward compatible** — no `[network_policy]` section defaults to connected mode
6. **Well-documented** — clear code comments, TODO markers for deferred items

No red findings. The yellow findings (Y-I1, Y-I2, Y-I3) are Priority 2 — they can be addressed during Phase 9 when the context arises:
- Y-I1: `allow_local_subnet` schema consistency (add comment or schema field)
- Y-I2: Non-MQTT output validation (add TODO comment)
- Y-I3: Connected mode with redundant override (add documenting test)

The internal review was thorough and its fix pass was correctly applied. The implementation is ready for Phase 9 (Web UI), which will consume the ingress rules already parsed and stored in the NetworkPolicy object.
