// CollatrEdge — Per-plugin metric filtering framework
// PRD refs: §7 Configuration (Filtering on every plugin)
//
// Six filter types, evaluated in order:
//   namepass → namedrop → tagpass → tagdrop → fieldpass → fielddrop
//
// Glob patterns support * (any chars) and ? (single char), case-sensitive.

import { z } from "zod/v4";
import type { Metric } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema (per-plugin, all fields optional)
// ---------------------------------------------------------------------------

export const MetricFilterSchema = z.object({
  namepass: z.array(z.string()).optional(),
  namedrop: z.array(z.string()).optional(),
  fieldpass: z.array(z.string()).optional(),
  fielddrop: z.array(z.string()).optional(),
  tagpass: z.record(z.string(), z.array(z.string())).optional(),
  tagdrop: z.record(z.string(), z.array(z.string())).optional(),
});

export type MetricFilterConfig = z.infer<typeof MetricFilterSchema>;

// ---------------------------------------------------------------------------
// Glob-to-regex compilation
// ---------------------------------------------------------------------------

/**
 * Compile a glob pattern to a RegExp.
 * Supports * (match any sequence of chars) and ? (match exactly one char).
 * All other regex metacharacters are escaped. Case-sensitive.
 */
export function globToRegex(pattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      regex += ".*";
    } else if (c === "?") {
      regex += ".";
    } else if (".+^${}()|[]\\".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

// ---------------------------------------------------------------------------
// MetricFilter class
// ---------------------------------------------------------------------------

export class MetricFilter {
  private readonly namepassRe: RegExp[] | null;
  private readonly namedropRe: RegExp[] | null;
  private readonly fieldpassRe: RegExp[] | null;
  private readonly fielddropRe: RegExp[] | null;
  private readonly tagpass: Record<string, RegExp[]> | null;
  private readonly tagdrop: Record<string, RegExp[]> | null;

  /** True when no filters are configured — apply() is a no-op passthrough. */
  readonly isNoop: boolean;

  constructor(config: MetricFilterConfig) {
    this.namepassRe = config.namepass?.length
      ? config.namepass.map(globToRegex)
      : null;
    this.namedropRe = config.namedrop?.length
      ? config.namedrop.map(globToRegex)
      : null;
    this.fieldpassRe = config.fieldpass?.length
      ? config.fieldpass.map(globToRegex)
      : null;
    this.fielddropRe = config.fielddrop?.length
      ? config.fielddrop.map(globToRegex)
      : null;

    this.tagpass = config.tagpass && Object.keys(config.tagpass).length > 0
      ? Object.fromEntries(
          Object.entries(config.tagpass).map(([key, patterns]) => [
            key,
            patterns.map(globToRegex),
          ]),
        )
      : null;
    this.tagdrop = config.tagdrop && Object.keys(config.tagdrop).length > 0
      ? Object.fromEntries(
          Object.entries(config.tagdrop).map(([key, patterns]) => [
            key,
            patterns.map(globToRegex),
          ]),
        )
      : null;

    this.isNoop =
      this.namepassRe === null &&
      this.namedropRe === null &&
      this.fieldpassRe === null &&
      this.fielddropRe === null &&
      this.tagpass === null &&
      this.tagdrop === null;
  }

  /**
   * Apply all configured filters to a metric.
   *
   * @returns The (possibly modified) metric if it passes, or null if dropped.
   *
   * Evaluation order (PRD §7):
   *   namepass → namedrop → tagpass → tagdrop → fieldpass → fielddrop
   *
   * Field filters (fieldpass/fielddrop) modify the metric's field set.
   * If all fields are removed, the metric is dropped (returns null).
   */
  apply(metric: Metric): Metric | null {
    if (this.isNoop) return metric;

    // 1. namepass — whitelist by metric name
    if (this.namepassRe !== null) {
      if (!this.namepassRe.some((re) => re.test(metric.name))) {
        return null;
      }
    }

    // 2. namedrop — blacklist by metric name
    if (this.namedropRe !== null) {
      if (this.namedropRe.some((re) => re.test(metric.name))) {
        return null;
      }
    }

    // 3. tagpass — whitelist by tag key+value
    //    For each configured tag key: the metric must have that tag AND
    //    the tag value must match at least one glob pattern.
    //    If the metric doesn't have the tag key, it's dropped.
    if (this.tagpass !== null) {
      for (const [tagKey, patterns] of Object.entries(this.tagpass)) {
        const tagValue = metric.getTag(tagKey);
        if (tagValue === undefined) return null;
        if (!patterns.some((re) => re.test(tagValue))) return null;
      }
    }

    // 4. tagdrop — blacklist by tag key+value
    //    For each configured tag key: if the metric has that tag AND
    //    the tag value matches any glob pattern, drop the metric.
    if (this.tagdrop !== null) {
      for (const [tagKey, patterns] of Object.entries(this.tagdrop)) {
        const tagValue = metric.getTag(tagKey);
        if (tagValue !== undefined && patterns.some((re) => re.test(tagValue))) {
          return null;
        }
      }
    }

    // 5. fieldpass — keep only matching fields
    if (this.fieldpassRe !== null) {
      for (const fieldKey of metric.fields.keys()) {
        if (!this.fieldpassRe.some((re) => re.test(fieldKey))) {
          metric.removeField(fieldKey);
        }
      }
      if (metric.fields.size === 0) return null;
    }

    // 6. fielddrop — remove matching fields
    if (this.fielddropRe !== null) {
      for (const fieldKey of metric.fields.keys()) {
        if (this.fielddropRe.some((re) => re.test(fieldKey))) {
          metric.removeField(fieldKey);
        }
      }
      if (metric.fields.size === 0) return null;
    }

    return metric;
  }
}
