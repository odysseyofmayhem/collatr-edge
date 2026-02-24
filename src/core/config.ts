// CollatrEdge — Configuration parser
// PRD ref: §7 Configuration

import { parse as parseTOML } from "smol-toml";
import { z } from "zod/v4";
import {
  NetworkPolicy,
  NetworkPolicySchema,
  resolveNetworkPolicy,
} from "./network-policy";

// ---------------------------------------------------------------------------
// Environment variable expansion (processed on raw text BEFORE TOML parsing)
// ---------------------------------------------------------------------------

// NOTE: Expansion runs on raw text BEFORE TOML parsing (Telegraf-compatible).
// Limitations: (1) Literal "${" in config values will be treated as env var refs.
// Use env vars to inject values containing "${" if needed. (2) No nested refs
// (e.g., ${VAR_${INNER}}) and no escaping (e.g., \${LITERAL}). Both match Telegraf.
export function expandEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    // ${VAR:?error message} — error if unset or empty
    const errIdx = expr.indexOf(":?");
    if (errIdx !== -1) {
      const varName = expr.slice(0, errIdx);
      const errorMsg = expr.slice(errIdx + 2);
      const value = process.env[varName];
      if (value === undefined || value === "") {
        throw new Error(errorMsg || `Required environment variable ${varName} is not set`);
      }
      return value;
    }

    // ${VAR:-default} — default if unset or empty
    const defIdx = expr.indexOf(":-");
    if (defIdx !== -1) {
      const varName = expr.slice(0, defIdx);
      const defaultVal = expr.slice(defIdx + 2);
      const value = process.env[varName];
      return (value !== undefined && value !== "") ? value : defaultVal;
    }

    // ${VAR} — error if unset
    const value = process.env[expr];
    if (value === undefined) {
      throw new Error(
        `Environment variable "${expr}" is not set. Use \${${expr}:-default} to provide a fallback.`,
      );
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Duration string parsing → milliseconds
// ---------------------------------------------------------------------------

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

export function parseDuration(duration: string): number {
  const match = duration.match(DURATION_RE);
  if (!match) {
    throw new Error(
      `Invalid duration: "${duration}". Expected format: <number><unit> where unit is ms, s, m, or h (e.g., "10s", "5m", "100ms", "1h")`,
    );
  }
  const value = parseFloat(match[1]!);
  const unit = match[2]!;
  switch (unit) {
    case "ms": return value;
    case "s":  return value * 1_000;
    case "m":  return value * 60_000;
    case "h":  return value * 3_600_000;
    default:   throw new Error(`Unknown duration unit: "${unit}"`);
  }
}

// ---------------------------------------------------------------------------
// Secret reference detection — mark but don't resolve (PRD §7)
// ---------------------------------------------------------------------------

const SECRET_REF_RE = /@\{[^}]+\}/g;

