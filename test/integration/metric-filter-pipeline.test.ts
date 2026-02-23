// Integration test: Metric filtering applied in pipeline context
// PRD refs: §7 Configuration (Filtering on every plugin)

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import { MetricFilter, type MetricFilterConfig } from "@core/metric-filter";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type { Input, Processor, Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock plugins with filtering support
// ---------------------------------------------------------------------------

/** Mock input that produces multiple named metrics, with optional per-plugin filtering. */
class FilteredInput implements Input {
  private measurements: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[];
  private filter: MetricFilter;

  constructor(
    measurements: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[],
    filterConfig: MetricFilterConfig = {},
  ) {
    this.measurements = measurements;
    this.filter = new MetricFilter(filterConfig);
  }

  async gather(acc: Accumulator): Promise<void> {
    for (const m of this.measurements) {
      acc.addFields(m.name, m.fields, m.tags);
    }
  }

  // Apply filter as a post-gather step (simulating per-plugin namepass/namedrop)
  // In the real pipeline, the runtime would apply per-plugin filters after gather.
  // For this integration test, we wrap gather to demonstrate filtering works.
  async gatherFiltered(acc: Accumulator): Promise<void> {
    // Collect metrics, then filter
    const collected: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[] = [];
    for (const m of this.measurements) {
      collected.push(m);
    }
    for (const m of collected) {
      acc.addFields(m.name, m.fields, m.tags);
    }
  }

  async close(): Promise<void> {}
}

/** Mock input that emits metrics, applying a MetricFilter before forwarding. */
class FilteringInput implements Input {
  private metrics: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[];
  private filter: MetricFilter;

  constructor(
    metrics: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[],
    filterConfig: MetricFilterConfig,
  ) {
    this.metrics = metrics;
    this.filter = new MetricFilter(filterConfig);
  }

  async gather(acc: Accumulator): Promise<void> {
    for (const m of this.metrics) {
      // Create metric via acc, but we need to filter first.
      // Since acc.addFields creates and sends directly, we use addFields for
      // metrics that pass the filter and skip those that don't.
      // Build a temporary metric to check against filter
      const { createMetric } = await import("@core/metric");
      const metric = createMetric({ name: m.name, fields: m.fields, tags: m.tags });
      const result = this.filter.apply(metric);
      if (result !== null) {
        acc.addMetric(result);
      }
    }
  }

  async close(): Promise<void> {}
}

/** Processor that applies MetricFilter to each metric passing through. */
class FilterProcessor implements Processor {
  private filter: MetricFilter;

  constructor(filterConfig: MetricFilterConfig) {
    this.filter = new MetricFilter(filterConfig);
  }

  async process(metric: Metric, acc: Accumulator): Promise<void> {
    const result = this.filter.apply(metric);
    if (result !== null) {
      acc.addMetric(result);
    }
    // If null, metric is silently dropped (processor contract: no auto-forward)
  }

  async close(): Promise<void> {}
}

/** Collects all metrics written to it. */
class CollectorOutput implements Output {
  written: Metric[] = [];
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

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

describe("Integration: Metric filtering in pipeline", () => {
  it("Input with namepass filter: only matching metrics reach output", async () => {
    // Input produces 4 metrics per gather: temperature_*, pressure_*, humidity, debug_info
    // namepass = ["temperature_*", "pressure_*"] → only temperature and pressure pass
    const input = new FilteringInput(
      [
        { name: "temperature_motor", fields: { value: 23.5 } },
        { name: "temperature_oven", fields: { value: 150.0 } },
        { name: "pressure_main", fields: { value: 1.5 } },
        { name: "humidity", fields: { value: 45.0 } },
        { name: "debug_info", fields: { count: 1 } },
      ],
      { namepass: ["temperature_*", "pressure_*"] },
    );

    const output = new CollectorOutput();

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
    expect(output.written.length).toBeGreaterThanOrEqual(3); // At least 1 gather cycle (3 metrics pass)

    // Every metric that reached output must match temperature_* or pressure_*
    for (const m of output.written) {
      const nameMatch =
        m.name.startsWith("temperature_") || m.name.startsWith("pressure_");
      expect(nameMatch).toBe(true);
    }

    // humidity and debug_info must NOT be present
    expect(output.written.some((m) => m.name === "humidity")).toBe(false);
    expect(output.written.some((m) => m.name === "debug_info")).toBe(false);

    // Should have all three matching types
    expect(output.written.some((m) => m.name === "temperature_motor")).toBe(true);
    expect(output.written.some((m) => m.name === "temperature_oven")).toBe(true);
    expect(output.written.some((m) => m.name === "pressure_main")).toBe(true);
  });

  it("Processor with fieldpass: only specified fields survive to output", async () => {
    // Input produces metrics with 4 fields each
    // Processor with fieldpass = ["value", "quality"] → only those fields survive
    const input = new FilteredInput([
      {
        name: "sensor_data",
        fields: { value: 23.5, quality: 1, debug_count: 42, internal_seq: 99 },
      },
    ]);

    const filterProc = new FilterProcessor({
      fieldpass: ["value", "quality"],
    });

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: filterProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);

    for (const m of output.written) {
      expect(m.name).toBe("sensor_data");
      // Only value and quality fields should remain
      expect(m.hasField("value")).toBe(true);
      expect(m.hasField("quality")).toBe(true);
      expect(m.hasField("debug_count")).toBe(false);
      expect(m.hasField("internal_seq")).toBe(false);
      expect(m.fields.size).toBe(2);
    }
  });

  it("Combined: input namepass + processor fieldpass both applied", async () => {
    // Input filters by name: only temperature_* passes
    // Processor filters by field: only value and quality fields survive
    const input = new FilteringInput(
      [
        { name: "temperature_motor", fields: { value: 23.5, quality: 1, debug: 0 } },
        { name: "temperature_oven", fields: { value: 150.0, quality: 1, debug: 0 } },
        { name: "humidity", fields: { value: 45.0, quality: 1, debug: 0 } },
      ],
      { namepass: ["temperature_*"] },
    );

    const filterProc = new FilterProcessor({
      fieldpass: ["value", "quality"],
    });

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: filterProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(2); // At least 1 cycle → 2 metrics

    // Only temperature_* metrics (input filter)
    for (const m of output.written) {
      expect(m.name.startsWith("temperature_")).toBe(true);
      // Only value + quality fields (processor filter)
      expect(m.hasField("value")).toBe(true);
      expect(m.hasField("quality")).toBe(true);
      expect(m.hasField("debug")).toBe(false);
      expect(m.fields.size).toBe(2);
    }

    // humidity was filtered at input level — never reaches pipeline
    expect(output.written.some((m) => m.name === "humidity")).toBe(false);
  });
});
