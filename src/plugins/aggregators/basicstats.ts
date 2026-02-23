// CollatrEdge — Basicstats aggregator plugin
// PRD refs: §6 Plugin System (Aggregator contract), §19 MVP Plugin Inventory, Appendix A
//
// Computes min, max, mean, count, sum, variance, stdev over configurable time windows.
// Aggregator contract: add() accumulates, push() emits summaries, reset() clears state.
// Runtime handles: copying metrics, auto-forwarding originals, periodic push timing,
// calling reset() after push(), and drop_original suppression.

import { z } from "zod/v4";
import { MetricFilter, MetricFilterSchema } from "@core/metric-filter";
import type { Aggregator } from "@core/plugin-types";
import type { Accumulator } from "@core/accumulator";
import type { Metric, FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const STAT_NAMES = ["count", "min", "max", "sum", "mean", "variance", "stdev"] as const;
type StatName = (typeof STAT_NAMES)[number];

export const BasicstatsConfigSchema = z.object({
  period: z.string().default("60s"),
  drop_original: z.boolean().default(false),
  stats: z
    .array(z.enum(STAT_NAMES))
    .default(["count", "min", "max", "sum", "mean"]),
  // Per-plugin filtering (which metrics to aggregate).
  // Intentionally limited to name/tag filters — not field filters. Aggregators
  // accumulate ALL numeric fields from accepted metrics. Field-level filtering
  // should be done upstream via a filter processor if needed.
  namepass: MetricFilterSchema.shape.namepass,
  namedrop: MetricFilterSchema.shape.namedrop,
  tagpass: MetricFilterSchema.shape.tagpass,
  tagdrop: MetricFilterSchema.shape.tagdrop,
});

export type BasicstatsConfig = z.infer<typeof BasicstatsConfigSchema>;

// ---------------------------------------------------------------------------
// Running statistics per field (Welford's online algorithm)
// ---------------------------------------------------------------------------

/**
 * Welford's online algorithm for numerically stable computation of
 * mean, variance, and standard deviation in a single pass.
 *
 * Reference: Welford, B. P. (1962). "Note on a Method for Calculating
 * Corrected Sums of Squares and Products". Technometrics. 4 (3): 419–420.
 */
class FieldStats {
  count = 0;
  min = Infinity;
  max = -Infinity;
  sum = 0;
  // Welford's running values
  private _mean = 0;
  private _m2 = 0; // sum of squared differences from mean

  add(value: number): void {
    this.count++;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.sum += value;

    // Welford's update
    const delta = value - this._mean;
    this._mean += delta / this.count;
    const delta2 = value - this._mean;
    this._m2 += delta * delta2;
  }

  get mean(): number {
    return this._mean;
  }

  /** Population variance (not sample variance). */
  get variance(): number {
    if (this.count < 2) return 0;
    return this._m2 / this.count;
  }

  get stdev(): number {
    return Math.sqrt(this.variance);
  }
}

// ---------------------------------------------------------------------------
// Per-series accumulation state
// ---------------------------------------------------------------------------

interface SeriesState {
  name: string;
  tags: Record<string, string>;
  fields: Map<string, FieldStats>;
}

// ---------------------------------------------------------------------------
// Basicstats aggregator
// ---------------------------------------------------------------------------

export class BasicstatsAggregator implements Aggregator {
  private config: BasicstatsConfig;
  private filter: MetricFilter;
  private series: Map<string, SeriesState> = new Map();
  private statsSet: Set<StatName>;

  constructor(config: BasicstatsConfig) {
    this.config = config;
    this.filter = new MetricFilter({
      namepass: config.namepass,
      namedrop: config.namedrop,
      tagpass: config.tagpass,
      tagdrop: config.tagdrop,
    });
    this.statsSet = new Set(config.stats);
  }

  /**
   * Accumulate numeric field values from a metric.
   * Called by runtime with a copy of each metric.
   * Groups by hashId (name + sorted tags) — each series tracked independently.
   */
  add(metric: Metric): void {
    // Apply per-plugin filtering (namepass/namedrop/tagpass/tagdrop)
    if (!this.filter.isNoop) {
      const result = this.filter.apply(metric);
      if (result === null) return;
    }

    const key = metric.hashId().toString();

    let state = this.series.get(key);
    if (!state) {
      // Capture tags as plain object for later use in push()
      const tags: Record<string, string> = {};
      for (const [k, v] of metric.tags) {
        tags[k] = v;
      }
      state = { name: metric.name, tags, fields: new Map() };
      this.series.set(key, state);
    }

    // Accumulate numeric fields, skip string/boolean
    for (const [fieldName, fieldValue] of metric.fields) {
      let numValue: number | undefined;

      if (typeof fieldValue === "number") {
        numValue = fieldValue;
      } else if (typeof fieldValue === "bigint") {
        if (fieldValue > BigInt(Number.MAX_SAFE_INTEGER)) {
          console.warn(
            `[basicstats] BigInt field "${fieldName}" exceeds MAX_SAFE_INTEGER, precision loss possible`,
          );
        }
        numValue = Number(fieldValue);
      }
      // string and boolean fields are silently skipped

      if (numValue !== undefined) {
        let fs = state.fields.get(fieldName);
        if (!fs) {
          fs = new FieldStats();
          state.fields.set(fieldName, fs);
        }
        fs.add(numValue);
      }
    }
  }

  /**
   * Emit summary metrics for all accumulated series.
   * Called by runtime when the aggregation period fires.
   * Emits via acc.addFields() with computed statistics.
   */
  push(acc: Accumulator): void {
    for (const state of this.series.values()) {
      if (state.fields.size === 0) continue;

      const summaryFields: Record<string, FieldValue> = {};

      for (const [fieldName, fs] of state.fields) {
        if (fs.count === 0) continue;

        if (this.statsSet.has("count")) {
          summaryFields[`${fieldName}_count`] = fs.count;
        }
        if (this.statsSet.has("min")) {
          summaryFields[`${fieldName}_min`] = fs.min;
        }
        if (this.statsSet.has("max")) {
          summaryFields[`${fieldName}_max`] = fs.max;
        }
        if (this.statsSet.has("sum")) {
          summaryFields[`${fieldName}_sum`] = fs.sum;
        }
        if (this.statsSet.has("mean")) {
          summaryFields[`${fieldName}_mean`] = fs.mean;
        }
        if (this.statsSet.has("variance")) {
          summaryFields[`${fieldName}_variance`] = fs.variance;
        }
        if (this.statsSet.has("stdev")) {
          summaryFields[`${fieldName}_stdev`] = fs.stdev;
        }
      }

      if (Object.keys(summaryFields).length > 0) {
        acc.addFields(state.name, summaryFields, state.tags);
      }
    }
  }

  /** Clear accumulated state for the next aggregation window. */
  reset(): void {
    this.series.clear();
  }
}

export function createBasicstatsAggregator(config: BasicstatsConfig): BasicstatsAggregator {
  return new BasicstatsAggregator(config);
}
