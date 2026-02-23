// CollatrEdge — Rename processor plugin
// PRD refs: §6 Plugin System (Processor contract), §19 MVP Plugin Inventory, Appendix A
//
// Renames fields and/or tags on metrics passing through.
// Processor contract: explicit emit via acc.addMetric(). No auto-forwarding.
//
// Per-plugin filtering (namepass/namedrop/tagpass/tagdrop) is handled at the
// runtime config layer, not embedded in individual processor schemas.

import { z } from "zod/v4";
import type { Processor } from "@core/plugin-types";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const RenameRuleSchema = z.object({
  field: z.string().optional(),
  tag: z.string().optional(),
  dest: z.string(),
}).refine(
  (rule) => rule.field !== undefined || rule.tag !== undefined,
  { message: "Rename rule must specify either 'field' or 'tag'" },
).refine(
  (rule) => !(rule.field !== undefined && rule.tag !== undefined),
  { message: "Rename rule must specify 'field' or 'tag', not both (use two separate rules)" },
);

export const RenameConfigSchema = z.object({
  replace: z.array(RenameRuleSchema).default([]),
});

export type RenameConfig = z.infer<typeof RenameConfigSchema>;

// ---------------------------------------------------------------------------
// Rename processor
// ---------------------------------------------------------------------------

export class RenameProcessor implements Processor {
  private config: RenameConfig;

  constructor(config: RenameConfig) {
    this.config = config;
  }

  async process(metric: Metric, acc: Accumulator): Promise<void> {
    for (const rule of this.config.replace) {
      if (rule.field) {
        const value = metric.getField(rule.field);
        if (value !== undefined) {
          metric.removeField(rule.field);
          metric.addField(rule.dest, value);
        }
      }
      if (rule.tag) {
        const value = metric.getTag(rule.tag);
        if (value !== undefined) {
          metric.removeTag(rule.tag);
          // addTag re-sorts the tags map, updating hashId
          metric.addTag(rule.dest, value);
        }
      }
    }

    // Processor contract: always explicitly emit (even if no rules matched)
    acc.addMetric(metric);
  }
}

export function createRenameProcessor(config: RenameConfig): RenameProcessor {
  return new RenameProcessor(config);
}
