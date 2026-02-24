// CollatrEdge — Sparkplug B codec module
// PRD refs: §9 Hub Link & Control Plane, Appendix C Sparkplug B Topic Map
// ──────────────────────────────────────────────────────────────────────
// Wraps sparkplug-payload with CollatrEdge-specific logic:
// field value → Sparkplug type mapping, FNV-1a metric alias computation,
// and payload construction for each Sparkplug B message type.
// ──────────────────────────────────────────────────────────────────────

import spPayload from "sparkplug-payload";
import Long from "long";
import type { Metric, FieldValue } from "../core/metric.ts";

const sparkplug = spPayload.get("spBv1.0")!;

// ---------------------------------------------------------------------------
// Sparkplug B data types (subset CollatrEdge supports)
// ---------------------------------------------------------------------------

export type SparkplugDataType = "Int32" | "Int64" | "Double" | "Boolean" | "String";

// ---------------------------------------------------------------------------
// FieldValue → Sparkplug B type mapping (PRD §9)
// ---------------------------------------------------------------------------

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

export function fieldValueToSparkplugType(value: FieldValue): SparkplugDataType {
  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "string":
      return "String";
    case "bigint":
      return "Int64";
    case "number":
      if (Number.isInteger(value)) {
        return (value >= INT32_MIN && value <= INT32_MAX) ? "Int32" : "Int64";
      }
      return "Double";
    default:
      return "String";
  }
}

