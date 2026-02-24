// CollatrEdge — Accumulator
// PRD refs: §6 Plugin System, Appendix B Metric Interface

import { Channel } from "./channel";
import { createMetric, type FieldValue, type Metric } from "./metric";
import { getLogger } from "./logger";

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
  private _droppedCount = 0;
  private _deviceId: string | undefined;

  constructor(channel: Channel<Metric>, globalTags?: Record<string, string>, deviceId?: string) {
    this.channel = channel;
    this.globalTags = globalTags ?? {};
    this._deviceId = deviceId;
  }

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    // Merge global tags with per-metric tags. Per-metric wins on conflict.
    const mergedTags = { ...this.globalTags, ...(tags ?? {}) };
    // Inject _device_id for Sparkplug B routing (PRD §9)
    if (this._deviceId) {
      mergedTags._device_id = this._deviceId;
    }

    const metric = createMetric({
      name: measurement,
      fields,
      tags: mergedTags,
      timestamp,
    });

    // send() is async but addFields is void per PRD interface.
    // With drop-oldest overflow, send() completes synchronously. If the channel
    // is closed (during shutdown), send() returns false — track as dropped.
    void this.channel.send(metric).then((ok) => {
      if (!ok) this._droppedCount++;
    });
  }

  addMetric(metric: Metric): void {
    void this.channel.send(metric).then((ok) => {
      if (!ok) this._droppedCount++;
    });
  }

  addError(error: Error): void {
    this._errorCount++;
    // Log but never throw — non-fatal by contract
    getLogger().error("plugin error", { component: "accumulator", error: error.message });
  }

  get errorCount(): number {
    return this._errorCount;
  }

  /** Count of metrics dropped due to closed channel (e.g., during shutdown). */
  get droppedCount(): number {
    return this._droppedCount;
  }
}
