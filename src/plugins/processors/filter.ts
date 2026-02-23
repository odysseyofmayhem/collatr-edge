// CollatrEdge — Filter processor plugin
// PRD refs: §6 Plugin System (Processor contract), §7 Configuration (Filtering), §19 MVP Plugin Inventory
//
// Drops or passes metrics based on name, tag, and field criteria.
// Wraps MetricFilter (from core) as a processor pipeline stage.
// Processor contract: emit matching metrics via acc.addMetric(), drop non-matching (emit nothing).
//
// Per-plugin filtering (namepass/namedrop etc. on other plugin types) is handled at
// the runtime config layer. This processor IS the standalone filter — its config
// schema is the MetricFilterSchema itself.

import { z } from "zod/v4";
import { MetricFilter, MetricFilterSchema } from "@core/metric-filter";
import type { Processor } from "@core/plugin-types";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema — same fields as MetricFilterSchema
// ---------------------------------------------------------------------------

export const FilterConfigSchema = MetricFilterSchema;

export type FilterConfig = z.infer<typeof FilterConfigSchema>;

// ---------------------------------------------------------------------------
// Filter processor
// ---------------------------------------------------------------------------

export class FilterProcessor implements Processor {
  private filter: MetricFilter;

  constructor(config: FilterConfig) {
    this.filter = new MetricFilter(config);
  }

  async process(metric: Metric, acc: Accumulator): Promise<void> {
    const result = this.filter.apply(metric);
    if (result !== null) {
      acc.addMetric(result);
    }
    // If null, metric is dropped — processor emits nothing (PRD §6: no auto-forward)
  }
}

export function createFilterProcessor(config: FilterConfig): FilterProcessor {
  return new FilterProcessor(config);
}