/** Convert a FieldValue to a value suitable for sparkplug-payload encoding */
function fieldValueToSparkplugValue(value: FieldValue, spType: SparkplugDataType): number | boolean | string | Long {
  if (typeof value === "bigint") {
    // Use Long for Int64 to preserve full 64-bit precision (Finding 5 fix)
    if (spType === "Int64") {
      return Long.fromString(value.toString());
    }
    return Number(value);
  }
  // Integer numbers mapped to Int64 also need Long representation
  if (typeof value === "number" && spType === "Int64") {
    return Long.fromNumber(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash → metric alias computation (PRD §9)
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MOD_2_31 = 2147483648; // 2^31

function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

export function computeMetricAlias(deviceId: string, metricName: string): number {
  return fnv1a32(`${deviceId}/${metricName}`) % MOD_2_31;
}

export function resolveAliases(deviceId: string, metricNames: string[]): Map<string, number> {
  const aliases = new Map<string, number>();
  const usedAliases = new Set<number>();

  for (const name of metricNames) {
    let alias = computeMetricAlias(deviceId, name);
    // Collision resolution: increment until unique
    while (usedAliases.has(alias)) {
      alias = (alias + 1) % MOD_2_31;
    }
    usedAliases.add(alias);
    aliases.set(name, alias);
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Payload encoding
// ---------------------------------------------------------------------------

export function encodeNBirth(options: {
  bdSeq: number;
  swVersion: string;
  hwPlatform: string;
  hostname: string;
  pluginsLoaded: string[];
  configVersion?: string;
  agentMetrics: { name: string; type: SparkplugDataType; value: unknown }[];
}): Buffer {
  const metrics: Array<{
    name: string;
    type: SparkplugDataType;
    value: unknown;
    timestamp: number;
    properties?: Record<string, { type: SparkplugDataType; value: unknown }>;
  }> = [];
  const now = Date.now();

  // bdSeq metric
  metrics.push({
    name: "bdSeq",
    type: "Int64",
    value: options.bdSeq,
    timestamp: now,
  });

  // Node Control metrics
  metrics.push({
    name: "Node Control/Rebirth",
    type: "Boolean",
    value: false,
    timestamp: now,
  });
  metrics.push({
    name: "Node Control/Config Version",
    type: "String",
    value: options.configVersion ?? "none",
    timestamp: now,
  });

  // Properties as metrics with String type
  metrics.push({
    name: "Properties/sw_version",
    type: "String",
    value: options.swVersion,
    timestamp: now,
  });
  metrics.push({
    name: "Properties/hw_platform",
    type: "String",
    value: options.hwPlatform,
    timestamp: now,
  });
  metrics.push({
    name: "Properties/hostname",
    type: "String",
    value: options.hostname,
    timestamp: now,
  });
  metrics.push({
    name: "Properties/plugins_loaded",
    type: "String",
    value: options.pluginsLoaded.join(","),
    timestamp: now,
  });

  // Agent self-metrics
  for (const m of options.agentMetrics) {
    metrics.push({
      name: `Agent Metrics/${m.name}`,
      type: m.type,
      value: m.value,
      timestamp: now,
    });
  }

  const encoded = sparkplug.encodePayload({
    timestamp: now,
    seq: 0, // NBIRTH always resets seq to 0 (Finding 10)
    metrics: metrics as Parameters<typeof sparkplug.encodePayload>[0]["metrics"],
  });

  return Buffer.from(encoded);
}

export function encodeNDeath(bdSeq: number): Buffer {
  const encoded = sparkplug.encodePayload({
    timestamp: Date.now(),
    metrics: [
      {
        name: "bdSeq",
        type: "Int64" as const,
        value: bdSeq,
        timestamp: Date.now(),
      },
    ],
  });
  return Buffer.from(encoded);
}

export function encodeDBirth(options: {
  seq: number;
  deviceId: string;
  metrics: Metric[];
  aliases: Map<string, number>;
  pluginType: string;
  pluginAlias: string;
  properties?: Record<string, string>;
}): Buffer {
  const now = Date.now();
  const spMetrics: Array<{
    name: string;
    type: SparkplugDataType;
    value: unknown;
    alias: number;
    timestamp: number;
    properties?: Record<string, { type: SparkplugDataType; value: unknown }>;
  }> = [];

  // Build metrics from CollatrEdge Metric objects
  for (const metric of options.metrics) {
    for (const [fieldName, fieldValue] of metric.fields) {
      const fullName = metric.name === fieldName ? fieldName : `${metric.name}/${fieldName}`;
      const alias = options.aliases.get(fullName) ?? 0;
      const spType = fieldValueToSparkplugType(fieldValue);

      const spMetric: (typeof spMetrics)[0] = {
        name: fullName,
        type: spType,
        value: fieldValueToSparkplugValue(fieldValue, spType),
        alias,
        timestamp: now,
      };

      spMetrics.push(spMetric);
    }
  }

  // Add device properties as first metric with properties
  if (spMetrics.length > 0) {
    const props: Record<string, { type: SparkplugDataType; value: unknown }> = {
      plugin_type: { type: "String", value: options.pluginType },
      plugin_alias: { type: "String", value: options.pluginAlias },
    };
    if (options.properties) {
      for (const [k, v] of Object.entries(options.properties)) {
        props[k] = { type: "String", value: v };
      }
    }
    spMetrics[0]!.properties = props;
  }

  const encoded = sparkplug.encodePayload({
    timestamp: now,
    seq: options.seq,
    metrics: spMetrics as Parameters<typeof sparkplug.encodePayload>[0]["metrics"],
  });

  return Buffer.from(encoded);
}

export function encodeDDeath(seq: number): Buffer {
  const encoded = sparkplug.encodePayload({
    timestamp: Date.now(),
    seq,
    metrics: [],
  });
  return Buffer.from(encoded);
}

export function encodeDData(options: {
  seq: number;
  metrics: Metric[];
  aliases: Map<string, number>;
}): Buffer {
  const spMetrics: Array<{
    alias: number;
    type: SparkplugDataType;
    value: unknown;
    timestamp: number;
  }> = [];

  for (const metric of options.metrics) {
    const rawTs = Number(metric.timestamp / 1_000_000n); // ns → ms
    const ts = rawTs > 0 ? rawTs : Date.now(); // Fallback for zero timestamp (Finding 14)
    for (const [fieldName, fieldValue] of metric.fields) {
      const fullName = metric.name === fieldName ? fieldName : `${metric.name}/${fieldName}`;
      const alias = options.aliases.get(fullName) ?? 0;
      const spType = fieldValueToSparkplugType(fieldValue);
      spMetrics.push({
        alias,
        type: spType,
        value: fieldValueToSparkplugValue(fieldValue, spType),
        timestamp: ts,
      });
    }
  }

  const encoded = sparkplug.encodePayload({
    timestamp: Date.now(),
    seq: options.seq,
    metrics: spMetrics as Parameters<typeof sparkplug.encodePayload>[0]["metrics"],
  });

  return Buffer.from(encoded);
}

export function encodeNData(options: {
  seq: number;
  metrics: { name: string; type: SparkplugDataType; value: unknown; timestamp?: bigint }[];
}): Buffer {
  const now = Date.now();
  const spMetrics = options.metrics.map((m) => ({
    name: m.name,
    type: m.type as SparkplugDataType,
    value: typeof m.value === "bigint"
      ? (m.type === "Int64" ? Long.fromString(m.value.toString()) : Number(m.value))
      : (typeof m.value === "number" && m.type === "Int64" ? Long.fromNumber(m.value) : m.value),
    timestamp: m.timestamp ? Number(m.timestamp / 1_000_000n) : now,
  }));

  const encoded = sparkplug.encodePayload({
    timestamp: now,
    seq: options.seq,
    metrics: spMetrics as Parameters<typeof sparkplug.encodePayload>[0]["metrics"],
  });

  return Buffer.from(encoded);
}

// ---------------------------------------------------------------------------
// Payload decoding
// ---------------------------------------------------------------------------

export function decodeNCmd(payload: Buffer): {
  metrics: { name: string; value: unknown; type: string }[];
} {
  const decoded = sparkplug.decodePayload(new Uint8Array(payload));
  const metrics = (decoded.metrics ?? []).map((m) => ({
    name: m.name ?? "",
    value: m.value,
    type: (m.type as string) ?? "Unknown",
  }));
  return { metrics };
}
