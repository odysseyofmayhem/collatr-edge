# Phase 8: Network Policy & Standalone Operation

**PRD Reference:** §10 (Network Policy & Standalone Operation), §16 (Security — Network Policy Enforcement), §7 (Configuration), Appendix A (Full Config Example)
**Estimated Duration:** 2–3 days (PRD §21)
**Prerequisite:** Phase 7 complete (Sparkplug B Hub Link — CONDITIONAL GO, fix pass applied)

---

## Goal

Implement the network policy system: a first-class config object that defines which network destinations the edge agent is allowed to reach. Three modes (connected, local_network, standalone) expand into concrete egress/ingress rules. Enforcement happens at the output plugin layer with **fail-fast startup validation** — if any output violates the policy, the agent refuses to start.

This phase does NOT implement:
- DNS blocking at the OS level (PRD aspirational — documented as future)
- Ingress enforcement (Web UI / API binding restrictions — Phase 9 concern)
- Mode transition messages (Sparkplug B "going standalone" NDATA — post-MVP)
- Software updates in standalone mode (post-MVP)
- Time synchronisation warnings (Phase 9 Web UI status page)
- NTP checks (post-MVP)

---

## Architecture

### Data Flow

```
Config parsing
  → Parse [network_policy] section with Zod schema
  → Resolve mode preset → concrete egress rules (with user overrides merged)
  → Produce a frozen NetworkPolicy object

Plugin factory
  → Pass NetworkPolicy to output plugin constructors (via DI)
  → Each output validates its target against the policy in connect()
  → MQTT Output (sparkplug): validate hub broker against policy
  → MQTT Output (plain): validate server addresses against policy
  → Local Store: always allowed (local filesystem — no network)
  → File Output: always allowed (local filesystem — no network)
  → Stdout Output: always allowed (no network)

Pipeline startup (runtime.ts)
  → Log network policy at startup: mode, egress rules summary
  → If any output.connect() throws a PolicyViolationError → FATAL, exit 1
```

### Key Design Decisions

1. **Enforcement is at the output plugin layer, not deep in MQTT/HTTP clients.** This keeps enforcement visible, auditable, and testable (PRD §10).

2. **Fail at startup, not at runtime.** If a config says output to Hub but policy says no egress, refuse to start. Never silently drop data (PRD §10 — "Startup failure is non-negotiable").

3. **Mode is a preset, overrides are the truth.** `mode = "local_network"` expands to default rules. Explicit `[network_policy.egress]` fields override the defaults. The resolved rules are what gets enforced.

4. **Host validation uses a parsed target model.** Output plugins declare their target as `{ host, port, protocol }`. The policy checks this against allowed_hosts, allow_mqtt_hub, allow_dns (hostname vs IP), etc.

5. **NetworkPolicy is immutable after construction.** Frozen object — no runtime mutations. Thread-safe by design.

6. **Ingress rules are parsed but not enforced in Phase 8.** They'll be used in Phase 9 (Web UI) for binding restrictions and CIDR allowlisting. Parsing them now ensures config validation is complete.

7. **Hub link config + policy conflict = startup error.** If `[agent.hub]` is enabled but policy blocks hub egress, fail immediately with a clear message. Don't silently disable the hub link.

---

## Modules

### 8.0: NetworkPolicy type + resolver (config layer)

**New file:** `src/core/network-policy.ts`

This module defines:

1. **Zod schema** for `[network_policy]` config section:
   ```typescript
   const NetworkPolicySchema = z.object({
     mode: z.enum(["connected", "local_network", "standalone"]).default("connected"),
     egress: z.object({
       allow_dns: z.boolean().optional(),
       allow_mqtt_hub: z.boolean().optional(),
       allowed_hosts: z.array(z.string()).optional(),  // "host:port" or "host"
     }).optional(),
     ingress: z.object({
       allow_local_webui: z.boolean().optional(),
       allow_local_api: z.boolean().optional(),
       allowed_cidrs: z.array(z.string()).optional(),
     }).optional(),
   });
   ```

