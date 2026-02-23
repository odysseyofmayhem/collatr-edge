// CollatrEdge — Pipeline runtime
// PRD refs: §4 Architecture Overview, §8 Pipeline Lifecycle

import { Channel, Broadcaster } from "../core/channel";
import { ChannelAccumulator, type Accumulator } from "../core/accumulator";
import { createMetric, type FieldValue, type Metric } from "../core/metric";
import { Ticker } from "../core/ticker";
import type { Input, Processor, Aggregator, Output } from "../core/plugin-types";

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  inputs: { plugin: Input; interval?: number; timeout?: number }[];
  processors: { plugin: Processor }[];
  aggregators: { plugin: Aggregator; period?: number; dropOriginal?: boolean }[];
  outputs: { plugin: Output }[];
  gatherIntervalMs: number;
  flushIntervalMs: number;
  gatherTimeoutMs?: number;
  globalTags?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Accumulator variants for internal pipeline stages
// ---------------------------------------------------------------------------

/** Collects emitted metrics in-memory (used between processors in the chain). */
class CollectingAccumulator implements Accumulator {
  private metrics: Metric[] = [];
  private _errorCount = 0;

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    this.metrics.push(createMetric({ name: measurement, fields, tags, timestamp }));
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

  constructor(broadcaster: Broadcaster<Metric>) {
    this.broadcaster = broadcaster;
  }

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    const metric = createMetric({ name: measurement, fields, tags, timestamp });
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
  signal: AbortSignal,
): Promise<void> {
  const ticker = new Ticker();
  for await (const _seq of ticker.tick(intervalMs, { aligned: false })) {
    if (signal.aborted) break;
    try {
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
): Promise<void> {
  const shouldDropOriginals =
    aggregators.length > 0 && aggregators.some((a) => a.dropOriginal);

  for await (const metric of inputChannel.receive()) {
    // Run through processor chain sequentially
    let metrics = [metric];
    for (const proc of processors) {
      const next: Metric[] = [];
      for (const m of metrics) {
        const acc = new CollectingAccumulator();
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
  const pushAcc = new BroadcastAccumulator(outputBroadcaster);
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
 */
async function runOutputFlushLoop(
  channel: Channel<Metric>,
  output: Output,
  flushIntervalMs: number,
  _signal: AbortSignal,
): Promise<void> {
  await output.connect();

  const batch: Metric[] = [];
  let done = false;

  // Reader: accumulates metrics from channel
  const reader = (async () => {
    for await (const metric of channel.receive()) {
      batch.push(metric);
    }
    done = true;
  })();

  // Flusher: periodically writes batch to output
  const flusher = (async () => {
    while (!done) {
      await Bun.sleep(flushIntervalMs);
      if (batch.length > 0) {
        await output.write(batch.splice(0));
      }
    }
    // Final flush after reader finishes
    if (batch.length > 0) {
      await output.write(batch.splice(0));
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

  constructor(options: PipelineOptions) {
    this.options = options;
  }

  /**
   * Build and start the pipeline. Follows PRD §8 startup sequence
   * (simplified for Phase 1: no SQLite, no Hub, no Web UI).
   *
   * Pipeline is built backwards: outputs → aggregators → processors → inputs.
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

    // 2. Start output flush loops
    for (let i = 0; i < this.options.outputs.length; i++) {
      const { plugin } = this.options.outputs[i]!;
      const ch = outputChannels[i]!;
      this.loops.push(
        runOutputFlushLoop(ch, plugin, this.options.flushIntervalMs, signal),
      );
    }

    // 3. Start aggregator push loops (timer-driven)
    for (const agg of this.options.aggregators) {
      const period = agg.period ?? this.options.gatherIntervalMs;
      const pushAcc = new BroadcastAccumulator(outputBroadcaster);
      this.loops.push(
        runAggregatorPushLoop(agg.plugin, pushAcc, period, signal),
      );
    }

    // 4. Create input channel (PRD §4: fan-in from all inputs)
    this.inputChannel = new Channel<Metric>({ capacity: 10_000 });

    // 5. Start main processing loop (processor chain + aggregator fork)
    this.loops.push(
      runMainLoop(
        this.inputChannel,
        this.options.processors.map((p) => p.plugin),
        this.options.aggregators.map((a) => ({
          plugin: a.plugin,
          dropOriginal: a.dropOriginal ?? false,
        })),
        outputBroadcaster,
      ),
    );

    // 6. Init plugins and start input gather loops
    for (const proc of this.options.processors) {
      if (proc.plugin.init) await proc.plugin.init();
    }
    for (const agg of this.options.aggregators) {
      if (agg.plugin.init) await agg.plugin.init();
    }

    const inputAcc = new ChannelAccumulator(
      this.inputChannel,
      this.options.globalTags,
    );
    for (const input of this.options.inputs) {
      if (input.plugin.init) await input.plugin.init();
      const interval = input.interval ?? this.options.gatherIntervalMs;
      const timeout = input.timeout ?? this.options.gatherTimeoutMs ?? 0;
      this.loops.push(
        runGatherLoop(input.plugin, inputAcc, interval, timeout, signal),
      );
    }
  }

  /**
   * Graceful shutdown (PRD §8 shutdown sequence).
   *
   * 1. Signal all timer loops to stop (abort)
   * 2. Close input channel (cascades: main loop drains → closes output channels)
   * 3. Wait for all loops to complete
   * 4. Call close() on all plugins
   */
  async stop(): Promise<void> {
    if (!this.abortController) return;

    // Signal all loops to stop
    this.abortController.abort();

    // Close input channel — cascades shutdown through pipeline
    this.inputChannel?.close();

    // Wait for all loops to complete
    await Promise.allSettled(this.loops);

    // Close all plugins
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
    this.abortController = null;
  }
}
