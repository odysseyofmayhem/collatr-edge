// Integration test: internal metrics + other input → pipeline → output
// PRD refs: §15 Observability

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import { InternalInput, InternalConfigSchema } from "@plugins/inputs/internal";
import { SimpleStatsCollector } from "@core/stats";
import type { Metric, FieldValue } from "@core/metric";
import type { Input, Output } from "@core/plugin-types";
import type { Accumulator } from "@core/accumulator";

// ---------------------------------------------------------------------------
// Mock polling input (simulates a regular data-producing input)
// ---------------------------------------------------------------------------

class MockPollingInput implements Input {
  private callCount = 0;
  private stats: SimpleStatsCollector;

  constructor(stats: SimpleStatsCollector) {
    this.stats = stats;
  }

  async gather(acc: Accumulator): Promise<void> {
    this.callCount++;
    acc.addFields("machine.temperature", {
      value: 22.5 + this.callCount * 0.1,
    }, { machine: "plc_01" });
    acc.addFields("machine.pressure", {
      value: 101.3,
    }, { machine: "plc_01" });
    // Simulate pipeline counting gathered metrics
    this.stats.metricsGathered += 2;
  }
}

// ---------------------------------------------------------------------------
// Mock output (captures metrics for verification)
// ---------------------------------------------------------------------------

class MockOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> { this.connected = true; }
  async write(batch: Metric[]): Promise<void> { this.written.push(...batch); }
  async close(): Promise<void> { this.closed = true; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: internal metrics + other input → pipeline → output", () => {
  it("internal metrics and regular metrics both arrive at output", async () => {
    const stats = new SimpleStatsCollector();
    const internalConfig = InternalConfigSchema.parse({});
    const internalInput = new InternalInput(internalConfig, stats);
    const mockInput = new MockPollingInput(stats);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [
        { plugin: mockInput },
        { plugin: internalInput },
      ],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();

    // Let a few gather cycles run for both inputs
    await Bun.sleep(300);
    await pipeline.stop();

    expect(output.connected).toBe(true);

    // Should have both regular metrics and internal metrics
    const regularMetrics = output.written.filter((m) =>
      m.name.startsWith("machine."),
    );
    const internalMetrics = output.written.filter((m) =>
      m.name.startsWith("agent."),
    );

    expect(regularMetrics.length).toBeGreaterThanOrEqual(2);
    expect(internalMetrics.length).toBeGreaterThanOrEqual(1);

    // Regular metrics have correct structure
    const temp = regularMetrics.find((m) => m.name === "machine.temperature");
    expect(temp).toBeDefined();
    expect(temp!.getField("value")).toBeGreaterThan(0);
    expect(temp!.getTag("machine")).toBe("plc_01");

    // Internal metrics have correct structure
    const uptime = internalMetrics.find((m) => m.name === "agent.uptime_seconds");
    expect(uptime).toBeDefined();
    expect(uptime!.getField("value")).toBeGreaterThanOrEqual(0);
    expect(uptime!.getTag("host")).toBeDefined();
  });

  it("agent.metrics_gathered reflects actual metrics produced by other input", async () => {
    const stats = new SimpleStatsCollector();
    const internalConfig = InternalConfigSchema.parse({});
    const internalInput = new InternalInput(internalConfig, stats);
    const mockInput = new MockPollingInput(stats);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [
        { plugin: mockInput },
        { plugin: internalInput },
      ],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();

    // Let several gather cycles run so mockInput increments stats.metricsGathered
    await Bun.sleep(300);
    await pipeline.stop();

    // Find the last agent.metrics_gathered metric emitted
    const gatheredMetrics = output.written.filter(
      (m) => m.name === "agent.metrics_gathered",
    );
    expect(gatheredMetrics.length).toBeGreaterThanOrEqual(1);

    // The last emitted value should be > 0 (mockInput emits 2 metrics per gather
    // and increments stats.metricsGathered accordingly)
    const lastGathered = gatheredMetrics[gatheredMetrics.length - 1]!;
    const gatheredCount = lastGathered.getField("value") as number;
    expect(gatheredCount).toBeGreaterThan(0);

    // Should be a multiple of 2 (mockInput emits 2 metrics per gather cycle)
    expect(gatheredCount % 2).toBe(0);
  });
});
