// CollatrEdge — Pipeline runtime
// PRD refs: §4 Architecture Overview, §8 Pipeline Lifecycle

import { Channel, Broadcaster } from "../core/channel";
import { ChannelAccumulator, type Accumulator } from "../core/accumulator";
import { createMetric, type FieldValue, type Metric } from "../core/metric";
import { Ticker } from "../core/ticker";
import type { Input, Processor, Aggregator, Output, ServiceInput } from "../core/plugin-types";
import { isServiceInput } from "../core/plugin-types";
import { getLogger } from "../core/logger";
import { MetricFilter } from "../core/metric-filter";
import type { HubLink } from "../hub/hub-link";
import type { NetworkPolicy } from "../core/network-policy";

// ---------------------------------------------------------------------------
// Pipeline state (used by WebUIAdapter)
// ---------------------------------------------------------------------------

export type PipelineState = "starting" | "running" | "stopping" | "stopped";

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  inputs: { plugin: Input; interval?: number; timeout?: number; filter?: MetricFilter; alias?: string; pluginType?: string; logLevel?: string }[];
  processors: { plugin: Processor; filter?: MetricFilter; alias?: string; logLevel?: string }[];
  aggregators: { plugin: Aggregator; period?: number; dropOriginal?: boolean; alias?: string; logLevel?: string }[];
  outputs: { plugin: Output; metricBatchSize?: number; filter?: MetricFilter; alias?: string; logLevel?: string }[];
  gatherIntervalMs: number;
  flushIntervalMs: number;
  gatherTimeoutMs?: number;
  /** Maps to config's round_interval. Controls Ticker aligned mode. */
  roundInterval?: boolean;
  globalTags?: Record<string, string>;
  /** Hub link instance for Sparkplug B. Created when [agent.hub] enabled. */
  hubLink?: HubLink;
  /** Resolved network policy. Used for startup logging. */
  networkPolicy?: NetworkPolicy;
}

// ---------------------------------------------------------------------------
// Accumulator variants for internal pipeline stages
// ---------------------------------------------------------------------------

/** Collects emitted metrics in-memory (used between processors in the chain). */
class CollectingAccumulator implements Accumulator {
  private metrics: Metric[] = [];
  private _errorCount = 0;
  private globalTags: Record<string, string>;

  constructor(globalTags?: Record<string, string>) {
    this.globalTags = globalTags ?? {};
  }

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    const mergedTags = { ...this.globalTags, ...(tags ?? {}) };
    this.metrics.push(createMetric({ name: measurement, fields, tags: mergedTags, timestamp }));
  }

  addMetric(metric: Metric): void {
    this.metrics.push(metric);
  }

  addError(error: Error): void {
    this._errorCount++;
    getLogger().error("processor error", { component: "processor", error: error.message });
  }

  drain(): Metric[] {
    return this.metrics.splice(0);
  }
}

/** Writes metrics to an output Broadcaster (used for aggregator push). */
class BroadcastAccumulator implements Accumulator {
  private broadcaster: Broadcaster<Metric>;
  private _errorCount = 0;
  private globalTags: Record<string, string>;

  constructor(broadcaster: Broadcaster<Metric>, globalTags?: Record<string, string>) {
    this.broadcaster = broadcaster;
    this.globalTags = globalTags ?? {};
  }

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    const mergedTags = { ...this.globalTags, ...(tags ?? {}) };
    const metric = createMetric({ name: measurement, fields, tags: mergedTags, timestamp });
    this.broadcaster.broadcast(metric, (m) => m.copy());
  }

  addMetric(metric: Metric): void {
    this.broadcaster.broadcast(metric, (m) => m.copy());
  }

  addError(error: Error): void {
    this._errorCount++;
    getLogger().error("aggregator error", { component: "aggregator", error: error.message });
  }
}

// ---------------------------------------------------------------------------
// FilteringAccumulator — wraps another Accumulator and applies MetricFilter
// Used for per-input filters: metrics are filtered before entering the pipeline.
// ---------------------------------------------------------------------------

class FilteringAccumulator implements Accumulator {
  private inner: Accumulator;
  private filter: MetricFilter;
  private globalTags: Record<string, string>;

