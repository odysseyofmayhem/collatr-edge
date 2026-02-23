// E2E test: Error resilience
// Phase 5 task 5.4 — proves plugin errors are isolated, pipeline survives failures
// PRD refs: §14 Error Handling & Resilience

import { describe, it, expect, afterEach } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type { Input, Processor, Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Test helpers — error-producing plugins
// ---------------------------------------------------------------------------

/** Healthy polling input that emits metrics reliably. */
class HealthyInput implements Input {
  private counter = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.counter++;
    acc.addFields("healthy_metric", { counter: this.counter }, { source: "healthy" });
  }
}

/** Input that throws on every gather() call. */
class FailingInput implements Input {
  errorCount = 0;

  async gather(_acc: Accumulator): Promise<void> {
    this.errorCount++;
    throw new Error(`FailingInput error #${this.errorCount}`);
  }
}

/** Input that emits alternating good/bad metrics. */
class AlternatingInput implements Input {
  private counter = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.counter++;
    if (this.counter % 2 === 1) {
      acc.addFields("good_metric", { counter: this.counter });
    } else {
      acc.addFields("bad_metric", { counter: this.counter });
    }
  }
}

/** Processor that throws on metrics named "bad_metric", passes others through. */
class ThrowingProcessor implements Processor {
  async process(metric: Metric, acc: Accumulator): Promise<void> {
    if (metric.name === "bad_metric") {
      throw new Error(`Processor rejects bad_metric (counter=${metric.getField("counter")})`);
    }
    acc.addMetric(metric);
  }
}

/** Output that fails the first N write() calls, then succeeds. */
class FailNTimesOutput implements Output {
  private failsRemaining: number;
  written: Metric[] = [];
  failCount = 0;
  successCount = 0;

  constructor(failCount: number) {
    this.failsRemaining = failCount;
  }

  async connect(): Promise<void> {}

  async write(batch: Metric[]): Promise<void> {
    if (this.failsRemaining > 0) {
      this.failsRemaining--;
      this.failCount++;
      throw new Error(`Simulated write failure (${this.failsRemaining} remaining)`);
    }
    this.written.push(...batch);
    this.successCount++;
  }

  async close(): Promise<void> {}
}

/** Input that takes 5 seconds per gather (simulates hung PLC). */
class SlowInput implements Input {
  gatherStartCount = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.gatherStartCount++;
    await Bun.sleep(5000);
    acc.addFields("slow_metric", { value: 1 });
  }
}

/** Mock output that collects all written metrics. */
class CollectorOutput implements Output {
  written: Metric[] = [];
  writeCount = 0;

  async connect(): Promise<void> {}