2. **Resolved egress rules** (after mode preset + user overrides):
   ```typescript
   interface ResolvedEgressRules {
     allowDns: boolean;           // Can resolve hostnames?
     allowMqttHub: boolean;       // Can connect to Collatr Hub?
     allowedHosts: string[];      // Explicit allowlist ("host:port")
     unrestricted: boolean;       // Connected mode: no host restrictions
   }
   ```

3. **Resolved ingress rules** (parsed, stored, NOT enforced in Phase 8):
   ```typescript
   interface ResolvedIngressRules {
     allowLocalWebui: boolean;
     allowLocalApi: boolean;
     allowedCidrs: string[];
   }
   ```

4. **NetworkPolicy class** (immutable):
   ```typescript
   class NetworkPolicy {
     readonly mode: "connected" | "local_network" | "standalone";
     readonly egress: ResolvedEgressRules;
     readonly ingress: ResolvedIngressRules;

     /** Check if an output target is allowed by the policy. */
     checkEgress(target: EgressTarget): PolicyCheckResult;

     /** Human-readable summary for startup logging. */
     summary(): string;
   }
   ```

5. **EgressTarget** — what output plugins declare:
   ```typescript
   interface EgressTarget {
     host: string;        // hostname or IP
     port?: number;
     protocol: string;    // "mqtt" | "mqtts" | "http" | "https" | "tcp"
     description: string; // Human-readable: "MQTT output to broker.local:1883"
   }
   ```

6. **PolicyCheckResult**:
   ```typescript
   type PolicyCheckResult =
     | { allowed: true }
     | { allowed: false; reason: string };
   ```

7. **Mode preset defaults** (PRD §10 table):

   | Rule | connected | local_network | standalone |
   |------|-----------|---------------|------------|
   | allowDns | true | false | false |
   | allowMqttHub | true | false | false |
   | allowedHosts | [] (unrestricted) | [] (must be explicit) | [] (all blocked) |
   | unrestricted | true | false | false |
   | allowLocalWebui | true | true | true |
   | allowLocalApi | true | true | true |
   | allowedCidrs | ["0.0.0.0/0"] | ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] | ["0.0.0.0/0"] |

8. **checkEgress logic:**
   - If `unrestricted` (connected mode, no explicit overrides): always allowed
   - If target host is a hostname (not IP) and `allowDns === false`: **DENIED** — "DNS resolution disabled in {mode} mode"
   - If target protocol is `mqtt`/`mqtts` and appears to be a Collatr Hub endpoint and `allowMqttHub === false`: **DENIED** — "Hub connectivity disabled in {mode} mode"
   - If `allowedHosts` is non-empty: target must match an entry (host:port or host-only)
   - If `allowedHosts` is empty and mode is `standalone`: **DENIED** — "All egress blocked in standalone mode"
   - If `allowedHosts` is empty and mode is `local_network`: **DENIED** — "No allowed_hosts configured for local_network mode"

   Note: "appears to be a Collatr Hub endpoint" is intentionally loose — check if `allowMqttHub` is false and the target wasn't explicitly in `allowedHosts`. The Hub check is a convenience layer, not the primary enforcement mechanism.

9. **Host matching:** Parse `allowed_hosts` entries:
   - `"192.168.1.50:8086"` → match host AND port
   - `"192.168.1.50"` → match host, any port
   - Matching is string-based (no DNS resolution — the whole point is we might not have DNS)

**Tests:** `test/unit/core/network-policy.test.ts`
- Mode preset resolution (all 3 modes, verify defaults)
- User override merging (egress overrides replace defaults)
- checkEgress: hostname denied when allowDns=false
- checkEgress: Hub broker denied when allowMqttHub=false
- checkEgress: IP+port in allowedHosts → allowed
- checkEgress: IP+port NOT in allowedHosts → denied
- checkEgress: host-only match (any port)
- checkEgress: connected mode → unrestricted
- checkEgress: standalone mode → all denied (no allowedHosts)
- checkEgress: local_network with explicit allowedHosts
- summary() output for each mode
- Ingress rules parsed and stored (not enforced)