  constructor(inner: Accumulator, filter: MetricFilter, globalTags?: Record<string, string>) {
    this.inner = inner;
    this.filter = filter;
    this.globalTags = globalTags ?? {};
  }

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    // Create metric to apply filter (need name/tags/fields for filter evaluation)
    const mergedTags = { ...this.globalTags, ...(tags ?? {}) };
    const metric = createMetric({ name: measurement, fields, tags: mergedTags, timestamp });
    const result = this.filter.apply(metric);
    if (result) this.inner.addMetric(result);
  }

  addMetric(metric: Metric): void {
    const result = this.filter.apply(metric);
    if (result) this.inner.addMetric(result);
  }

  addError(error: Error): void {
    this.inner.addError(error);
  }
}

// ---------------------------------------------------------------------------
// Pipeline loop functions
// ---------------------------------------------------------------------------

async function runGatherLoop(
  input: Input,
  acc: Accumulator,
  intervalMs: number,
  timeoutMs: number,
  aligned: boolean,
  signal: AbortSignal,
  alias?: string,
  pluginType?: string,
): Promise<void> {
  const ticker = new Ticker();
  const logCtx = { component: "pipeline", plugin: alias ?? "input", plugin_type: pluginType };
  // aligned maps to config's round_interval (PRD §7, §13)
  for await (const _seq of ticker.tick(intervalMs, { aligned })) {
    if (signal.aborted) break;
    const start = performance.now();
    try {
      // TODO: Phase 2 — pass AbortSignal into gather() so timed-out calls can
      // cooperatively cancel. Currently a slow gather() continues in the background
      // after timeout, which could accumulate orphan executions on resource-constrained
      // devices. Requires extending Input interface to accept an optional signal.
      if (timeoutMs > 0) {
        await Promise.race([
          input.gather(acc),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Gather timeout")), timeoutMs),
          ),
        ]);
      } else {
        await input.gather(acc);
      }
      const elapsed = Math.round(performance.now() - start);
      getLogger().debug("gather complete", { ...logCtx, duration_ms: elapsed });
    } catch (err) {
      getLogger().error("gather error", { ...logCtx, error: (err as Error).message });
    }
  }
}

/**
 * Main processing loop: reads from input channel, runs processor chain,
 * handles aggregator fork, and broadcasts to outputs.
 *
 * When the input channel closes, this loop drains remaining items,
 * pushes final aggregator summaries, and closes all output channels.
 */
async function runMainLoop(
  inputChannel: Channel<Metric>,
  processors: { plugin: Processor; filter?: MetricFilter }[],
  aggregators: { plugin: Aggregator; dropOriginal: boolean }[],
  outputBroadcaster: Broadcaster<Metric>,
  globalTags?: Record<string, string>,
): Promise<void> {
  // drop_original semantics (PRD §6): configured per-aggregator but evaluated
  // globally. Originals are only suppressed when EVERY aggregator has
  // dropOriginal=true. This is a deliberate design decision: all aggregators
  // share one output broadcaster, so the runtime cannot selectively forward
  // originals to some outputs while suppressing them for others. The .every()
  // resolution preserves data when aggregators disagree — the safe default.
  // Per-instance dropOriginal values are wired through PipelineOptions for
  // future per-aggregator output routing if needed.
  const shouldDropOriginals =
    aggregators.length > 0 && aggregators.every((a) => a.dropOriginal);

  for await (const metric of inputChannel.receive()) {
    // Run through processor chain sequentially
    let metrics = [metric];
    for (const { plugin: proc, filter } of processors) {
      const next: Metric[] = [];
      for (const m of metrics) {
        // If processor has a filter and metric doesn't match, pass through unmodified.
        // Note: filter.apply() runs on a copy — the original metric (with all fields
        // intact) is passed to the processor. fieldpass/fielddrop on processor filters
        // only determine pass/drop at the metric level, not actual field removal.
        if (filter) {
          const filtered = filter.apply(m.copy());
          if (filtered === null) {
            next.push(m);
            continue;
          }
        }
        const acc = new CollectingAccumulator(globalTags);
        try {
          await proc.process(m, acc);
          next.push(...acc.drain());
        } catch (err) {
          // PRD §14: processor error → metric dropped, pipeline continues
          getLogger().error("processor error", { component: "pipeline", error: (err as Error).message });
        }
      }
      metrics = next;
    }

    // For each processed metric: fork to aggregators + forward to outputs
    for (const processed of metrics) {
      for (const { plugin } of aggregators) {
        plugin.add(processed.copy());
      }

      if (!shouldDropOriginals) {
        await outputBroadcaster.broadcast(processed, (m) => m.copy());
      }
    }
  }

  // Input channel closed — push final aggregator summaries.
  // Note: the timer-driven push loop may have fired just before shutdown,
  // calling push()+reset(). Any metrics added after that reset() are captured
  // by this final push. In rare cases this may produce a partial overlap with
  // the last timer push — acceptable for monitoring/IIoT data where minor
  // duplication during shutdown is preferable to data loss.
  const pushAcc = new BroadcastAccumulator(outputBroadcaster, globalTags);
  for (const { plugin } of aggregators) {
    plugin.push(pushAcc);
  }

  // Close all output channels (signals output flush loops to drain and finish)
  outputBroadcaster.closeAll();
}