  async write(batch: Metric[]): Promise<void> {
    this.written.push(...batch);
    this.writeCount++;
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Error capture helper
// ---------------------------------------------------------------------------

function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  return {
    errors,
    restore: () => {
      console.error = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

const pipelines: PipelineRuntime[] = [];

afterEach(async () => {
  for (const p of pipelines) {
    try {
      await p.stop();
    } catch {
      // Ignore stop errors in cleanup
    }
  }
  pipelines.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Error resilience (task 5.4)", () => {
  // -------------------------------------------------------------------------
  // 5.4.1 — Input gather error: pipeline continues
  // -------------------------------------------------------------------------

  it("5.4.1: input gather error — pipeline continues, healthy input unaffected", async () => {
    const { errors, restore } = captureErrors();

    try {
      const healthyInput = new HealthyInput();
      const failingInput = new FailingInput();
      const output = new CollectorOutput();

      const pipeline = new PipelineRuntime({
        inputs: [
          { plugin: healthyInput, interval: 50 },
          { plugin: failingInput, interval: 50 },
        ],
        processors: [],
        aggregators: [],
        outputs: [{ plugin: output }],
        gatherIntervalMs: 50,
        flushIntervalMs: 100,
      });
      pipelines.push(pipeline);

      await pipeline.start();
      await Bun.sleep(500);
      await pipeline.stop();
      pipelines.length = 0;

      // Pipeline did NOT crash — output received metrics from healthy input
      const healthyMetrics = output.written.filter(
        (m) => m.name === "healthy_metric",
      );
      expect(healthyMetrics.length).toBeGreaterThan(0);

      // Errors from FailingInput were logged
      const gatherErrors = errors.filter((e) =>
        e.includes("FailingInput error"),
      );
      expect(gatherErrors.length).toBeGreaterThan(0);

      // No metrics from the failing input
      const failingMetrics = output.written.filter(
        (m) => m.name !== "healthy_metric",
      );
      expect(failingMetrics.length).toBe(0);
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // 5.4.2 — Processor error: metric dropped, pipeline continues
  // -------------------------------------------------------------------------

  it("5.4.2: processor error — bad metrics dropped, good metrics pass through", async () => {
    const { errors, restore } = captureErrors();

    try {
      const input = new AlternatingInput();
      const processor = new ThrowingProcessor();
      const output = new CollectorOutput();

      const pipeline = new PipelineRuntime({
        inputs: [{ plugin: input, interval: 50 }],
        processors: [{ plugin: processor }],
        aggregators: [],
        outputs: [{ plugin: output }],
        gatherIntervalMs: 50,
        flushIntervalMs: 100,
      });
      pipelines.push(pipeline);

      await pipeline.start();
      await Bun.sleep(500);
      await pipeline.stop();
      pipelines.length = 0;

      // Output received ONLY good_metric (bad_metric was dropped by processor error)
      expect(output.written.length).toBeGreaterThan(0);
      for (const m of output.written) {
        expect(m.name).toBe("good_metric");
      }

      // Processor errors were logged
      const procErrors = errors.filter((e) =>
        e.includes("processor error"),
      );
      expect(procErrors.length).toBeGreaterThan(0);

      // Approximately half the input was dropped (alternating good/bad)
      // Input emits ~10 metrics in 500ms at 50ms interval = ~5 good, ~5 bad
      // Output should have roughly the good ones
      const goodCount = output.written.length;
      expect(goodCount).toBeGreaterThanOrEqual(3); // At least some good metrics
      expect(procErrors.length).toBeGreaterThanOrEqual(3); // At least some errors
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // 5.4.3 — Output write failure: retry behaviour
  // -------------------------------------------------------------------------

  it("5.4.3: output write failure — metrics retried after output recovers", async () => {
    const { errors, restore } = captureErrors();

    try {
      const input = new HealthyInput();
      const output = new FailNTimesOutput(3);

      const pipeline = new PipelineRuntime({
        inputs: [{ plugin: input, interval: 50 }],
        processors: [],
        aggregators: [],
        outputs: [{ plugin: output }],
        gatherIntervalMs: 50,
        flushIntervalMs: 200,
      });
      pipelines.push(pipeline);

      await pipeline.start();
      await Bun.sleep(1500);
      await pipeline.stop();
      pipelines.length = 0;

      // Output eventually received metrics (after first 3 failures)
      expect(output.written.length).toBeGreaterThan(0);
      expect(output.successCount).toBeGreaterThan(0);

      // First 3 writes failed
      expect(output.failCount).toBe(3);

      // Write errors were logged
      const writeErrors = errors.filter((e) =>
        e.includes("output write error"),
      );
      expect(writeErrors.length).toBe(3);

      // Metrics from the failed period were retried and eventually delivered
      // (the runtime re-adds failed metrics to the batch buffer)
      // We can verify this by checking that early counter values are present
      const counters = output.written.map(
        (m) => m.getField("counter") as number,
      );
      expect(Math.min(...counters)).toBeLessThanOrEqual(5);
    } finally {
      restore();
    }
  });

  // -------------------------------------------------------------------------
  // 5.4.4 — Gather timeout: slow input doesn't block pipeline
  // -------------------------------------------------------------------------

  it("5.4.4: gather timeout — slow input timed out, fast input unaffected", async () => {
    const { errors, restore } = captureErrors();

    try {
      const normalInput = new HealthyInput();
      const slowInput = new SlowInput();
      const output = new CollectorOutput();

      const pipeline = new PipelineRuntime({
        inputs: [
          { plugin: normalInput, interval: 100 },
          { plugin: slowInput, interval: 500 },
        ],
        processors: [],
        aggregators: [],
        outputs: [{ plugin: output }],
        gatherIntervalMs: 100,
        gatherTimeoutMs: 200,
        flushIntervalMs: 100,
      });
      pipelines.push(pipeline);

      await pipeline.start();
      await Bun.sleep(1000);
      await pipeline.stop();
      pipelines.length = 0;

      // Output received metrics from normal input
      const normalMetrics = output.written.filter(
        (m) => m.name === "healthy_metric",
      );
      expect(normalMetrics.length).toBeGreaterThan(0);

      // Timeout errors were logged for slow input
      const timeoutErrors = errors.filter((e) =>
        e.includes("Gather timeout"),
      );
      expect(timeoutErrors.length).toBeGreaterThan(0);

      // Pipeline stayed responsive — normal input's metrics arrived with regular timing
      // (timestamps within the test window, not bunched at the end)
      const timestamps = normalMetrics.map((m) => Number(m.timestamp / 1_000_000n));
      const startTime = timestamps[0]!;
      const endTime = timestamps[timestamps.length - 1]!;
      const span = endTime - startTime;
      // Metrics should span most of the 1-second window (at least 500ms)
      expect(span).toBeGreaterThanOrEqual(500);
    } finally {
      restore();
    }
  });
});
