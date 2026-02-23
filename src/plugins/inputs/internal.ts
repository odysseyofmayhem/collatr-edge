// CollatrEdge — Internal metrics input plugin (polling Input)
// PRD refs: §15 Observability, §19 MVP Plugin Inventory
//
// Built-in input that emits agent.* self-metrics on each gather cycle.
// Reads stats from a StatsCollector interface provided by the pipeline runtime.

import { z } from "zod/v4";
import type { Input } from "../../core/plugin-types";
import type { Accumulator } from "../../core/accumulator";
import type { StatsCollector } from "../../core/stats";
import { hostname } from "os";

// ---------------------------------------------------------------------------
// Zod config schema — matches PRD Appendix A [[inputs.internal]]
// ---------------------------------------------------------------------------

export const InternalConfigSchema = z.object({
  // No special config beyond interval (handled at pipeline level).
  // Config exists for forward compatibility.
  collect_memstats: z.boolean().default(true)
    .describe("Collect process memory statistics"),
});

export type InternalConfig = z.infer<typeof InternalConfigSchema>;

// ---------------------------------------------------------------------------
// Internal metrics input plugin
// ---------------------------------------------------------------------------

export class InternalInput implements Input {
  private config: InternalConfig;
  private stats: StatsCollector;
  private agentHostname: string;

  constructor(config: InternalConfig, stats: StatsCollector) {
    this.config = config;
    this.stats = stats;
    this.agentHostname = hostname();
  }

  async gather(acc: Accumulator): Promise<void> {
    const now = Date.now();
    const tags = { host: this.agentHostname };

    // -----------------------------------------------------------------------
    // Agent-level metrics (PRD §15)
    // -----------------------------------------------------------------------

    // agent.uptime_seconds — seconds since agent start
    const uptimeSeconds = (now - this.stats.startTimeMs) / 1000;
    acc.addFields("agent.uptime_seconds", { value: uptimeSeconds }, tags);

    // agent.metrics_gathered — total metrics collected across all inputs
    acc.addFields("agent.metrics_gathered", { value: this.stats.metricsGathered }, tags);

    // agent.metrics_written — total metrics successfully written
    acc.addFields("agent.metrics_written", { value: this.stats.metricsWritten }, tags);

    // agent.metrics_dropped — total metrics dropped
    acc.addFields("agent.metrics_dropped", { value: this.stats.metricsDropped }, tags);

    // agent.gather_errors — total gather errors
    acc.addFields("agent.gather_errors", { value: this.stats.gatherErrors }, tags);

    // agent.write_errors — total write errors
    acc.addFields("agent.write_errors", { value: this.stats.writeErrors }, tags);

    // -----------------------------------------------------------------------
    // Process metrics
    // -----------------------------------------------------------------------

    if (this.config.collect_memstats) {
      const mem = process.memoryUsage();
      acc.addFields("agent.memory_usage", {
        heap_used: mem.heapUsed,
        heap_total: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      }, tags);
    }

    // -----------------------------------------------------------------------
    // Per-input metrics (PRD §15: tagged per-input)
    // -----------------------------------------------------------------------

    for (const input of this.stats.getInputStats()) {
      acc.addFields("agent.input", {
        gather_time_ms: input.gatherTimeMs,
        metrics_count: input.metricsCount,
      }, { ...tags, input: input.name });
    }

    // -----------------------------------------------------------------------
    // Per-output metrics (PRD §15: tagged per-output)
    // -----------------------------------------------------------------------

    for (const output of this.stats.getOutputStats()) {
      acc.addFields("agent.output", {
        write_time_ms: output.writeTimeMs,
        buffer_size: output.bufferSize,
      }, { ...tags, output: output.name });
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function for config-based instantiation
// ---------------------------------------------------------------------------

export function createInternalInput(
  rawConfig: unknown,
  stats: StatsCollector,
): InternalInput {
  const config = InternalConfigSchema.parse(rawConfig ?? {});
  return new InternalInput(config, stats);
}
