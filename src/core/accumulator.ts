// CollatrEdge — Accumulator
// PRD refs: §6 Plugin System, Appendix B Metric Interface

import { Channel } from "./channel";
import { createMetric, type FieldValue, type Metric } from "./metric";

export interface Accumulator {
  /** Create a new metric from scratch. Timestamp assigned automatically if not provided. */
  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void;

  /** Forward an existing metric (pass-through, modified, or cloned). Used by processors. */
  addMetric(metric: Metric): void;

  /** Report a non-fatal error (logged + counted, doesn't stop the plugin). */
  addError(error: Error): void;
}

export class ChannelAccumulator implements Accumulator {
  private channel: Channel<Metric>;
  private globalTags: Record<string, string>;
  private _errorCount = 0;

  constructor(channel: Channel<Metric>, globalTags?: Record<string, string>) {
    this.channel = channel;
    this.globalTags = globalTags ?? {};
  }

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    // Merge global tags with per-metric tags. Per-metric wins on conflict.
    const mergedTags = { ...this.globalTags, ...(tags ?? {}) };

    const metric = createMetric({
      name: measurement,
      fields,
      tags: mergedTags,
      timestamp,
    });

    // send() is async but addFields is void per PRD interface.
    // With drop-oldest overflow, send() never actually awaits — fire-and-forget is safe.
    this.channel.send(metric);
  }

  addMetric(metric: Metric): void {
    // Send existing metric unmodified
    this.channel.send(metric);
  }

  addError(error: Error): void {
    this._errorCount++;
    // Log but never throw — non-fatal by contract
    console.error(`[accumulator] plugin error: ${error.message}`);
  }

  get errorCount(): number {
    return this._errorCount;
  }
}