async function runAggregatorPushLoop(
  aggregator: Aggregator,
  pushAcc: Accumulator,
  periodMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await Promise.race([
      Bun.sleep(periodMs),
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    if (signal.aborted) break;
    aggregator.push(pushAcc);
    aggregator.reset();
  }
}

/**
 * Output flush loop: reads metrics from channel and periodically writes
 * batches to the output plugin.
 *
 * Uses two concurrent tasks:
 * - Reader: continuously reads from channel into a batch buffer
 * - Flusher: periodically drains the buffer and calls output.write()
 *
 * When the channel closes, the reader finishes, and the flusher does
 * one final flush of remaining items.
 *
 * If metricBatchSize is set, large batches are split into chunks before
 * calling output.write() to respect payload limits.
 */
async function runOutputFlushLoop(
  channel: Channel<Metric>,
  output: Output,
  flushIntervalMs: number,
  _signal: AbortSignal,
  metricBatchSize?: number,
  filter?: MetricFilter,
  alias?: string,
): Promise<void> {
  const batch: Metric[] = [];
  let done = false;
  const logCtx = { component: "pipeline", plugin: alias ?? "output" };

  // Reader: accumulates metrics from channel, applying per-output filter
  const reader = (async () => {
    for await (const metric of channel.receive()) {
      if (filter) {
        const result = filter.apply(metric);
        if (result) batch.push(result);
      } else {
        batch.push(metric);
      }
    }
    done = true;
  })();

  /**
   * Write a batch to the output, splitting into chunks if metricBatchSize is set.
   * Returns true if all chunks were written successfully, false if any failed.
   */
  async function writeBatch(metrics: Metric[]): Promise<boolean> {
    if (metrics.length === 0) return true;

    if (metricBatchSize && metricBatchSize > 0) {
      // Split into chunks respecting metricBatchSize
      for (let i = 0; i < metrics.length; i += metricBatchSize) {
        const chunk = metrics.slice(i, i + metricBatchSize);
        try {
          await output.write(chunk);
        } catch (err) {
          getLogger().error("output write error", { ...logCtx, error: (err as Error).message });
          // Re-add remaining (unwritten) metrics to batch for retry
          const remaining = metrics.slice(i);
          batch.unshift(...remaining);
          return false;
        }
      }
      return true;
    } else {
      try {
        await output.write(metrics);
        return true;
      } catch (err) {
        getLogger().error("output write error", { ...logCtx, error: (err as Error).message });
        batch.unshift(...metrics);
        return false;
      }
    }
  }

  // Flusher: periodically writes batch to output
  const flusher = (async () => {
    while (!done) {
      await Bun.sleep(flushIntervalMs);
      if (batch.length > 0) {
        const chunk = batch.splice(0);
        await writeBatch(chunk);
      }
    }
    // Final flush after reader finishes
    if (batch.length > 0) {
      const chunk = batch.splice(0);
      try {
        if (metricBatchSize && metricBatchSize > 0) {
          for (let i = 0; i < chunk.length; i += metricBatchSize) {
            await output.write(chunk.slice(i, i + metricBatchSize));
          }
        } else {
          await output.write(chunk);
        }
      } catch (err) {
        // TODO: Phase 7 — when S&F buffer is integrated, failed final-flush
        // metrics should be persisted to the buffer for recovery on next startup.
        // Currently these metrics are lost if the output is still failing at shutdown.
        getLogger().error("final flush error", { ...logCtx, error: (err as Error).message });
      }
    }
  })();

  await Promise.all([reader, flusher]);
}

// ---------------------------------------------------------------------------
// PipelineRuntime — orchestrates the full data pipeline
// ---------------------------------------------------------------------------

export class PipelineRuntime {
  private options: PipelineOptions;
  private abortController: AbortController | null = null;
  private loops: Promise<void>[] = [];
  private inputChannel: Channel<Metric> | null = null;
  private serviceInputs: { plugin: ServiceInput }[] = [];

  // Pipeline state tracking (Phase 9: Web UI adapter)
  private _state: PipelineState = "stopped";
  private _startedAt: number | null = null;
  private _metricSink: ((metric: Metric) => void) | null = null;

  constructor(options: PipelineOptions) {
    this.options = options;
  }

  /** Current pipeline lifecycle state. */
  get state(): PipelineState {
    return this._state;
  }

  /** Epoch milliseconds when start() was called, or null if never started. */
  get startedAt(): number | null {
    return this._startedAt;
  }

  /** Read-only access to pipeline options (used by WebUIAdapter for plugin metadata). */
  get pipelineOptions(): PipelineOptions {
    return this.options;
  }

  /**
   * Register a callback that receives every metric flowing to outputs.
   * Used by WebUIAdapter to track latest metric values for the dashboard.
   * The callback must not mutate the metric.
   */
  registerMetricSink(callback: (metric: Metric) => void): void {
    this._metricSink = callback;
  }

  /**
   * Build and start the pipeline. Follows PRD §8 startup sequence.
   *
   * Pipeline is built backwards: outputs → aggregators → processors → inputs.
   *
   * Startup ordering (PRD §8):
   * - Connect outputs
   * - Start service inputs (ServiceInput.start())
   * - Begin gather loops for polling inputs (Ticker)
   */
  async start(): Promise<void> {
    this._state = "starting";
    this._startedAt = Date.now();

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // 0. Log network policy (PRD §10: visible at startup)
    if (this.options.networkPolicy) {
      getLogger().info("network policy", {
        mode: this.options.networkPolicy.mode,
        summary: this.options.networkPolicy.summary(),
      });
    }

    // 1. Create output channels and broadcaster (PRD §4: per-output channel)
    const outputBroadcaster = new Broadcaster<Metric>();
    // Wire metric sink observer for Web UI live metrics (Phase 9)
    if (this._metricSink) {
      outputBroadcaster.setObserver(this._metricSink);
    }
    const outputChannels: Channel<Metric>[] = [];
    for (const _output of this.options.outputs) {
      const ch = new Channel<Metric>({ capacity: 10_000 });
      outputBroadcaster.addConsumer(ch);
      outputChannels.push(ch);
    }

    // 2. Connect outputs (PRD §8 step 11: connect before flush loops start)
    for (const { plugin } of this.options.outputs) {
      await plugin.connect();
    }

    // 2b. Start hub link (after outputs connect, before inputs start — PRD §8/§9)
    if (this.options.hubLink) {
      // Register devices from input aliases
      for (const input of this.options.inputs) {
        if (input.alias) {
          this.options.hubLink.registerDevice({
            deviceId: input.alias,
            pluginType: input.pluginType ?? "input",
            pluginAlias: input.alias,
            initialMetrics: [],
          });
        }
      }
      await this.options.hubLink.start();
    }

    // 3. Start aggregator push loops (timer-driven — PRD §8 step 13)
    const globalTags = this.options.globalTags;
    for (const agg of this.options.aggregators) {
      const period = agg.period ?? this.options.gatherIntervalMs;
      const pushAcc = new BroadcastAccumulator(outputBroadcaster, globalTags);
      this.loops.push(
        runAggregatorPushLoop(agg.plugin, pushAcc, period, signal),
      );
    }

    // 4. Create input channel (PRD §4: fan-in from all inputs)
    this.inputChannel = new Channel<Metric>({ capacity: 10_000 });

    // 5. Start main processing loop (processor chain + aggregator fork — PRD §8 step 12)
    this.loops.push(
      runMainLoop(
        this.inputChannel,
        this.options.processors.map((p) => ({ plugin: p.plugin, filter: p.filter })),
        this.options.aggregators.map((a) => ({
          plugin: a.plugin,
          dropOriginal: a.dropOriginal ?? false,
        })),
        outputBroadcaster,
        globalTags,
      ),
    );

    // 6. Init plugins and start inputs
    for (const proc of this.options.processors) {
      if (proc.plugin.init) await proc.plugin.init();
      getLogger().debug("plugin registered", { component: "pipeline", plugin: proc.alias ?? "processor", plugin_type: "processor" });
    }
    for (const agg of this.options.aggregators) {
      if (agg.plugin.init) await agg.plugin.init();
      getLogger().debug("plugin registered", { component: "pipeline", plugin: agg.alias ?? "aggregator", plugin_type: "aggregator" });
    }

    const aligned = this.options.roundInterval ?? true;

    // Separate service inputs from polling inputs
    this.serviceInputs = [];

    for (const input of this.options.inputs) {
      if (input.plugin.init) await input.plugin.init();
      getLogger().debug("plugin registered", { component: "pipeline", plugin: input.alias ?? "input", plugin_type: input.pluginType ?? "input" });

      // Per-input accumulator with optional _device_id for Sparkplug B routing
      const baseInputAcc = new ChannelAccumulator(
        this.inputChannel,
        globalTags,
        input.alias, // If set, injects _device_id tag on all metrics from this input
      );

      // Per-input MetricFilter: wrap the accumulator so only matching metrics
      // enter the pipeline (PRD §7: filtering on every plugin)
      const inputAcc: Accumulator = input.filter
        ? new FilteringAccumulator(baseInputAcc, input.filter, globalTags)
        : baseInputAcc;

      if (isServiceInput(input.plugin)) {
        // ServiceInput: call start(acc) — pushes metrics asynchronously (PRD §8 step 14)
        try {
          await input.plugin.start(inputAcc);
          this.serviceInputs.push({ plugin: input.plugin });
        } catch (err) {
          getLogger().error("service input start error", { component: "pipeline", plugin: input.alias ?? "input", plugin_type: input.pluginType, error: (err as Error).message });
          // Log and continue — one service input failure doesn't stop the pipeline
        }
      } else {
        // Polling Input: create gather loop with Ticker (PRD §8 step 15)
        const interval = input.interval ?? this.options.gatherIntervalMs;
        const timeout = input.timeout ?? this.options.gatherTimeoutMs ?? 0;
        this.loops.push(
          runGatherLoop(input.plugin, inputAcc, interval, timeout, aligned, signal, input.alias, input.pluginType),
        );
      }
    }

    // 7. Start output flush loops (PRD §8 step 16: last — after all inputs are running)
    for (let i = 0; i < this.options.outputs.length; i++) {
      const outputOpts = this.options.outputs[i]!;
      const ch = outputChannels[i]!;
      getLogger().debug("plugin registered", { component: "pipeline", plugin: outputOpts.alias ?? "output", plugin_type: "output" });
      this.loops.push(
        runOutputFlushLoop(ch, outputOpts.plugin, this.options.flushIntervalMs, signal, outputOpts.metricBatchSize, outputOpts.filter, outputOpts.alias),
      );
    }

    this._state = "running";
  }

  /**
   * Graceful shutdown (PRD §8 shutdown sequence).
   *
   * 1. Signal all timer loops to stop (abort)
   * 2. Stop service inputs (stop()) — before channel close so final metrics can be sent
   * 3. Close input channel (cascades: main loop drains → closes output channels)
   * 4. Wait for all loops to complete
   * 5. Call close() on all plugins
   */
  async stop(): Promise<void> {
    if (!this.abortController) return;
    this._state = "stopping";

    // 1. Signal all loops to stop
    this.abortController.abort();

    // 2. Stop service inputs BEFORE closing channels (PRD §8 step 3)
    // This allows service inputs to send any final metrics before the channel closes.
    for (const { plugin } of this.serviceInputs) {
      try {
        await plugin.stop();
      } catch (err) {
        getLogger().error("service input stop error", { component: "pipeline", error: (err as Error).message });
      }
    }

    // 3. Close input channel — cascades shutdown through pipeline
    this.inputChannel?.close();

    // 4. Wait for all loops to complete
    await Promise.allSettled(this.loops);

    // 4b. Stop hub link (after pipeline drains, before plugin close)
    if (this.options.hubLink) {
      try {
        await this.options.hubLink.stop();
      } catch (err) {
        getLogger().error("hub link stop error", { component: "pipeline", error: (err as Error).message });
      }
    }

    // 5. Close all plugins
    for (const { plugin } of this.options.inputs) {
      if (plugin.close) await plugin.close();
    }
    for (const { plugin } of this.options.processors) {
      if (plugin.close) await plugin.close();
    }
    for (const { plugin } of this.options.aggregators) {
      if (plugin.close) await plugin.close();
    }
    for (const { plugin } of this.options.outputs) {
      await plugin.close();
    }

    this.loops = [];
    this.serviceInputs = [];
    this.abortController = null;
    this._state = "stopped";
  }
}
