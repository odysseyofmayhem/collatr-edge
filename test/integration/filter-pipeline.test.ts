// Integration test: Filter processor in full pipeline
// PRD refs: §6 Plugin System (Processor contract), §7 Configuration (Filtering)

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import { FilterProcessor, FilterConfigSchema } from "@plugins/processors/filter";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type { Input, Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock plugins
// ---------------------------------------------------------------------------

class MockInput implements Input {
  private measurements: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[];

  constructor(measurements: { name: string; fields: Record<string, number>; tags?: Record<string, string> }[]) {
    this.measurements = measurements;
  }

  async gather(acc: Accumulator): Promise<void> {
    for (const m of this.measurements) {
      acc.addFields(m.name, m.fields, m.tags);
    }
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

describe("Integration: Filter processor in pipeline", () => {
  it("Mixed input: 5 metrics, namepass allows 3 → output receives 3 per cycle", async () => {
    const input = new MockInput([
      { name: "temperature_motor", fields: { value: 23.5 } },
      { name: "temperature_oven", fields: { value: 150.0 } },
      { name: "pressure_main", fields: { value: 1.5 } },
      { name: "humidity", fields: { value: 45.0 } },
      { name: "debug_info", fields: { count: 1 } },
    ]);

    const filterProc = new FilterProcessor(FilterConfigSchema.parse({
      namepass: ["temperature_*", "pressure_*"],
    }));

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

    // At least one gather cycle produced 3 passing metrics
    expect(output.written.length).toBeGreaterThanOrEqual(3);
    // Must be a multiple of 3 (3 pass per cycle)
    expect(output.written.length % 3).toBe(0);

    for (const m of output.written) {
      const passes = m.name.startsWith("temperature_") || m.name.startsWith("pressure_");
      expect(passes).toBe(true);
    }

    expect(output.written.some(m => m.name === "humidity")).toBe(false);
    expect(output.written.some(m => m.name === "debug_info")).toBe(false);
  });

  it("tagdrop removes metrics with env=test tag", async () => {
    const input = new MockInput([
      { name: "sensor_1", fields: { value: 1 }, tags: { env: "production" } },
      { name: "sensor_2", fields: { value: 2 }, tags: { env: "test" } },
      { name: "sensor_3", fields: { value: 3 }, tags: { env: "production" } },
    ]);

    const filterProc = new FilterProcessor(FilterConfigSchema.parse({
      tagdrop: { env: ["test"] },
    }));

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

    expect(output.written.length).toBeGreaterThanOrEqual(2);

    for (const m of output.written) {
      // No metric with env=test should have reached output
      expect(m.getTag("env")).not.toBe("test");
    }

    expect(output.written.some(m => m.name === "sensor_2")).toBe(false);
    expect(output.written.some(m => m.name === "sensor_1")).toBe(true);
    expect(output.written.some(m => m.name === "sensor_3")).toBe(true);
  });

  it("fieldpass trims fields: output metrics have only specified fields", async () => {
    const input = new MockInput([
      { name: "sensor", fields: { value: 23.5, quality: 1, debug_seq: 99, internal_flag: 0 } },
    ]);

    const filterProc = new FilterProcessor(FilterConfigSchema.parse({
      fieldpass: ["value", "quality"],
    }));

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
      expect(m.fields.size).toBe(2);
      expect(m.hasField("value")).toBe(true);
      expect(m.hasField("quality")).toBe(true);
      expect(m.hasField("debug_seq")).toBe(false);
      expect(m.hasField("internal_flag")).toBe(false);
    }
  });
});
