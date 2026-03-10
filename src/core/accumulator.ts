// CollatrEdge — Accumulator
// PRD refs: §6 Plugin System, Appendix B Metric Interface

import { Channel } from "./channel";
import { createMetric, type FieldValue, type Metric } from "./metric";
import { getLogger } from "./logger";
import type { SimpleStatsCollector } from "./stats";

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

/**
 * Channel-backed accumulator implementation.
 *
 * When a deviceId is set (from input alias), a `_device_id` tag is injected
 * into every metric. This tag serves dual purpose:
 * 1. Sparkplug B routing: MqttOutput groups metrics by `_device_id` for
 *    per-device DDATA publish.
 * 2. Provenance metadata: local-store, file output, and other consumers
 *    can query/group by originating device.
 *
 * Convention: tags prefixed with `_` are system-injected. Users can strip
 * them via `tagdrop = ["_device_id"]` on outputs where they are unwanted.
 */
export class ChannelAccumulator implements Accumulator {
  private channel: Channel<Metric>;
  private globalTags: Record<string, string>;
  private _errorCount = 0;
  private _droppedCount = 0;
  private _deviceId: string | undefined;
  private _stats: SimpleStatsCollector | undefined;

  constructor(channel: Channel<Metric>, globalTags?: Record<string, string>, deviceId?: string, stats?: SimpleStatsCollector) {
    this.channel = channel;
    this.globalTags = globalTags ?? {};
    this._deviceId = deviceId;
    this._stats = stats;
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
      if (ok) {
        if (this._stats) this._stats.metricsGathered++;
      } else {
        this._droppedCount++;
        if (this._stats) this._stats.metricsDropped++;
      }
    });
  }

  addMetric(metric: Metric): void {
    // Inject _device_id for Sparkplug B routing (PRD §9) — same as addFields().
    // Must copy before mutating: the caller may hold a reference used elsewhere
    // (other processors, aggregators, debug logging). (Independent review F-1)
    let m = metric;
    if (this._deviceId && !metric.hasTag("_device_id")) {
      m = metric.copy();
      m.addTag("_device_id", this._deviceId);
    }
    void this.channel.send(m).then((ok) => {
      if (ok) {
        if (this._stats) this._stats.metricsGathered++;
      } else {
        this._droppedCount++;
        if (this._stats) this._stats.metricsDropped++;
      }
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
