import { describe, it, expect } from "bun:test";
import {
  NetworkPolicy,
  NetworkPolicySchema,
  PolicyViolationError,
  MODE_PRESETS,
  resolveNetworkPolicy,
  parseHostPort,
  type EgressTarget,
  type NetworkPolicyMode,
  type ResolvedEgressRules,
  type ResolvedIngressRules,
} from "@core/network-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<EgressTarget> = {}): EgressTarget {
  return {
    host: "192.168.1.50",
    port: 1883,
    protocol: "mqtt",
    description: "test MQTT broker",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe("NetworkPolicySchema", () => {
  it("parses a full config section", () => {
    const result = NetworkPolicySchema.safeParse({
      mode: "local_network",
      egress: {
        allow_dns: false,
        allow_mqtt_hub: false,
        allowed_hosts: ["192.168.1.50:8086", "192.168.1.10:1883"],
      },
      ingress: {
        allow_local_webui: true,
        allow_local_api: true,
        allowed_cidrs: ["192.168.1.0/24"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("local_network");
      expect(result.data.egress!.allowed_hosts).toEqual([
        "192.168.1.50:8086",
        "192.168.1.10:1883",
      ]);
    }
  });

  it("defaults mode to connected when not specified", () => {
    const result = NetworkPolicySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("connected");
    }
  });

  it("accepts minimal config (mode only)", () => {
    const result = NetworkPolicySchema.safeParse({ mode: "standalone" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("standalone");
      expect(result.data.egress).toBeUndefined();
      expect(result.data.ingress).toBeUndefined();
    }
  });

  it("rejects invalid mode string", () => {
    const result = NetworkPolicySchema.safeParse({ mode: "banana" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid egress types", () => {
    const result = NetworkPolicySchema.safeParse({
      mode: "connected",
      egress: { allow_dns: "yes" },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mode presets
// ---------------------------------------------------------------------------

describe("MODE_PRESETS", () => {
  it("connected mode: unrestricted egress, DNS on, Hub on, local subnet on", () => {
    const p = MODE_PRESETS.connected;
    expect(p.egress.allowDns).toBe(true);
    expect(p.egress.allowMqttHub).toBe(true);
    expect(p.egress.allowLocalSubnet).toBe(true);
    expect(p.egress.unrestricted).toBe(true);
    expect(p.egress.allowedHosts).toEqual([]);
  });

  it("connected mode: ingress allows everything", () => {
    const p = MODE_PRESETS.connected;
    expect(p.ingress.allowLocalWebui).toBe(true);
    expect(p.ingress.allowLocalApi).toBe(true);
    expect(p.ingress.allowedCidrs).toEqual(["0.0.0.0/0"]);
  });

  it("local_network mode: no DNS, no Hub, local subnet on, not unrestricted", () => {
    const p = MODE_PRESETS.local_network;
    expect(p.egress.allowDns).toBe(false);
    expect(p.egress.allowMqttHub).toBe(false);
    expect(p.egress.allowLocalSubnet).toBe(true);
    expect(p.egress.unrestricted).toBe(false);
    expect(p.egress.allowedHosts).toEqual([]);
  });

  it("local_network mode: ingress restricted to RFC1918", () => {
    const p = MODE_PRESETS.local_network;
    expect(p.ingress.allowLocalWebui).toBe(true);
    expect(p.ingress.allowLocalApi).toBe(true);
    expect(p.ingress.allowedCidrs).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
  });

  it("standalone mode: everything blocked for egress, local subnet off", () => {
    const p = MODE_PRESETS.standalone;
    expect(p.egress.allowDns).toBe(false);
    expect(p.egress.allowMqttHub).toBe(false);
    expect(p.egress.allowLocalSubnet).toBe(false);
    expect(p.egress.unrestricted).toBe(false);
    expect(p.egress.allowedHosts).toEqual([]);
  });

  it("standalone mode: ingress allows local webui/api", () => {
    const p = MODE_PRESETS.standalone;
    expect(p.ingress.allowLocalWebui).toBe(true);
    expect(p.ingress.allowLocalApi).toBe(true);
    expect(p.ingress.allowedCidrs).toEqual(["0.0.0.0/0"]);
  });
});

// ---------------------------------------------------------------------------
// resolveNetworkPolicy
// ---------------------------------------------------------------------------

describe("resolveNetworkPolicy", () => {
  it("returns connected defaults when called with null/undefined", () => {
    const policy = resolveNetworkPolicy(null);
    expect(policy.mode).toBe("connected");
    expect(policy.egress.unrestricted).toBe(true);
    expect(policy.egress.allowDns).toBe(true);
    expect(policy.egress.allowMqttHub).toBe(true);
  });

  it("returns connected defaults when called with undefined", () => {
    const policy = resolveNetworkPolicy(undefined);
    expect(policy.mode).toBe("connected");
    expect(policy.egress.unrestricted).toBe(true);
  });

  it("returns connected defaults when called with empty object", () => {
    const policy = resolveNetworkPolicy({ mode: "connected" });
    expect(policy.mode).toBe("connected");
    expect(policy.egress.unrestricted).toBe(true);
    expect(policy.egress.allowDns).toBe(true);
  });

  it("resolves local_network mode to correct defaults", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    expect(policy.mode).toBe("local_network");
    expect(policy.egress.allowDns).toBe(false);
    expect(policy.egress.allowMqttHub).toBe(false);
    expect(policy.egress.unrestricted).toBe(false);
    expect(policy.egress.allowedHosts).toEqual([]);
    expect(policy.ingress.allowedCidrs).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
  });

  it("resolves standalone mode to correct defaults", () => {
    const policy = resolveNetworkPolicy({ mode: "standalone" });
    expect(policy.mode).toBe("standalone");
    expect(policy.egress.allowDns).toBe(false);
    expect(policy.egress.allowMqttHub).toBe(false);
    expect(policy.egress.unrestricted).toBe(false);
    expect(policy.egress.allowedHosts).toEqual([]);
  });

  it("merges egress overrides on top of mode defaults", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: {
        allow_dns: true,
        allowed_hosts: ["192.168.1.50:8086"],
      },
    });
    expect(policy.mode).toBe("local_network");
    expect(policy.egress.allowDns).toBe(true); // overridden
    expect(policy.egress.allowMqttHub).toBe(false); // mode default
    expect(policy.egress.allowedHosts).toEqual(["192.168.1.50:8086"]);
    expect(policy.egress.unrestricted).toBe(false);
  });

  it("merges ingress overrides on top of mode defaults", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      ingress: {
        allow_local_webui: false,
        allowed_cidrs: ["10.0.0.0/8"],
      },
    });
    expect(policy.ingress.allowLocalWebui).toBe(false); // overridden
    expect(policy.ingress.allowLocalApi).toBe(true); // mode default
    expect(policy.ingress.allowedCidrs).toEqual(["10.0.0.0/8"]);
  });

  it("connected mode with explicit allowed_hosts loses unrestricted", () => {
    const policy = resolveNetworkPolicy({
      mode: "connected",
      egress: {
        allowed_hosts: ["10.0.0.1:443"],
      },
    });
    expect(policy.mode).toBe("connected");
    expect(policy.egress.unrestricted).toBe(false);
    expect(policy.egress.allowedHosts).toEqual(["10.0.0.1:443"]);
  });

  it("connected mode with allow_dns=false loses unrestricted", () => {
    const policy = resolveNetworkPolicy({
      mode: "connected",
      egress: { allow_dns: false },
    });
    expect(policy.egress.unrestricted).toBe(false);
  });

  it("connected mode with allow_mqtt_hub=false loses unrestricted", () => {
    const policy = resolveNetworkPolicy({
      mode: "connected",
      egress: { allow_mqtt_hub: false },
    });
    expect(policy.egress.unrestricted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NetworkPolicy immutability
// ---------------------------------------------------------------------------

describe("NetworkPolicy immutability", () => {
  it("instance is frozen", () => {
    const policy = resolveNetworkPolicy({ mode: "standalone" });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("egress rules are frozen", () => {
    const policy = resolveNetworkPolicy({ mode: "standalone" });
    expect(Object.isFrozen(policy.egress)).toBe(true);
  });

  it("ingress rules are frozen", () => {
    const policy = resolveNetworkPolicy({ mode: "standalone" });
    expect(Object.isFrozen(policy.ingress)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkEgress — connected mode (unrestricted)
// ---------------------------------------------------------------------------

describe("checkEgress — connected mode (unrestricted)", () => {
  const policy = resolveNetworkPolicy({ mode: "connected" });

  it("allows any IP target", () => {
    const result = policy.checkEgress(makeTarget({ host: "8.8.8.8", port: 443 }));
    expect(result.allowed).toBe(true);
  });

  it("allows any hostname target", () => {
    const result = policy.checkEgress(
      makeTarget({ host: "mqtt.collatr.cloud", port: 8883, protocol: "mqtts" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("allows any protocol", () => {
    const result = policy.checkEgress(
      makeTarget({ host: "example.com", protocol: "https" }),
    );
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkEgress — standalone mode (all blocked)
// ---------------------------------------------------------------------------

describe("checkEgress — standalone mode", () => {
  const policy = resolveNetworkPolicy({ mode: "standalone" });

  it("denies any IP target", () => {
    const result = policy.checkEgress(makeTarget({ host: "192.168.1.50", port: 1883 }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("standalone");
    }
  });

  it("denies any hostname target (DNS disabled)", () => {
    const result = policy.checkEgress(
      makeTarget({ host: "broker.local", port: 1883 }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("DNS");
    }
  });

  it("denies MQTT hub target", () => {
    const result = policy.checkEgress(
      makeTarget({ host: "10.0.0.1", port: 8883, protocol: "mqtts" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("denial reason includes mode name", () => {
    const result = policy.checkEgress(makeTarget({ host: "10.0.0.1" }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("standalone");
    }
  });
});

// ---------------------------------------------------------------------------
// checkEgress — local_network mode
// ---------------------------------------------------------------------------

describe("checkEgress — local_network mode", () => {
  it("denies hostname targets (DNS disabled by default)", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    const result = policy.checkEgress(
      makeTarget({ host: "broker.local", port: 1883 }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("DNS");
      expect(result.reason).toContain("local_network");
    }
  });

  it("denies IP when no allowed_hosts configured", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: 1883 }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("allowed_hosts");
    }
  });

  it("allows IP:port in allowed_hosts", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50:1883"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: 1883 }),
    );
    expect(result.allowed).toBe(true);
  });

  it("denies IP:port NOT in allowed_hosts", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50:8086"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.99", port: 8086, protocol: "http" }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("not in allowed_hosts");
    }
  });

  it("denies same host but wrong port", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50:1883"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: 8086 }),
    );
    expect(result.allowed).toBe(false);
  });

  it("host-only entry matches any port", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50"] },
    });

    const result1 = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: 1883 }),
    );
    expect(result1.allowed).toBe(true);

    const result2 = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: 8086 }),
    );
    expect(result2.allowed).toBe(true);
  });

  it("allows hostname when allow_dns is explicitly true", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: {
        allow_dns: true,
        allowed_hosts: ["broker.local:1883"],
      },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "broker.local", port: 1883 }),
    );
    expect(result.allowed).toBe(true);
  });

  it("denies MQTT target not in allowedHosts with specific 'not in allowed_hosts' reason", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50:1883"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "10.0.0.1", port: 8883, protocol: "mqtts" }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Y2 fix: when allowedHosts is non-empty, denial should say "not in allowed_hosts"
      // rather than the misleading "Hub/MQTT connectivity disabled"
      expect(result.reason).toContain("not in allowed_hosts");
    }
  });

  it("denies MQTT when allowMqttHub is false and allowedHosts is empty", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    const result = policy.checkEgress(
      makeTarget({ host: "10.0.0.1", port: 8883, protocol: "mqtts" }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Hub/MQTT");
    }
  });

  it("allows MQTT to explicitly allowed host even when allowMqttHub is false", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.10:1883"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.10", port: 1883, protocol: "mqtt" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("allows MQTT when allowMqttHub is explicitly true", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: {
        allow_mqtt_hub: true,
        allow_dns: true,
        allowed_hosts: ["mqtt.collatr.cloud:8883"],
      },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "mqtt.collatr.cloud", port: 8883, protocol: "mqtts" }),
    );
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkEgress — connected mode with overrides (not unrestricted)
// ---------------------------------------------------------------------------

describe("checkEgress — connected mode with overrides", () => {
  it("restricts to allowed_hosts when explicit hosts are set", () => {
    const policy = resolveNetworkPolicy({
      mode: "connected",
      egress: { allowed_hosts: ["10.0.0.1:443"] },
    });
    expect(policy.egress.unrestricted).toBe(false);

    const allowed = policy.checkEgress(
      makeTarget({ host: "10.0.0.1", port: 443, protocol: "https" }),
    );
    expect(allowed.allowed).toBe(true);

    const denied = policy.checkEgress(
      makeTarget({ host: "10.0.0.2", port: 443, protocol: "https" }),
    );
    expect(denied.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkEgress — edge cases
// ---------------------------------------------------------------------------

describe("checkEgress — edge cases", () => {
  it("target without port matches host-only entry", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: undefined }),
    );
    expect(result.allowed).toBe(true);
  });

  it("target with port matches host-only entry", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: 9999 }),
    );
    expect(result.allowed).toBe(true);
  });

  it("target with port: undefined does not match entry with specific port (deny-by-default)", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50:8086"] },
    });
    const result = policy.checkEgress(
      makeTarget({ host: "192.168.1.50", port: undefined }),
    );
    // Target without a port does not match "192.168.1.50:8086" — safer to deny
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("not in allowed_hosts");
    }
  });

  it("invalid IPv4-like address (999.999.999.999) is treated as hostname, not IP", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    const result = policy.checkEgress(
      makeTarget({ host: "999.999.999.999", port: 1883 }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Invalid octets → treated as hostname → DNS check triggers
      expect(result.reason).toContain("DNS");
    }
  });

  it("multiple allowed_hosts entries — matches any", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: {
        allowed_hosts: [
          "192.168.1.50:8086",
          "192.168.1.10:1883",
          "192.168.1.1:123",
        ],
      },
    });
    expect(
      policy.checkEgress(makeTarget({ host: "192.168.1.10", port: 1883 })).allowed,
    ).toBe(true);
    expect(
      policy.checkEgress(makeTarget({ host: "192.168.1.1", port: 123, protocol: "udp" })).allowed,
    ).toBe(true);
    expect(
      policy.checkEgress(makeTarget({ host: "192.168.1.99", port: 1883 })).allowed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summary()
// ---------------------------------------------------------------------------

describe("summary()", () => {
  it("returns CONNECTED summary for connected mode", () => {
    const policy = resolveNetworkPolicy({ mode: "connected" });
    const s = policy.summary();
    expect(s).toContain("[CONNECTED]");
    expect(s).toContain("unrestricted");
  });

  it("returns LOCAL NETWORK summary for local_network mode", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      egress: { allowed_hosts: ["192.168.1.50:8086", "192.168.1.10:1883"] },
    });
    const s = policy.summary();
    expect(s).toContain("[LOCAL NETWORK]");
    expect(s).toContain("2 allowed hosts");
    expect(s).toContain("DNS off");
    expect(s).toContain("Hub off");
  });

  it("returns STANDALONE summary for standalone mode", () => {
    const policy = resolveNetworkPolicy({ mode: "standalone" });
    const s = policy.summary();
    expect(s).toContain("[STANDALONE]");
    expect(s).toContain("no external data transmission");
  });

  it("returns different strings for each mode", () => {
    const summaries = new Set([
      resolveNetworkPolicy({ mode: "connected" }).summary(),
      resolveNetworkPolicy({ mode: "local_network" }).summary(),
      resolveNetworkPolicy({ mode: "standalone" }).summary(),
    ]);
    expect(summaries.size).toBe(3);
  });

  it("connected mode with overrides shows restricted summary", () => {
    const policy = resolveNetworkPolicy({
      mode: "connected",
      egress: { allowed_hosts: ["10.0.0.1:443"] },
    });
    const s = policy.summary();
    expect(s).toContain("[CONNECTED]");
    expect(s).toContain("restricted");
    expect(s).toContain("1 allowed hosts");
  });

  it("local_network with no allowed_hosts shows 'no allowed hosts'", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    const s = policy.summary();
    expect(s).toContain("no allowed hosts");
  });
});

// ---------------------------------------------------------------------------
// Ingress rules — parsed and accessible, not enforced
// ---------------------------------------------------------------------------

describe("ingress rules", () => {
  it("are accessible on the policy object", () => {
    const policy = resolveNetworkPolicy({
      mode: "local_network",
      ingress: {
        allow_local_webui: true,
        allow_local_api: false,
        allowed_cidrs: ["192.168.1.0/24"],
      },
    });
    expect(policy.ingress.allowLocalWebui).toBe(true);
    expect(policy.ingress.allowLocalApi).toBe(false);
    expect(policy.ingress.allowedCidrs).toEqual(["192.168.1.0/24"]);
  });

  it("use mode defaults when not overridden", () => {
    const policy = resolveNetworkPolicy({ mode: "local_network" });
    expect(policy.ingress.allowLocalWebui).toBe(true);
    expect(policy.ingress.allowLocalApi).toBe(true);
    expect(policy.ingress.allowedCidrs).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
  });

  it("standalone ingress defaults allow local webui", () => {
    const policy = resolveNetworkPolicy({ mode: "standalone" });
    expect(policy.ingress.allowLocalWebui).toBe(true);
    expect(policy.ingress.allowLocalApi).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseHostPort
// ---------------------------------------------------------------------------

describe("parseHostPort", () => {
  it("parses host:port", () => {
    expect(parseHostPort("192.168.1.50:8086")).toEqual({
      host: "192.168.1.50",
      port: 8086,
    });
  });

  it("parses host only (no port)", () => {
    expect(parseHostPort("192.168.1.50")).toEqual({
      host: "192.168.1.50",
    });
  });

  it("parses hostname:port", () => {
    expect(parseHostPort("broker.local:1883")).toEqual({
      host: "broker.local",
      port: 1883,
    });
  });

  it("parses hostname only", () => {
    expect(parseHostPort("broker.local")).toEqual({
      host: "broker.local",
    });
  });

  it("handles whitespace", () => {
    expect(parseHostPort("  192.168.1.50:1883  ")).toEqual({
      host: "192.168.1.50",
      port: 1883,
    });
  });

  it("parses IPv6 in brackets with port", () => {
    expect(parseHostPort("[::1]:8080")).toEqual({
      host: "::1",
      port: 8080,
    });
  });

  it("parses IPv6 in brackets without port", () => {
    expect(parseHostPort("[::1]")).toEqual({
      host: "::1",
    });
  });
});

// ---------------------------------------------------------------------------
// PolicyViolationError
// ---------------------------------------------------------------------------

describe("PolicyViolationError", () => {
  it("extends Error", () => {
    const target = makeTarget({ description: "sparkplug_hub" });
    const err = new PolicyViolationError(
      target,
      "Hub connectivity disabled",
      "standalone",
    );
    expect(err).toBeInstanceOf(Error);
  });

  it("has name 'PolicyViolationError'", () => {
    const target = makeTarget({ description: "sparkplug_hub" });
    const err = new PolicyViolationError(
      target,
      "Hub connectivity disabled",
      "standalone",
    );
    expect(err.name).toBe("PolicyViolationError");
  });

  it("message includes target description", () => {
    const target = makeTarget({ description: "sparkplug_hub" });
    const err = new PolicyViolationError(
      target,
      "Hub connectivity disabled",
      "standalone",
    );
    expect(err.message).toContain("sparkplug_hub");
  });

  it("message includes host and port", () => {
    const target = makeTarget({
      host: "mqtt.collatr.cloud",
      port: 8883,
      description: "hub_broker",
    });
    const err = new PolicyViolationError(
      target,
      "Hub blocked",
      "local_network",
    );
    expect(err.message).toContain("mqtt.collatr.cloud:8883");
  });

  it("message includes mode", () => {
    const target = makeTarget({ description: "test_output" });
    const err = new PolicyViolationError(
      target,
      "All egress blocked",
      "standalone",
    );
    expect(err.message).toContain("standalone");
  });

  it("message includes reason", () => {
    const target = makeTarget({ description: "test_output" });
    const reason = "Hub connectivity disabled in standalone mode";
    const err = new PolicyViolationError(target, reason, "standalone");
    expect(err.message).toContain(reason);
  });

  it("stores target, reason, and policyMode as properties", () => {
    const target = makeTarget({ description: "hub" });
    const err = new PolicyViolationError(target, "blocked", "local_network");
    expect(err.target).toBe(target);
    expect(err.reason).toBe("blocked");
    expect(err.policyMode).toBe("local_network");
  });

  it("handles target without port in message", () => {
    const target = makeTarget({
      host: "10.0.0.1",
      port: undefined,
      description: "test",
    });
    const err = new PolicyViolationError(target, "denied", "standalone");
    expect(err.message).toContain("10.0.0.1");
    // Should not contain a stray colon when port is undefined
    expect(err.message).not.toContain("10.0.0.1:");
  });
});
