// CollatrEdge — Stdout output plugin
// PRD refs: §19 MVP Plugin Inventory (stdout: P0, for debugging)

import { z } from "zod/v4";
import type { Output } from "@core/plugin-types";
import type { Metric, FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export const StdoutConfigSchema = z.object({
  data_format: z.enum(["json", "line_protocol"]).default("json")
    .describe("Output format: 'json' for JSON objects, 'line_protocol' for Telegraf-compatible line protocol"),
});

export type StdoutConfig = z.infer<typeof StdoutConfigSchema>;

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/** Serialise a FieldValue for line protocol (Telegraf-compatible). */
function formatFieldValueLP(value: FieldValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return `${value}i`;
  if (typeof value === "string") return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  // number — integers get "i" suffix, floats stay bare
  if (Number.isInteger(value)) return `${value}i`;
  return `${value}`;
}

/**
 * Escape a line protocol tag key, tag value, or measurement name.
 * Spaces, commas, and equals signs must be escaped with backslash.
 */
function escapeLP(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/ /g, "\\ ").replace(/,/g, "\\,").replace(/=/g, "\\=");
}

/** Escape a measurement name (same as tag but = is allowed). */
function escapeMeasurement(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/ /g, "\\ ").replace(/,/g, "\\,");
}

/**
 * Format a metric as Telegraf line protocol.
 * Format: `measurement,tag1=val1,tag2=val2 field1=val1,field2=val2 timestamp`
 * Timestamp is in nanoseconds (bigint).
 */
export function toLineProtocol(metric: Metric): string {
  let line = escapeMeasurement(metric.name);

  // Tags (sorted — already sorted by MetricImpl)
  for (const [key, value] of metric.tags) {
    line += `,${escapeLP(key)}=${escapeLP(value)}`;
  }

  // Fields (at least one required by line protocol spec)
  const fieldParts: string[] = [];
  for (const [key, value] of metric.fields) {
    fieldParts.push(`${escapeLP(key)}=${formatFieldValueLP(value)}`);
  }
  line += ` ${fieldParts.join(",")}`;

  // Timestamp in nanoseconds
  line += ` ${metric.timestamp}`;

  return line;
}

/**
 * Format a metric as a JSON object.
 * Converts Maps to plain objects and bigint timestamp to string for JSON compat.
 */
export function toJSON(metric: Metric): string {
  const tags: Record<string, string> = {};
  for (const [key, value] of metric.tags) {
    tags[key] = value;
  }

  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of metric.fields) {
    fields[key] = value;
  }

  return JSON.stringify({
    name: metric.name,
    tags,
    fields,
    timestamp: metric.timestamp.toString(),
  }, (_, v) => typeof v === "bigint" ? v.toString() : v);
}

// ---------------------------------------------------------------------------
// Stdout output
// ---------------------------------------------------------------------------

export class StdoutOutput implements Output {
  private config: StdoutConfig;

  constructor(config: StdoutConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // No-op — stdout is always available
  }

  async write(batch: Metric[]): Promise<void> {
    const formatter = this.config.data_format === "line_protocol" ? toLineProtocol : toJSON;
    for (const metric of batch) {
      console.log(formatter(metric));
    }
  }

  async close(): Promise<void> {
    // No-op
  }
}

export function createStdoutOutput(config: StdoutConfig): StdoutOutput {
  return new StdoutOutput(config);
}