export function findSecretRefs(obj: unknown, path = ""): string[] {
  const refs: string[] = [];
  if (typeof obj === "string") {
    // Reset regex lastIndex since we reuse the global regex
    SECRET_REF_RE.lastIndex = 0;
    const matches = obj.match(SECRET_REF_RE);
    if (matches) {
      for (const m of matches) {
        refs.push(`${path}: ${m}`);
      }
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      refs.push(...findSecretRefs(obj[i], `${path}[${i}]`));
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      refs.push(...findSecretRefs(value, path ? `${path}.${key}` : key));
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Zod schema for [agent] section (PRD §7)
// ---------------------------------------------------------------------------

/** Zod refinement: validates that a string is a valid duration (parseable by parseDuration). */
const durationString = z.string().check(
  z.refine((s) => { try { parseDuration(s); return true; } catch { return false; } },
  "Invalid duration string. Expected format: <number><unit> (e.g., \"10s\", \"5m\", \"100ms\", \"1h\")"),
);

const AgentSchema = z.object({
  hostname: z.string().optional(),
  interval: durationString.default("10s"),
  round_interval: z.boolean().default(true),
  collection_jitter: durationString.default("0s"),
  collection_offset: durationString.default("0s"),
  flush_interval: durationString.default("10s"),
  flush_jitter: durationString.default("0s"),
  precision: durationString.default("1ms"),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  buffer: z.object({
    sync_mode: z.enum(["normal", "full"]).default("normal"),
  }).optional(),
  hub: z.object({
    enabled: z.boolean().default(false),
    group_id: z.string(),
    edge_node_id: z.string(),
    broker: z.string(),
    tls_cert: z.string().optional(),
    tls_key: z.string().optional(),
    heartbeat_interval: durationString.default("30s"),
  }).optional(),
});

export type AgentSettings = z.infer<typeof AgentSchema>;

// ---------------------------------------------------------------------------
// Plugin instance config (generic — per-plugin validation happens later)
// ---------------------------------------------------------------------------

export interface PluginInstanceConfig {
  alias?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Full parsed config
// ---------------------------------------------------------------------------

export interface AgentConfig {
  agent: AgentSettings;
  global_tags: Record<string, string>;
  inputs: Record<string, PluginInstanceConfig[]>;
  processors: Record<string, PluginInstanceConfig[]>;
  aggregators: Record<string, PluginInstanceConfig[]>;
  outputs: Record<string, PluginInstanceConfig[]>;
  networkPolicy: NetworkPolicy;
  secretRefs: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Config parsing pipeline
// ---------------------------------------------------------------------------

export function parseConfig(tomlText: string): AgentConfig {
  // 1. Expand env vars on raw text (PRD §7: "processed before TOML parsing")
  const expanded = expandEnvVars(tomlText);

  // 2. Parse TOML
  let raw: Record<string, unknown>;
  try {
    raw = parseTOML(expanded) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new Error(`Invalid TOML: ${err.message}`);
    }
    throw err;
  }

  // 3. Validate [agent] section
  const agentResult = AgentSchema.safeParse(raw.agent ?? {});
  if (!agentResult.success) {
    const issues = agentResult.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid [agent] config:\n${issues}`);
  }

  // 4. Parse [network_policy] section (PRD §10)
  const rawNetworkPolicy = raw.network_policy as Record<string, unknown> | undefined;
  let networkPolicy: NetworkPolicy;
  if (rawNetworkPolicy !== undefined) {
    const npResult = NetworkPolicySchema.safeParse(rawNetworkPolicy);
    if (!npResult.success) {
      const issues = npResult.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid [network_policy] config:\n${issues}`);
    }
    networkPolicy = resolveNetworkPolicy(npResult.data);
  } else {
    // Default to connected mode when [network_policy] is absent (backward compatible)
    networkPolicy = resolveNetworkPolicy();
  }

  // 5. Extract global_tags
  const globalTags = (raw.global_tags ?? {}) as Record<string, string>;

  // 6. Extract plugin sections
  const inputs = extractPluginSection(raw, "inputs");
  const processors = extractPluginSection(raw, "processors");
  const aggregators = extractPluginSection(raw, "aggregators");
  const outputs = extractPluginSection(raw, "outputs");

  // 7. Validate alias uniqueness across ALL plugin instances
  validateAliasUniqueness(inputs, processors, aggregators, outputs);

  // 8. Detect secret references (mark, don't resolve)
  const secretRefs = findSecretRefs(raw);

  // 9. Collect warnings (non-fatal config issues)
  // PRD §10: "If Hub credentials are present but mode != 'connected', log a warning"
  const warnings: string[] = [];
  const hubConfig = agentResult.data.hub;
  if (hubConfig?.enabled && !networkPolicy.egress.allowMqttHub) {
    warnings.push(
      `Hub credentials configured but network_policy ("${networkPolicy.mode}") prevents Hub connectivity. ` +
      `Either change mode to "connected", set egress.allow_mqtt_hub = true, or disable the Hub.`,
    );
  }

  return {
    agent: agentResult.data,
    global_tags: globalTags,
    inputs,
    processors,
    aggregators,
    outputs,
    networkPolicy,
    secretRefs,
    warnings,
  };
}

function extractPluginSection(
  raw: Record<string, unknown>,
  section: string,
): Record<string, PluginInstanceConfig[]> {
  const sectionData = raw[section];
  if (!sectionData || typeof sectionData !== "object") return {};

  const result: Record<string, PluginInstanceConfig[]> = {};
  for (const [pluginName, instances] of Object.entries(sectionData as Record<string, unknown>)) {
    if (Array.isArray(instances)) {
      result[pluginName] = instances as PluginInstanceConfig[];
    } else if (typeof instances === "object" && instances !== null) {
      result[pluginName] = [instances as PluginInstanceConfig];
    }
  }
  return result;
}

function validateAliasUniqueness(
  ...sections: Record<string, PluginInstanceConfig[]>[]
): void {
  const seen = new Map<string, string>(); // alias → location

  for (const section of sections) {
    for (const [pluginName, instances] of Object.entries(section)) {
      for (let i = 0; i < instances.length; i++) {
        const alias = instances[i]!.alias;
        if (alias) {
          const location = `${pluginName}[${i}]`;
          const existing = seen.get(alias);
          if (existing) {
            throw new Error(
              `Duplicate plugin alias "${alias}": first in ${existing}, again in ${location}`,
            );
          }
          seen.set(alias, location);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

export async function loadConfigFile(path: string): Promise<AgentConfig> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(
      `Config file not found: ${path}. Create one with 'collatr-edge config init' or specify a path with --config.`,
    );
  }
  const text = await file.text();
  return parseConfig(text);
}