---

### 8.1: Config parser integration

**Modified file:** `src/core/config.ts`

1. Add `network_policy` to `AgentConfig`:
   ```typescript
   export interface AgentConfig {
     // ... existing fields ...
     networkPolicy: NetworkPolicy;
   }
   ```

2. In `parseConfig()`:
   - Extract `raw.network_policy` section
   - Parse with `NetworkPolicySchema`
   - Resolve via `resolveNetworkPolicy(parsed)` → `NetworkPolicy`
   - Include in returned `AgentConfig`

3. **Config validation enhancement:** If `agent.hub.enabled === true` and `networkPolicy.egress.allowMqttHub === false`, add a warning to the config validation output (not a hard error in parsing — the startup enforcement will catch it). Log: `"Warning: Hub is enabled but network_policy blocks Hub connectivity"`

**Tests:** Add to `test/unit/core/config.test.ts`
- Config with `[network_policy]` section parses correctly
- Config without `[network_policy]` defaults to connected mode
- Config with mode + egress overrides resolves correctly
- Hub + policy conflict produces warning (not parse error)

---

### 8.2: Output plugin enforcement

**Modified files:**
- `src/core/plugin-types.ts` — add optional `networkPolicy` to Output interface or pass via connect()
- `src/plugins/outputs/mqtt.ts` — validate broker/server against policy before connecting
- `src/pipeline/plugin-factory.ts` — pass NetworkPolicy to output constructors
- `src/pipeline/runtime.ts` — log network policy at startup

**Approach:**

The cleanest way to wire this without changing the Output interface signature is to pass `NetworkPolicy` as a constructor parameter to output plugins that make network connections. Outputs that don't make network connections (local-store, file, stdout) don't need it.

1. **MQTT Output** (the only network-connecting output in MVP):
   - Add `networkPolicy?: NetworkPolicy` constructor parameter
   - In `connect()`, before establishing MQTT connection:
     - Parse the broker URL into an EgressTarget
     - Call `policy.checkEgress(target)`
     - If denied: throw `PolicyViolationError` with the denial reason
     - If allowed: proceed with connection
   - For Sparkplug mode: validate the Hub broker URL from hub config
   - For plain mode: validate each server in `servers[]`

2. **Plugin factory** (`buildPipeline()`):
   - Pass `config.networkPolicy` when constructing MQTT outputs
   - No changes needed for local-store, file, stdout constructors

3. **PolicyViolationError** — new error class in `src/core/network-policy.ts`:
   ```typescript
   export class PolicyViolationError extends Error {
     constructor(
       public readonly target: EgressTarget,
       public readonly reason: string,
     ) {
       super(
         `Output "${target.description}" blocked by network_policy: ` +
         `egress to ${target.host}${target.port ? ':' + target.port : ''} ` +
         `denied in "${/* mode */}" mode. ${reason}`
       );
       this.name = "PolicyViolationError";
     }
   }
   ```

4. **Runtime startup logging** (`runtime.ts`):
   - At start of `start()`, log the network policy summary
   - The existing `output.connect()` call already happens during startup — a PolicyViolationError here will propagate up and halt the pipeline

**Tests:**

`test/unit/plugins/outputs/mqtt.test.ts` — add tests:
- MQTT output with standalone policy → connect() throws PolicyViolationError
- MQTT output with local_network policy + server not in allowedHosts → throws
- MQTT output with local_network policy + server in allowedHosts → connects
- MQTT output with connected policy → connects (unrestricted)
- Sparkplug mode: validates hub broker URL against policy
- Error message includes mode, target, and reason

`test/unit/pipeline/plugin-factory.test.ts` — add tests:
- buildPipeline passes networkPolicy to MQTT output
- MQTT output with hub enabled but policy blocking hub → throws on connect

