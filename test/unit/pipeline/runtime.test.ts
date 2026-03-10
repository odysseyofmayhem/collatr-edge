import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type {
  Input,
  Processor,
  Aggregator,
  Output,
} from "@core/plugin-types";
import { SimpleStatsCollector } from "@core/stats";

// ---------------------------------------------------------------------------
// Mock plugins
// ---------------------------------------------------------------------------

class MockInput implements Input {
  private metricsToEmit: { name: string; fields: Record<string, number> }[];
  gatherCount = 0;
  closed = false;

  constructor(
    metrics: { name: string; fields: Record<string, number> }[] = [
      { name: "cpu", fields: { usage: 42 } },
    ],
  ) {
    this.metricsToEmit = metrics;
  }

  async gather(acc: Accumulator): Promise<void> {
    for (const m of this.metricsToEmit) {
      acc.addFields(m.name, m.fields);
    }
    this.gatherCount++;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockSlowInput implements Input {
  closed = false;

  async gather(_acc: Accumulator): Promise<void> {
    await Bun.sleep(5_000);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockProcessor implements Processor {
  private transformFn: (metric: Metric, acc: Accumulator) => void;
  closed = false;

  constructor(transformFn: (metric: Metric, acc: Accumulator) => void) {
    this.transformFn = transformFn;
  }

  async process(metric: Metric, acc: Accumulator): Promise<void> {
    this.transformFn(metric, acc);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockAggregator implements Aggregator {
  added: Metric[] = [];
  pushCount = 0;
  resetCount = 0;
  closed = false;

  add(metric: Metric): void {
    this.added.push(metric);
  }

  push(acc: Accumulator): void {
    acc.addFields("summary", { count: this.added.length });
    this.pushCount++;
  }

  reset(): void {
    this.added = [];
    this.resetCount++;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async write(batch: Metric[]): Promise<void> {
    this.written.push(...batch);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Helper: run pipeline for a short duration then stop
// ---------------------------------------------------------------------------

async function runFor(
  pipeline: PipelineRuntime,
  durationMs: number,
): Promise<void> {
  await pipeline.start();
  await Bun.sleep(durationMs);
  await pipeline.stop();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PipelineRuntime", () => {
  it("mock input → mock output: metrics flow correctly", async () => {
    const input = new MockInput([{ name: "temperature", fields: { celsius: 23.5 } }]);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(1);
    expect(output.written[0]!.name).toBe("temperature");
    expect(output.written[0]!.getField("celsius")).toBe(23.5);
  });

  it("2 processors in chain: output sees both transformations applied", async () => {
    const input = new MockInput([{ name: "raw", fields: { value: 10 } }]);

    // Processor 1: doubles the value
    const proc1 = new MockProcessor((metric, acc) => {
      const val = metric.getField("value") as number;
      metric.addField("value", val * 2);
      acc.addMetric(metric);
    });

    // Processor 2: adds a label field
    const proc2 = new MockProcessor((metric, acc) => {
      metric.addField("label", "processed");
      acc.addMetric(metric);
    });

    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: proc1 }, { plugin: proc2 }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;
    expect(m.getField("value")).toBe(20); // doubled by proc1
    expect(m.getField("label")).toBe("processed"); // added by proc2
  });

  it("aggregator: originals pass through AND aggregator receives copies", async () => {
    const input = new MockInput([{ name: "temp", fields: { c: 25 } }]);
    const aggregator = new MockAggregator();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: aggregator, dropOriginal: false, period: 10_000 }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // Aggregator received copies
    expect(aggregator.added.length).toBeGreaterThanOrEqual(1);
    expect(aggregator.added[0]!.name).toBe("temp");

    // Output received originals (not just summaries)
    const originals = output.written.filter((m) => m.name === "temp");
    expect(originals.length).toBeGreaterThanOrEqual(1);
  });

  it("drop_original=true: originals do NOT reach output", async () => {
    const input = new MockInput([{ name: "temp", fields: { c: 25 } }]);
    const aggregator = new MockAggregator();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: aggregator, dropOriginal: true, period: 5000 }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // Aggregator received copies
    expect(aggregator.added.length).toBeGreaterThanOrEqual(1);

    // Output should NOT have originals — only final push summary
    const originals = output.written.filter((m) => m.name === "temp");
    expect(originals.length).toBe(0);

    // Output may have summary from final aggregator push on shutdown
    const summaries = output.written.filter((m) => m.name === "summary");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });

  it("gather timeout: slow input with timeout → error logged, no crash", async () => {
    const slowInput = new MockSlowInput();
    const output = new MockOutput();

    // Capture logger output (writes to process.stderr)
    const errorCalls: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      errorCalls.push(str.trimEnd());
      return true;
    }) as typeof process.stderr.write;

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: slowInput, timeout: 100 }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 200,
      flushIntervalMs: 50,
      gatherTimeoutMs: 100,
    });

    await runFor(pipeline, 500);

    process.stderr.write = originalWrite;

    // Should have logged timeout errors
    const timeoutErrors = errorCalls.filter((msg) =>
      msg.includes("Gather timeout"),
    );
    expect(timeoutErrors.length).toBeGreaterThanOrEqual(1);

    // Pipeline should not crash — output was properly closed
    expect(output.closed).toBe(true);
  });

  it("graceful shutdown: all close() methods called, pipeline drains", async () => {
    const input = new MockInput();
    const proc = new MockProcessor((metric, acc) => {
      acc.addMetric(metric);
    });
    const aggregator = new MockAggregator();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: proc }],
      aggregators: [{ plugin: aggregator, dropOriginal: false, period: 10_000 }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 200);

    // All plugins had close() called
    expect(input.closed).toBe(true);
    expect(proc.closed).toBe(true);
    expect(aggregator.closed).toBe(true);
    expect(output.closed).toBe(true);

    // Output was connected and received some metrics
    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(1);
  });

  it("2 mock inputs fan-in to 1 channel → output sees metrics from both", async () => {
    const input1 = new MockInput([{ name: "sensor_a", fields: { value: 1 } }]);
    const input2 = new MockInput([{ name: "sensor_b", fields: { value: 2 } }]);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input1 }, { plugin: input2 }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    const namesReceived = new Set(output.written.map((m) => m.name));
    expect(namesReceived.has("sensor_a")).toBe(true);
    expect(namesReceived.has("sensor_b")).toBe(true);
  });

  it("broadcaster: 2 mock outputs each receive all metrics independently", async () => {
    const input = new MockInput([{ name: "data", fields: { val: 99 } }]);
    const output1 = new MockOutput();
    const output2 = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output1 }, { plugin: output2 }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // Both outputs connected and received metrics
    expect(output1.connected).toBe(true);
    expect(output2.connected).toBe(true);
    expect(output1.written.length).toBeGreaterThanOrEqual(1);
    expect(output2.written.length).toBeGreaterThanOrEqual(1);

    // Both received the same metric name
    expect(output1.written[0]!.name).toBe("data");
    expect(output2.written[0]!.name).toBe("data");

    // Copies are independent (different object references)
    if (output1.written.length > 0 && output2.written.length > 0) {
      expect(output1.written[0]).not.toBe(output2.written[0]);
    }
  });

  it("processor that emits nothing: metric is dropped from output", async () => {
    const input = new MockInput([{ name: "noisy", fields: { value: 1 } }]);

    // Filter processor: drops everything (emits nothing via accumulator)
    const filterProc = new MockProcessor((_metric, _acc) => {
      // Intentionally emit nothing — metric is dropped
    });

    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: filterProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // Input gathered metrics, but processor dropped them all
    expect(input.gatherCount).toBeGreaterThanOrEqual(1);
    expect(output.written.length).toBe(0);
  });

  it("processor that splits: one metric in → multiple metrics out", async () => {
    const input = new MockInput([{ name: "combined", fields: { a: 1, b: 2 } }]);

    // Split processor: emits two metrics from one input
    const splitProc = new MockProcessor((metric, acc) => {
      const valA = metric.getField("a") as number;
      const valB = metric.getField("b") as number;
      acc.addFields("split_a", { value: valA });
      acc.addFields("split_b", { value: valB });
    });

    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: splitProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // Each gather produces 2 output metrics
    const splitAs = output.written.filter((m) => m.name === "split_a");
    const splitBs = output.written.filter((m) => m.name === "split_b");
    expect(splitAs.length).toBeGreaterThanOrEqual(1);
    expect(splitBs.length).toBeGreaterThanOrEqual(1);
    expect(splitAs.length).toBe(splitBs.length);
    expect(splitAs[0]!.getField("value")).toBe(1);
    expect(splitBs[0]!.getField("value")).toBe(2);
  });

  it("aggregator periodic push fires during operation", async () => {
    const input = new MockInput([{ name: "data", fields: { v: 1 } }]);
    const aggregator = new MockAggregator();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: aggregator, dropOriginal: true, period: 100 }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 500);

    // Periodic push should have fired at least once during operation (500ms / 100ms period)
    // Plus the final push on shutdown = at least 2 pushes total
    expect(aggregator.pushCount).toBeGreaterThanOrEqual(2);
    expect(aggregator.resetCount).toBeGreaterThanOrEqual(1);

    // Output should have summary metrics from periodic pushes
    const summaries = output.written.filter((m) => m.name === "summary");
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it("output.connect() failure during startup prevents pipeline from starting", async () => {
    const input = new MockInput();
    const failOutput: Output = {
      async connect() { throw new Error("connection refused"); },
      async write() {},
      async close() {},
    };

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: failOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    // start() should throw because connect() fails (fail-fast per PRD §8)
    try {
      await pipeline.start();
      expect(true).toBe(false); // should not reach here
    } catch (err: unknown) {
      expect((err as Error).message).toBe("connection refused");
    }
  });

  it("output.write() error: logged and metrics retried on next flush", async () => {
    const input = new MockInput([{ name: "data", fields: { v: 1 } }]);
    let writeCallCount = 0;

    const flakyOutput: Output = {
      async connect() {},
      async write(batch: Metric[]) {
        writeCallCount++;
        if (writeCallCount === 1) {
          throw new Error("network timeout");
        }
        // Subsequent writes succeed — accept the retried metrics
      },
      async close() {},
    };

    // Capture logger output (writes to process.stderr)
    const errorCalls: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      errorCalls.push(str.trimEnd());
      return true;
    }) as typeof process.stderr.write;

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: flakyOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 400);

    process.stderr.write = originalWrite;

    // Error was logged
    const writeErrors = errorCalls.filter((msg) => msg.includes("output write error"));
    expect(writeErrors.length).toBeGreaterThanOrEqual(1);

    // Pipeline didn't crash — multiple write attempts happened
    expect(writeCallCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Stats collector wiring
  // -------------------------------------------------------------------------

  it("stats.metricsGathered increments as inputs produce metrics", async () => {
    const stats = new SimpleStatsCollector();
    const input = new MockInput([
      { name: "temp", fields: { c: 25 } },
      { name: "pressure", fields: { bar: 1.0 } },
    ]);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      stats,
    });

    await runFor(pipeline, 300);

    // Each gather emits 2 metrics; multiple gathers happen in 300ms
    expect(stats.metricsGathered).toBeGreaterThanOrEqual(2);
  });

  it("stats.metricsWritten increments as outputs write metrics", async () => {
    const stats = new SimpleStatsCollector();
    const input = new MockInput([{ name: "data", fields: { v: 1 } }]);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      stats,
    });

    await runFor(pipeline, 300);

    // Output wrote metrics — stats should reflect count
    expect(stats.metricsWritten).toBeGreaterThanOrEqual(1);
    expect(stats.metricsWritten).toBe(output.written.length);
  });

  it("stats.gatherErrors increments on gather failure", async () => {
    const stats = new SimpleStatsCollector();
    const failInput: Input = {
      async gather(_acc: Accumulator): Promise<void> {
        throw new Error("sensor offline");
      },
      async close(): Promise<void> {},
    };
    const output = new MockOutput();

    // Suppress error logs during this test
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: failInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      stats,
    });

    await runFor(pipeline, 300);
    process.stderr.write = originalWrite;

    expect(stats.gatherErrors).toBeGreaterThanOrEqual(1);
    expect(stats.metricsGathered).toBe(0); // no successful gathers
  });

  it("stats.writeErrors increments on output write failure", async () => {
    const stats = new SimpleStatsCollector();
    const input = new MockInput([{ name: "data", fields: { v: 1 } }]);
    const failOutput: Output = {
      async connect(): Promise<void> {},
      async write(_batch: Metric[]): Promise<void> {
        throw new Error("disk full");
      },
      async close(): Promise<void> {},
    };

    // Suppress error logs during this test
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: failOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      stats,
    });

    await runFor(pipeline, 300);
    process.stderr.write = originalWrite;

    expect(stats.writeErrors).toBeGreaterThanOrEqual(1);
    expect(stats.metricsWritten).toBe(0); // no successful writes
  });

  it("stats.metricsGathered and metricsWritten track correctly with 2 inputs", async () => {
    const stats = new SimpleStatsCollector();
    const input1 = new MockInput([{ name: "sensor_a", fields: { v: 1 } }]);
    const input2 = new MockInput([{ name: "sensor_b", fields: { v: 2 } }]);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input1 }, { plugin: input2 }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      stats,
    });

    await runFor(pipeline, 300);

    // Both inputs contribute to gathered count
    expect(stats.metricsGathered).toBeGreaterThanOrEqual(2);
    // Written should match what the output received
    expect(stats.metricsWritten).toBe(output.written.length);
  });

  it("aggregator summary metrics include global tags", async () => {
    const input = new MockInput([{ name: "temp", fields: { c: 25 } }]);
    const aggregator = new MockAggregator();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: aggregator, dropOriginal: true, period: 10_000 }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      globalTags: { site: "factory_a", line: "3" },
    });

    await runFor(pipeline, 300);

    // Summary from final aggregator push should have global tags (R7 fix)
    const summaries = output.written.filter((m) => m.name === "summary");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0]!.getTag("site")).toBe("factory_a");
    expect(summaries[0]!.getTag("line")).toBe("3");
  });
});
