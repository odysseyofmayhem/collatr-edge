// Integration test: Basicstats aggregator in full pipeline — E2E with real timer
// PRD refs: §6 Plugin System (Aggregator contract)

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import { BasicstatsAggregator, BasicstatsConfigSchema } from "@plugins/aggregators/basicstats";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type { Input, Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock plugins
// ---------------------------------------------------------------------------

/** Input that emits a fixed value each gather cycle. */
class FixedInput implements Input {
  private name: string;
  private value: number;
  gatherCount = 0;

  constructor(name: string, value: number) {
    this.name = name;
    this.value = value;
  }

  async gather(acc: Accumulator): Promise<void> {
    acc.addFields(this.name, { value: this.value });
    this.gatherCount++;
  }

  async close(): Promise<void> {}
}

/** Input that emits an incrementing value each gather cycle. */
class IncrementingInput implements Input {
  private name: string;
  private current: number;

  constructor(name: string, start = 1) {
    this.name = name;
    this.current = start;
  }

  async gather(acc: Accumulator): Promise<void> {
    acc.addFields(this.name, { value: this.current });
    this.current++;
  }

  async close(): Promise<void> {}
}

class CollectorOutput implements Output {
  written: Metric[] = [];

  async connect(): Promise<void> {}

  async write(batch: Metric[]): Promise<void> {
    this.written.push(...batch);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runFor(pipeline: PipelineRuntime, durationMs: number): Promise<void> {
  await pipeline.start();
  await Bun.sleep(durationMs);
  await pipeline.stop();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Basicstats aggregator in pipeline", () => {
  it("Originals + summaries both arrive at output (drop_original=false)", async () => {
    const input = new FixedInput("sensor", 42.5);

    const agg = new BasicstatsAggregator(BasicstatsConfigSchema.parse({
      period: "100ms",
      drop_original: false,
      stats: ["count", "min", "max", "mean"],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: agg, period: 100, dropOriginal: false }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 30,
      flushIntervalMs: 30,
    });

    // Run for 250ms — enough for several gathers and at least 1 aggregation push
    await runFor(pipeline, 250);

    // Should have both original metrics (name=sensor, field=value) and
    // summary metrics (name=sensor, fields=value_count, value_min, etc.)
    const originals = output.written.filter(m => m.hasField("value"));
    const summaries = output.written.filter(m => m.hasField("value_count"));

    expect(originals.length).toBeGreaterThanOrEqual(1);
    expect(summaries.length).toBeGreaterThanOrEqual(1);

    // Originals have the raw value
    for (const m of originals) {
      expect(m.name).toBe("sensor");
      expect(m.getField("value")).toBe(42.5);
    }

    // Summaries have computed stats
    for (const m of summaries) {
      expect(m.name).toBe("sensor");
      expect(m.getField("value_min")).toBe(42.5);
      expect(m.getField("value_max")).toBe(42.5);
      expect(m.getField("value_mean")).toBe(42.5);
    }
  });

  it("Summary min/max/mean/count match expected values from input", async () => {
    // Incrementing input: 1, 2, 3, ... per gather
    const input = new IncrementingInput("counter", 1);

    const agg = new BasicstatsAggregator(BasicstatsConfigSchema.parse({
      period: "200ms",
      drop_original: false,
      stats: ["count", "min", "max", "mean", "sum"],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: agg, period: 200, dropOriginal: false }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 30,
      flushIntervalMs: 30,
    });

    // Run 500ms — at least 1 aggregation period completes + final push at shutdown
    await runFor(pipeline, 500);

    const summaries = output.written.filter(m => m.hasField("value_count"));
    expect(summaries.length).toBeGreaterThanOrEqual(1);

    // Check the first summary — should reflect the first window's values
    const first = summaries[0]!;
    const count = first.getField("value_count") as number;
    const min = first.getField("value_min") as number;
    const max = first.getField("value_max") as number;
    const sum = first.getField("value_sum") as number;
    const mean = first.getField("value_mean") as number;

    expect(count).toBeGreaterThanOrEqual(1);
    expect(min).toBe(1); // First value is always 1
    expect(max).toBeGreaterThanOrEqual(min);
    // Sum of 1..N = N*(N+1)/2
    expect(sum).toBe((count * (count + 1)) / 2);
    expect(mean).toBeCloseTo(sum / count, 5);
  });

  it("drop_original=true: only summary metrics in output (no originals)", async () => {
    const input = new FixedInput("sensor", 10.0);

    const agg = new BasicstatsAggregator(BasicstatsConfigSchema.parse({
      period: "100ms",
      drop_original: true,
      stats: ["count", "mean"],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      // dropOriginal is set on the pipeline options, not just the aggregator config
      aggregators: [{ plugin: agg, period: 100, dropOriginal: true }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 30,
      flushIntervalMs: 30,
    });

    await runFor(pipeline, 250);

    // With drop_original=true, NO original metrics should reach output
    // Only summary metrics (with value_count, value_mean) should be present
    const originals = output.written.filter(
      m => m.hasField("value") && !m.hasField("value_count"),
    );
    const summaries = output.written.filter(m => m.hasField("value_count"));

    expect(originals.length).toBe(0);
    expect(summaries.length).toBeGreaterThanOrEqual(1);

    for (const m of summaries) {
      expect(m.name).toBe("sensor");
      expect(m.getField("value_count")).toBeGreaterThanOrEqual(1);
      expect(m.getField("value_mean")).toBe(10.0);
    }
  });

  it("Multiple aggregation periods: stats reset between windows", async () => {
    // Incrementing input: 1, 2, 3, ... per gather
    const input = new IncrementingInput("counter", 1);

    const agg = new BasicstatsAggregator(BasicstatsConfigSchema.parse({
      period: "120ms",
      stats: ["count", "min"],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [],
      aggregators: [{ plugin: agg, period: 120, dropOriginal: false }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 30,
      flushIntervalMs: 30,
    });

    // Run long enough for at least 2 aggregation windows
    await runFor(pipeline, 500);

    const summaries = output.written.filter(m => m.hasField("value_count"));

    // Should have at least 2 summaries (2 windows + possibly final push)
    expect(summaries.length).toBeGreaterThanOrEqual(2);

    // The min of the second window should be higher than the min of the first
    // (because the incrementing input keeps increasing and reset clears state)
    const firstMin = summaries[0]!.getField("value_min") as number;
    const secondMin = summaries[1]!.getField("value_min") as number;
    expect(secondMin).toBeGreaterThan(firstMin);
  });
});