`test/integration/network-policy-enforcement.test.ts` — new file:
- Full pipeline with standalone mode + MQTT output → startup fails with clear error
- Full pipeline with local_network + local store only → starts fine
- Full pipeline with connected mode + MQTT output → starts fine
- Hub enabled + standalone mode → startup fails with specific hub-blocked message

---

### 8.3: config validate integration

**Modified file:** `src/cli/commands/config-validate.ts`

The `config validate` command already validates config. Enhance it to:

1. Report the resolved network policy (mode + effective egress rules)
2. Flag conflicts between policy and configured outputs:
   - Hub enabled but policy blocks hub
   - MQTT output with non-local servers but policy is local_network/standalone
3. These are **warnings**, not errors — the config is syntactically valid, but the pipeline will fail to start

**Tests:** Add to `test/unit/cli/config-validate.test.ts`
- Config with policy conflicts shows warnings
- Config with consistent policy shows clean output
- Network policy section reported in validation output

---

### 8.4: config init templates + integration test

**Modified file:** `src/cli/commands/config-init.ts`

The config init templates already generate `[network_policy]` sections (verified in existing code). Ensure:

1. Generated configs for all 3 modes pass `config validate` cleanly (no false warnings)
2. Generated standalone config with only local_store output validates clean
3. Generated connected config with hub + MQTT sparkplug output validates clean

**New file:** `test/integration/network-policy-startup.test.ts`

End-to-end integration test that verifies the full flow:

1. Parse a TOML config with network_policy
2. Build pipeline via plugin factory (with mock outputs)
3. Verify NetworkPolicy is wired through
4. Verify startup enforcement catches violations
5. Verify startup succeeds when policy is consistent

**Also update** `test/unit/cli/config-init.test.ts`:
- Verify all 3 mode templates include valid `[network_policy]` sections
- Verify generated configs parse without error
- Verify generated standalone config doesn't include active MQTT outputs

---

## What This Phase Does NOT Build

These are explicitly deferred per PRD §10 and build sequence:

| Feature | Reason | When |
|---------|--------|------|
| DNS blocking (OS-level) | Requires iptables/nftables, privilege escalation, platform-specific | Post-MVP |
| Ingress enforcement (CIDR binding) | Requires Web UI server — Phase 9 | Phase 9 |
| Mode transition Sparkplug messages | "Going standalone" NDATA | Post-MVP |
| NTP reachability check | Requires network probing | Post-MVP |
| USB/file-based updates | Standalone update mechanism | Post-MVP |
| Config file encryption | Secret store integration | Post-MVP |
| `allow_local_subnet` rule | Requires subnet detection at runtime | Post-MVP |
| Runtime policy changes | Policy is read at startup, immutable | Post-MVP |

---

## Acceptance Criteria

1. **Config parsing:** `[network_policy]` section with all 3 modes parses correctly with Zod validation
2. **Preset resolution:** Each mode produces correct default egress/ingress rules per PRD §10 table
3. **Override merging:** Explicit egress/ingress fields override mode defaults
4. **Fail-fast startup:** Pipeline refuses to start if any output violates the policy, with a clear FATAL log message
5. **MQTT enforcement:** MQTT output (both sparkplug and plain) validates broker/server against policy before connecting
6. **Hub conflict detection:** Hub enabled + incompatible policy → clear error at startup
7. **No false positives:** Local-only outputs (local_store, file, stdout) are never blocked
8. **config validate:** Reports resolved policy and flags policy/output conflicts as warnings
9. **config init:** All 3 mode templates generate valid, consistent configs
10. **All existing tests still pass** — no regressions

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| URL parsing edge cases (MQTT URIs) | Medium | Use `new URL()` for parsing, add tests for tcp://, mqtt://, mqtts:// schemes |
| Breaking existing MQTT output tests | Low | NetworkPolicy is optional in constructor — existing tests pass `undefined` |
| Config schema backward compatibility | Low | `[network_policy]` is optional, defaults to connected mode |
| Overcomplicating host matching | Medium | Keep it simple: string match host+port, no CIDR for egress (CIDR is ingress only) |
