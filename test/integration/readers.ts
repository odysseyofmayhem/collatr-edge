/**
 * Data readers for integration test verification.
 *
 * Parses three data sources:
 * 1. Edge JSONL output (metrics.jsonl)
 * 2. Simulator batch CSV (signals.csv)
 * 3. Simulator ground truth JSONL (ground_truth.jsonl)
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EdgeMetric {
  /** Metric name (e.g. "press.line_speed" or full MQTT topic) */
  name: string;
  /** Tags map (includes _device_id, protocol, topic, etc.) */
  tags: Record<string, string>;
  /** Fields map (value, and for MQTT: timestamp, unit, quality) */
  fields: Record<string, string | number | boolean>;
  /** Edge wall-clock timestamp in nanoseconds (as bigint) */
  timestamp: bigint;
}

export interface SimSignalRow {
  /** Sim time in seconds (float, relative to reference epoch) */
  timestamp: number;
  /** Signal ID (e.g. "press.line_speed", "coder.ink_level") */
  signalId: string;
  /** Signal value */
  value: number | string;
  /** Quality flag: "good", "uncertain", "bad" */
  quality: string;
}

export interface GroundTruthEvent {
  /** Sim time as ISO 8601 string */
  simTime: string;
  /** Event type (scenario_start, scenario_end, state_change, etc.) */
  event: string;
  /** All other fields from the event record */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Edge JSONL reader
// ---------------------------------------------------------------------------

/**
 * Parse Edge metrics JSONL file.
 *
 * Each line is: {"name":"...","tags":{...},"fields":{...},"timestamp":"..."}
 * Timestamp is a nanosecond wall-clock string (parsed to bigint).
 */
export function readEdgeMetrics(path: string): EdgeMetric[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const metrics: EdgeMetric[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const raw = JSON.parse(lines[i]);
      metrics.push({
        name: raw.name ?? "",
        tags: raw.tags ?? {},
        fields: raw.fields ?? {},
        timestamp: BigInt(raw.timestamp ?? "0"),
      });
    } catch (err) {
      // Skip malformed lines (e.g. partial writes on unclean shutdown)
      console.warn(`WARN: Skipping malformed JSONL line ${i + 1}: ${(err as Error).message}`);
    }
  }

  return metrics;
}

/**
 * Group Edge metrics by _device_id tag.
 * Returns a map of device_id -> metrics array.
 */
export function groupByDeviceId(metrics: EdgeMetric[]): Map<string, EdgeMetric[]> {
  const groups = new Map<string, EdgeMetric[]>();
  for (const m of metrics) {
    const deviceId = m.tags._device_id ?? "__none__";
    let arr = groups.get(deviceId);
    if (!arr) {
      arr = [];
      groups.set(deviceId, arr);
    }
    arr.push(m);
  }
  return groups;
}

/**
 * Group Edge metrics by metric name.
 * Returns a map of name -> metrics array.
 */
export function groupByName(metrics: EdgeMetric[]): Map<string, EdgeMetric[]> {
  const groups = new Map<string, EdgeMetric[]>();
  for (const m of metrics) {
    let arr = groups.get(m.name);
    if (!arr) {
      arr = [];
      groups.set(m.name, arr);
    }
    arr.push(m);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Batch CSV reader
// ---------------------------------------------------------------------------

/**
 * Parse simulator batch CSV file.
 *
 * Format: timestamp,signal_id,value,quality
 * - timestamp: float (sim_time seconds since reference epoch)
 * - signal_id: string (e.g. "press.line_speed")
 * - value: number or string
 * - quality: string ("good", "uncertain", "bad")
 */
export function readBatchCSV(path: string): SimSignalRow[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const rows: SimSignalRow[] = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    // Simple CSV parse (no quoted fields expected in this format)
    const parts = line.split(",");
    if (parts.length < 4) {
      console.warn(`WARN: Skipping malformed CSV line ${i + 1}: expected 4 columns, got ${parts.length}`);
      continue;
    }

    const timestamp = parseFloat(parts[0]);
    const signalId = parts[1];
    const rawValue = parts[2];
    const quality = parts[3];

    // Try to parse value as number, fall back to string
    const numValue = Number(rawValue);
    const value = Number.isNaN(numValue) ? rawValue : numValue;

    rows.push({ timestamp, signalId, value, quality });
  }

  return rows;
}

/**
 * Group batch CSV rows by signal_id.
 * Returns a map of signal_id -> rows (sorted by timestamp).
 */
export function groupBatchBySignal(rows: SimSignalRow[]): Map<string, SimSignalRow[]> {
  const groups = new Map<string, SimSignalRow[]>();
  for (const row of rows) {
    let arr = groups.get(row.signalId);
    if (!arr) {
      arr = [];
      groups.set(row.signalId, arr);
    }
    arr.push(row);
  }
  // Sort each group by timestamp
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Ground truth JSONL reader
// ---------------------------------------------------------------------------

/**
 * Parse simulator ground truth JSONL file.
 *
 * First line is a config header (event type absent or "config").
 * Subsequent lines are event records with sim_time + event fields.
 */
export function readGroundTruth(path: string): GroundTruthEvent[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const events: GroundTruthEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const raw = JSON.parse(lines[i]);
      // Skip config header (first line, has "config" or no "event" field)
      if (!raw.event || raw.event === "config") continue;

      events.push({
        simTime: raw.sim_time ?? "",
        event: raw.event,
        ...raw,
      });
    } catch (err) {
      console.warn(`WARN: Skipping malformed ground truth line ${i + 1}: ${(err as Error).message}`);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

export interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  stdev: number;
}

/** Compute basic statistics for an array of numbers. */
export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, stdev: 0 };
  }

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const mean = sum / values.length;

  let sumSqDiff = 0;
  for (const v of values) {
    const diff = v - mean;
    sumSqDiff += diff * diff;
  }
  const stdev = Math.sqrt(sumSqDiff / values.length);

  return { count: values.length, min, max, mean, stdev };
}
