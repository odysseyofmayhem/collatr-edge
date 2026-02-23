import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type {
  Input,
  ServiceInput,
  Output,
} from "@core/plugin-types";
import { isServiceInput } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock plugins
// ---------------------------------------------------------------------------

class MockPollingInput implements Input {
  gatherCount = 0;
  closed = false;

  async gather(acc: Accumulator): Promise<void> {
    acc.addFields("polling_metric", { value: this.gatherCount });
    this.gatherCount++;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Mock ServiceInput that pushes metrics asynchronously at a given interval.
 * Simulates push-based inputs like OPC-UA subscriptions or MQTT consumers.
 */
class MockServiceInput implements ServiceInput {
  private acc: Accumulator | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pushIntervalMs: number;
  pushCount = 0;
  started = false;
  stopped = false;
  closed = false;

  constructor(pushIntervalMs = 30) {
    this.pushIntervalMs = pushIntervalMs;
  }

  async gather(_acc: Accumulator): Promise<void> {
    // ServiceInput has gather() from Input interface but it's not used
    // when the runtime detects ServiceInput via isServiceInput().
  }

  async start(acc: Accumulator): Promise<void> {
    this.acc = acc;
    this.started = true;
    // Push metrics asynchronously on an interval
    this.timer = setInterval(() => {
      if (this.acc) {
        this.acc.addFields("service_metric", { value: this.pushCount });
        this.pushCount++;
      }
    }, this.pushIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A ServiceInput that throws on start() to test error handling. */
class FailingServiceInput implements ServiceInput {
  started = false;
  stopped = false;
  closed = false;

  async gather(_acc: Accumulator): Promise<void> {}

  async start(_acc: Accumulator): Promise<void> {
    this.started = true;
    throw new Error("service input connection refused");
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

/** Output that tracks each write() call separately for batch-size testing. */
class BatchTrackingOutput implements Output {
  writeCalls: Metric[][] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async write(batch: Metric[]): Promise<void> {
    this.writeCalls.push([...batch]);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
// Tests: isServiceInput() type guard
// ---------------------------------------------------------------------------

describe("isServiceInput()", () => {
  it("correctly identifies a ServiceInput (has start and stop methods)", () => {
    const si = new MockServiceInput();
    expect(isServiceInput(si)).toBe(true);
  });

  it("correctly identifies a plain Input (no start/stop)", () => {
    const pi = new MockPollingInput();
    expect(isServiceInput(pi)).toBe(false);
  });

  it("returns false for an object with only start (no stop)", () => {
    const partial = {
      async gather(_acc: Accumulator) {},
      async start(_acc: Accumulator) {},
      // no stop
    } as unknown as Input;
    expect(isServiceInput(partial)).toBe(false);
  });

  it("returns false for an object with only stop (no start)", () => {
    const partial = {
      async gather(_acc: Accumulator) {},
      async stop() {},
      // no start
    } as unknown as Input;
    expect(isServiceInput(partial)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: ServiceInput lifecycle in PipelineRuntime
// ---------------------------------------------------------------------------

describe("PipelineRuntime — ServiceInput support", () => {
  it("ServiceInput start() called during pipeline startup", async () => {
    const si = new MockServiceInput();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: si }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    expect(si.started).toBe(true);
    await pipeline.stop();
  });

  it("ServiceInput pushes metrics asynchronously — output receives them", async () => {
    const si = new MockServiceInput(20); // push every 20ms
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: si }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    // ServiceInput should have pushed multiple metrics
    expect(si.pushCount).toBeGreaterThanOrEqual(2);

    // Output should have received service_metric
    const serviceMetrics = output.written.filter((m) => m.name === "service_metric");
    expect(serviceMetrics.length).toBeGreaterThanOrEqual(1);
    expect(serviceMetrics[0]!.hasField("value")).toBe(true);
  });

  it("ServiceInput stop() called during shutdown before channel close", async () => {
    const si = new MockServiceInput();
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: si }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 200);

    // stop() was called
    expect(si.stopped).toBe(true);
    // close() was called after stop()
    expect(si.closed).toBe(true);
  });

  it("mixed pipeline: 1 polling input + 1 service input, output sees metrics from both", async () => {
    const pollingInput = new MockPollingInput();
    const serviceInput = new MockServiceInput(20);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: pollingInput }, { plugin: serviceInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 400);

    // Both types produced metrics
    const pollingMetrics = output.written.filter((m) => m.name === "polling_metric");
    const serviceMetrics = output.written.filter((m) => m.name === "service_metric");

    expect(pollingMetrics.length).toBeGreaterThanOrEqual(1);
    expect(serviceMetrics.length).toBeGreaterThanOrEqual(1);

    // Polling input used gather loop
    expect(pollingInput.gatherCount).toBeGreaterThanOrEqual(1);

    // ServiceInput used start/stop lifecycle
    expect(serviceInput.started).toBe(true);
    expect(serviceInput.stopped).toBe(true);
  });

  it("ServiceInput start() error: logged, pipeline continues with other inputs", async () => {
    const failingSi = new FailingServiceInput();
    const pollingInput = new MockPollingInput();
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
      inputs: [{ plugin: failingSi }, { plugin: pollingInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    process.stderr.write = originalWrite;

    // Error was logged
    const startErrors = errorCalls.filter((msg) =>
      msg.includes("service input start error"),
    );
    expect(startErrors.length).toBeGreaterThanOrEqual(1);
    expect(startErrors[0]).toContain("connection refused");

    // Pipeline didn't crash — polling input still produced metrics
    expect(pollingInput.gatherCount).toBeGreaterThanOrEqual(1);
    const pollingMetrics = output.written.filter((m) => m.name === "polling_metric");
    expect(pollingMetrics.length).toBeGreaterThanOrEqual(1);

    // Output was properly shut down
    expect(output.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: metric_batch_size
// ---------------------------------------------------------------------------

describe("PipelineRuntime — metric_batch_size", () => {
  it("large batch split into chunks for output.write()", async () => {
    // Create an input that emits many metrics per gather
    const manyFieldsInput: Input = {
      async gather(acc: Accumulator): Promise<void> {
        for (let i = 0; i < 25; i++) {
          acc.addFields("data", { value: i });
        }
      },
    };

    const batchOutput = new BatchTrackingOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: manyFieldsInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: batchOutput, metricBatchSize: 10 }],
      gatherIntervalMs: 50,
      flushIntervalMs: 80,
    });

    await runFor(pipeline, 300);

    // Should have written in chunks of ≤10
    expect(batchOutput.writeCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of batchOutput.writeCalls) {
      expect(call.length).toBeLessThanOrEqual(10);
    }

    // Total metrics written should be at least 25 (one gather cycle)
    const totalWritten = batchOutput.writeCalls.reduce((sum, c) => sum + c.length, 0);
    expect(totalWritten).toBeGreaterThanOrEqual(25);
  });

  it("without metric_batch_size, all metrics written in single call", async () => {
    const manyFieldsInput: Input = {
      async gather(acc: Accumulator): Promise<void> {
        for (let i = 0; i < 10; i++) {
          acc.addFields("data", { value: i });
        }
      },
    };

    const batchOutput = new BatchTrackingOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: manyFieldsInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: batchOutput }], // no metricBatchSize
      gatherIntervalMs: 50,
      flushIntervalMs: 120,
    });

    await runFor(pipeline, 300);

    // At least one write call should have >1 metric (unbatched)
    expect(batchOutput.writeCalls.length).toBeGreaterThanOrEqual(1);
    // Some call should have multiple metrics (gathered in one cycle)
    const hasMultiMetricCall = batchOutput.writeCalls.some((c) => c.length > 1);
    expect(hasMultiMetricCall).toBe(true);
  });
});
