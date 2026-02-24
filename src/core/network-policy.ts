// CollatrEdge — Network Policy
// PRD ref: §10 Network Policy & Standalone Operation, §16 Security

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NetworkPolicyMode = "connected" | "local_network" | "standalone";

export interface EgressTarget {
  host: string;
  port?: number;
  protocol: string;
  description: string;
}

export type PolicyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ResolvedEgressRules {
  allowDns: boolean;
  allowMqttHub: boolean;
  allowLocalSubnet: boolean; // TODO: post-MVP — enforce when subnet detection is available
  allowedHosts: string[];
  unrestricted: boolean;
}

export interface ResolvedIngressRules {
  allowLocalWebui: boolean;
  allowLocalApi: boolean;
  allowedCidrs: string[];
}

// ---------------------------------------------------------------------------
// Zod schema for [network_policy] config section
// ---------------------------------------------------------------------------

export const NetworkPolicySchema = z.object({
  mode: z.enum(["connected", "local_network", "standalone"]).default("connected"),
  egress: z.object({
    allow_dns: z.boolean().optional(),
    allow_mqtt_hub: z.boolean().optional(),
    allow_local_subnet: z.boolean().optional(), // TODO: post-MVP — parsed but not enforced (PRD §10)
    allowed_hosts: z.array(z.string()).optional(),
  }).optional(),
  ingress: z.object({
    allow_local_webui: z.boolean().optional(),
    allow_local_api: z.boolean().optional(),
    allowed_cidrs: z.array(z.string()).optional(),
  }).optional(),
});

export type NetworkPolicyInput = z.infer<typeof NetworkPolicySchema>;

// ---------------------------------------------------------------------------
// Mode preset defaults (PRD §10 table)
// ---------------------------------------------------------------------------

interface ModePreset {
  egress: ResolvedEgressRules;
  ingress: ResolvedIngressRules;
}

export const MODE_PRESETS: Record<NetworkPolicyMode, ModePreset> = {
  connected: {
    egress: {
      allowDns: true,
      allowMqttHub: true,
      allowLocalSubnet: true,
      allowedHosts: [],
      unrestricted: true,
    },
    ingress: {
      allowLocalWebui: true,
      allowLocalApi: true,
      allowedCidrs: ["0.0.0.0/0"],
    },
  },
  local_network: {
    egress: {
      allowDns: false,
      allowMqttHub: false,
      allowLocalSubnet: true,
      allowedHosts: [],
      unrestricted: false,
    },
    ingress: {
      allowLocalWebui: true,
      allowLocalApi: true,
      allowedCidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    },
  },
  standalone: {
    egress: {
      allowDns: false,
      allowMqttHub: false,
      allowLocalSubnet: false,
      allowedHosts: [],
      unrestricted: false,
    },
    ingress: {
      allowLocalWebui: true,
      allowLocalApi: true,
      allowedCidrs: ["0.0.0.0/0"],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Host:port parsing for allowed_hosts matching
// ---------------------------------------------------------------------------

export interface ParsedHostPort {
  host: string;
  port?: number;
}

export function parseHostPort(entry: string): ParsedHostPort {
  const trimmed = entry.trim();
  // Check for IPv6 bracket notation: [::1]:8080
  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]");
    if (bracketEnd === -1) {
      return { host: trimmed };
    }
    const host = trimmed.slice(1, bracketEnd);
    const rest = trimmed.slice(bracketEnd + 1);
    if (rest.startsWith(":")) {
      const port = parseInt(rest.slice(1), 10);
      return Number.isNaN(port) ? { host } : { host, port };
    }
    return { host };
  }

  // host:port — only split on the last colon to handle IPv6 without brackets
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: trimmed };
  }

  const maybePart = trimmed.slice(lastColon + 1);
  const port = parseInt(maybePart, 10);

  // If the part after the last colon is a valid port number, treat it as host:port.
  // Otherwise, the whole string is the host (e.g. bare IPv6 "::1").
  if (!Number.isNaN(port) && port >= 0 && port <= 65535 && String(port) === maybePart) {
    return { host: trimmed.slice(0, lastColon), port };
  }

  return { host: trimmed };
}

