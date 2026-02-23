// CollatrEdge — Pipeline runtime
// PRD refs: §4 Architecture Overview, §8 Pipeline Lifecycle

import { Channel, Broadcaster } from "../core/channel";
import { ChannelAccumulator, type Accumulator } from "../core/accumulator";
import { createMetric, type FieldValue, type Metric } from "../core/metric";
import { Ticker } from "../core/ticker";
import type { Input, Processor, Aggregator, Output, ServiceInput } from "../core/plugin-types";
import { isServiceInput } from "../core/plugin-types";

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  inputs: { plugin: Input; interval?: number; timeout?: number }[];
  processors: { plugin: Processor }[];
  aggregators: { plugin: Aggregator; period?: number; dropOriginal?: boolean }[];
  outputs: { plugin: Output; metricBatchSize?: number }[];
  gatherIntervalMs: number;
  flushIntervalMs: number;
  gatherTimeoutMs?: number;
  /** Maps to config's round_interval. Controls Ticker aligned mode. */
  roundInterval?: boolean;
  globalTags?: Record<string, string>;
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
    console.error(`[processor] error: ${error.message}`);
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
    console.error(`[aggregator] error: ${error.message}`);
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
): Promise<void> {
  const ticker = new Ticker();
  // aligned maps to config's round_interval (PRD §7, §13)
  for await (const _seq of ticker.tick(intervalMs, { aligned })) {
    if (signal.aborted) break;
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
    } catch (err) {
      console.error(`[pipeline] gather error: ${(err as Error).message}`);
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
  processors: Processor[],
  aggregators: { plugin: Aggregator; dropOriginal: boolean }[],
  outputBroadcaster: Broadcaster<Metric>,
  globalTags?: Record<string, string>,
): Promise<void> {
  // LIMITATION: drop_original is evaluated as a single global flag. If ANY aggregator
  // has dropOriginal=true, ALL originals are suppressed. In Telegraf, drop_original is
  // per-aggregator — originals still flow if at least one aggregator wants them. The
  // correct fix is: only drop if ALL aggregators have dropOriginal=true. This matters
  // when multiple aggregators have mixed settings. Acceptable for Phase 1 where
  // single-aggregator is the expected case; fix in Phase 2 if multi-aggregator
  // scenarios with mixed drop_original settings are needed.
  const shouldDropOriginals =
    aggregators.length > 0 && aggregators.every((a) => a.dropOriginal);

  for await (const metric of inputChannel.receive()) {
    // Run through processor chain sequentially
    let metrics = [metric];
    for (const proc of processors) {
      const next: Metric[] = [];
      for (const m of metrics) {
        const acc = new CollectingAccumulator(globalTags);
        await proc.process(m, acc);
        next.push(...acc.drain());
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

  // Input channel closed — push final aggregator summaries
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
): Promise<void> {
  const batch: Metric[] = [];
  let done = false;

  // Reader: accumulates metrics from channel
  const reader = (async () => {
    for await (const metric of channel.receive()) {
      batch.push(metric);
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
          console.error(`[pipeline] output write error: ${(err as Error).message}`);
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
        console.error(`[pipeline] output write error: ${(err as Error).message}`);
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
        console.error(`[pipeline] final flush error: ${(err as Error).message}`);
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

  constructor(options: PipelineOptions) {
    this.options = options;
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
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // 1. Create output channels and broadcaster (PRD §4: per-output channel)
    const outputBroadcaster = new Broadcaster<Metric>();
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
        this.options.processors.map((p) => p.plugin),
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
    }
    for (const agg of this.options.aggregators) {
      if (agg.plugin.init) await agg.plugin.init();
    }

    const aligned = this.options.roundInterval ?? true;
    const inputAcc = new ChannelAccumulator(
      this.inputChannel,
      globalTags,
    );

    // Separate service inputs from polling inputs
    this.serviceInputs = [];

    for (const input of this.options.inputs) {
      if (input.plugin.init) await input.plugin.init();

      if (isServiceInput(input.plugin)) {
        // ServiceInput: call start(acc) — pushes metrics asynchronously (PRD §8 step 14)
        try {
          await input.plugin.start(inputAcc);
          this.serviceInputs.push({ plugin: input.plugin });
        } catch (err) {
          console.error(`[pipeline] service input start error: ${(err as Error).message}`);
          // Log and continue — one service input failure doesn't stop the pipeline
        }
      } else {
        // Polling Input: create gather loop with Ticker (PRD §8 step 15)
        const interval = input.interval ?? this.options.gatherIntervalMs;
        const timeout = input.timeout ?? this.options.gatherTimeoutMs ?? 0;
        this.loops.push(
          runGatherLoop(input.plugin, inputAcc, interval, timeout, aligned, signal),
        );
      }
    }

    // 7. Start output flush loops (PRD §8 step 16: last — after all inputs are running)
    for (let i = 0; i < this.options.outputs.length; i++) {
      const outputOpts = this.options.outputs[i]!;
      const ch = outputChannels[i]!;
      this.loops.push(
        runOutputFlushLoop(ch, outputOpts.plugin, this.options.flushIntervalMs, signal, outputOpts.metricBatchSize),
      );
    }
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

    // 1. Signal all loops to stop
    this.abortController.abort();

    // 2. Stop service inputs BEFORE closing channels (PRD §8 step 3)
    // This allows service inputs to send any final metrics before the channel closes.
    for (const { plugin } of this.serviceInputs) {
      try {
        await plugin.stop();
      } catch (err) {
        console.error(`[pipeline] service input stop error: ${(err as Error).message}`);
      }
    }

    // 3. Close input channel — cascades shutdown through pipeline
    this.inputChannel?.close();

    // 4. Wait for all loops to complete
    await Promise.allSettled(this.loops);

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
  }
}
