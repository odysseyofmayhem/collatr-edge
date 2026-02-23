// Integration test: Rename processor in full pipeline
// PRD refs: §6 Plugin System (Processor contract), §19 MVP Plugin Inventory

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import { RenameProcessor, RenameConfigSchema } from "@plugins/processors/rename";
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

describe("Integration: Rename processor in pipeline", () => {
  it("Input metric with field 'temperature' → output has 'motor_temp_c' (no 'temperature')", async () => {
    const input = new MockInput([
      { name: "sensor", fields: { temperature: 23.5, pressure: 1.5 } },
    ]);

    const renameProc = new RenameProcessor(RenameConfigSchema.parse({
      replace: [{ field: "temperature", dest: "motor_temp_c" }],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: renameProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);

    for (const m of output.written) {
      expect(m.name).toBe("sensor");
      // Renamed field present
      expect(m.hasField("motor_temp_c")).toBe(true);
      expect(m.getField("motor_temp_c")).toBe(23.5);
      // Original field absent
      expect(m.hasField("temperature")).toBe(false);
      // Other fields unaffected
      expect(m.getField("pressure")).toBe(1.5);
    }
  });

  it("Multiple rename rules: both applied in output metrics", async () => {
    const input = new MockInput([
      { name: "sensor", fields: { temperature: 23.5, pressure: 1.5 }, tags: { host: "gw-01" } },
    ]);

    const renameProc = new RenameProcessor(RenameConfigSchema.parse({
      replace: [
        { field: "temperature", dest: "temp_c" },
        { field: "pressure", dest: "press_bar" },
        { tag: "host", dest: "hostname" },
      ],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: renameProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);

    for (const m of output.written) {
      // Both field renames applied
      expect(m.getField("temp_c")).toBe(23.5);
      expect(m.getField("press_bar")).toBe(1.5);
      expect(m.hasField("temperature")).toBe(false);
      expect(m.hasField("pressure")).toBe(false);
      // Tag rename applied
      expect(m.getTag("hostname")).toBe("gw-01");
      expect(m.hasTag("host")).toBe(false);
    }
  });

  it("Metric without matching field: passes through unchanged", async () => {
    const input = new MockInput([
      { name: "sensor", fields: { humidity: 45.0, count: 10 } },
    ]);

    // Rename rule targets "temperature" which doesn't exist on this metric
    const renameProc = new RenameProcessor(RenameConfigSchema.parse({
      replace: [{ field: "temperature", dest: "motor_temp_c" }],
    }));

    const output = new CollectorOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input }],
      processors: [{ plugin: renameProc }],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await runFor(pipeline, 300);

    expect(output.written.length).toBeGreaterThanOrEqual(1);

    for (const m of output.written) {
      // Original fields unchanged — no rename happened
      expect(m.getField("humidity")).toBe(45.0);
      expect(m.getField("count")).toBe(10);
      expect(m.fields.size).toBe(2);
      // No "motor_temp_c" appeared
      expect(m.hasField("motor_temp_c")).toBe(false);
    }
  });
});