// ---------------------------------------------------------------------------
// Hostname vs IP detection (for DNS blocking)
// ---------------------------------------------------------------------------

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpAddress(host: string): boolean {
  // IPv4 — regex matches the shape, then validate octet ranges
  if (IPV4_RE.test(host)) {
    return host.split(".").every((octet) => {
      const n = parseInt(octet, 10);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6 (contains colons)
  if (host.includes(":")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Resolve raw config → concrete rules
// ---------------------------------------------------------------------------

export function resolveNetworkPolicy(raw?: NetworkPolicyInput | null): NetworkPolicy {
  const mode: NetworkPolicyMode = raw?.mode ?? "connected";
  const preset = MODE_PRESETS[mode];

  // Merge egress: user overrides take precedence over mode defaults
  const egress: ResolvedEgressRules = {
    allowDns: raw?.egress?.allow_dns ?? preset.egress.allowDns,
    allowMqttHub: raw?.egress?.allow_mqtt_hub ?? preset.egress.allowMqttHub,
    allowLocalSubnet: raw?.egress?.allow_local_subnet ?? preset.egress.allowLocalSubnet, // TODO: post-MVP — parsed, not enforced
    allowedHosts: raw?.egress?.allowed_hosts ?? [...preset.egress.allowedHosts],
    // unrestricted: connected mode is unrestricted UNLESS user provides explicit egress overrides
    // that restrict things. But per PRD, unrestricted means no host restrictions.
    // If user sets allowed_hosts in connected mode, they want restrictions — set unrestricted = false.
    unrestricted: mode === "connected"
      && raw?.egress?.allowed_hosts === undefined
      && raw?.egress?.allow_dns !== false
      && raw?.egress?.allow_mqtt_hub !== false,
  };

  // Merge ingress: user overrides take precedence
  const ingress: ResolvedIngressRules = {
    allowLocalWebui: raw?.ingress?.allow_local_webui ?? preset.ingress.allowLocalWebui,
    allowLocalApi: raw?.ingress?.allow_local_api ?? preset.ingress.allowLocalApi,
    allowedCidrs: raw?.ingress?.allowed_cidrs ?? [...preset.ingress.allowedCidrs],
  };

  return new NetworkPolicy(mode, egress, ingress);
}

// ---------------------------------------------------------------------------
// NetworkPolicy (immutable)
// ---------------------------------------------------------------------------

export class NetworkPolicy {
  readonly mode: NetworkPolicyMode;
  readonly egress: Readonly<ResolvedEgressRules>;
  readonly ingress: Readonly<ResolvedIngressRules>;

  constructor(
    mode: NetworkPolicyMode,
    egress: ResolvedEgressRules,
    ingress: ResolvedIngressRules,
  ) {
    this.mode = mode;
    this.egress = Object.freeze({ ...egress });
    this.ingress = Object.freeze({ ...ingress });
    Object.freeze(this);
  }

  /**
   * Check whether an outbound connection target is allowed by this policy.
   *
   * Check order:
   * 1. Unrestricted (connected mode, no overrides) → always allowed
   * 2. DNS check: hostname (not IP) denied when allowDns=false
   * 3. Allowed hosts check: match or deny against allowedHosts list (when non-empty)
   * 4. Hub check: MQTT target denied when allowMqttHub=false (empty allowedHosts only)
   * 5. Mode-based denial for empty allowedHosts
   */
  checkEgress(target: EgressTarget): PolicyCheckResult {
    // 1. Unrestricted mode — everything goes
    if (this.egress.unrestricted) {
      return { allowed: true };
    }

    // 2. DNS check: if target host is a hostname (not an IP) and DNS is disabled
    if (!isIpAddress(target.host) && !this.egress.allowDns) {
      return {
        allowed: false,
        reason: `DNS resolution disabled in "${this.mode}" mode — hostname "${target.host}" cannot be resolved. Use an IP address or enable allow_dns.`,
      };
    }

    // 3. Check allowedHosts (if there are entries)
    if (this.egress.allowedHosts.length > 0) {
      if (matchesAllowedHosts(target, this.egress.allowedHosts)) {
        return { allowed: true };
      }
      // Target didn't match any entry — deny with specific "not in allowed_hosts" message
      return {
        allowed: false,
        reason: `Host "${target.host}${target.port ? ":" + target.port : ""}" not in allowed_hosts for "${this.mode}" mode.`,
      };
    }

    // 4. Hub check: MQTT target denied when allowMqttHub=false and allowedHosts is empty
    if (
      (target.protocol === "mqtt" || target.protocol === "mqtts") &&
      !this.egress.allowMqttHub
    ) {
      return {
        allowed: false,
        reason: `Hub/MQTT connectivity disabled in "${this.mode}" mode. Enable allow_mqtt_hub or add "${target.host}${target.port ? ":" + target.port : ""}" to allowed_hosts.`,
      };
    }

    // 5. Empty allowedHosts — mode-based denial
    if (this.mode === "standalone") {
      return {
        allowed: false,
        reason: `All egress blocked in standalone mode.`,
      };
    }

    if (this.mode === "local_network") {
      return {
        allowed: false,
        reason: `No allowed_hosts configured for local_network mode. Add the target to [network_policy.egress] allowed_hosts.`,
      };
    }

    // Fallback (shouldn't reach here for connected mode which is unrestricted)
    return {
      allowed: false,
      reason: `Egress to "${target.host}" denied by network policy ("${this.mode}" mode).`,
    };
  }

  /** Human-readable summary for startup logging. */
  summary(): string {
    switch (this.mode) {
      case "connected":
        if (this.egress.unrestricted) {
          return "[CONNECTED] unrestricted egress, full Hub connectivity";
        }
        return `[CONNECTED] restricted: ${this.egress.allowedHosts.length} allowed hosts, DNS ${this.egress.allowDns ? "on" : "off"}, Hub ${this.egress.allowMqttHub ? "on" : "off"}`;

      case "local_network": {
        const hostCount = this.egress.allowedHosts.length;
        const hostDesc = hostCount > 0 ? `${hostCount} allowed hosts` : "no allowed hosts";
        return `[LOCAL NETWORK] egress: ${hostDesc}, DNS ${this.egress.allowDns ? "on" : "off"}, Hub ${this.egress.allowMqttHub ? "on" : "off"}`;
      }

      case "standalone":
        return "[STANDALONE] no external data transmission";
    }
  }
}

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

function matchesAllowedHosts(target: EgressTarget, allowedHosts: string[]): boolean {
  for (const entry of allowedHosts) {
    const parsed = parseHostPort(entry);
    if (parsed.host !== target.host) continue;

    // Host-only entry (no port specified) → matches any port
    if (parsed.port === undefined) return true;

    // Host:port entry → must also match port
    if (target.port !== undefined && parsed.port === target.port) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PolicyViolationError
// ---------------------------------------------------------------------------

export class PolicyViolationError extends Error {
  readonly target: EgressTarget;
  readonly reason: string;
  readonly policyMode: NetworkPolicyMode;

  constructor(target: EgressTarget, reason: string, mode: NetworkPolicyMode) {
    const portStr = target.port ? `:${target.port}` : "";
    super(
      `Output "${target.description}" blocked by network_policy: ` +
      `egress to ${target.host}${portStr} denied in "${mode}" mode. ${reason}`,
    );
    this.name = "PolicyViolationError";
    this.target = target;
    this.reason = reason;
    this.policyMode = mode;
  }
}
