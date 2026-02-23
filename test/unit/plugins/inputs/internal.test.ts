// Unit tests: Internal metrics input plugin
// PRD refs: §15 Observability, §19 MVP Plugin Inventory

import { describe, it, expect, beforeEach } from "bun:test";
import {
  InternalInput,
  InternalConfigSchema,
  type InternalConfig,
} from "@plugins/inputs/internal";
import { SimpleStatsCollector } from "@core/stats";
import type { Accumulator } from "@core/accumulator";
import type { FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Collecting accumulator (captures metrics for assertions)
// ---------------------------------------------------------------------------

interface CollectedMetric {
  measurement: string;
  fields: Record<string, FieldValue>;
  tags: Record<string, string>;
}

class CollectingAcc implements Accumulator {
  metrics: CollectedMetric[] = [];
  errors: Error[] = [];

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
  ): void {
    this.metrics.push({ measurement, fields, tags: tags ?? {} });
  }

  addMetric(): void {}

  addError(error: Error): void {
    this.errors.push(error);
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): InternalConfig {
  return InternalConfigSchema.parse(overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Internal Metrics Input Plugin", () => {
  let stats: SimpleStatsCollector;
  let acc: CollectingAcc;

  beforeEach(() => {
    // Start time 10 seconds ago
    stats = new SimpleStatsCollector(Date.now() - 10_000);
    acc = new CollectingAcc();
  });

  // =========================================================================
  // Task spec test 1: uptime metric with positive value
  // =========================================================================

  it("produces agent.uptime_seconds metric with positive value", async () => {
    const config = makeConfig();
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const uptime = acc.metrics.find((m) => m.measurement === "agent.uptime_seconds");
    expect(uptime).toBeDefined();
    expect(uptime!.fields.value).toBeGreaterThan(0);
    // Should be roughly 10 seconds (± 1s for test execution)
    expect(uptime!.fields.value as number).toBeGreaterThanOrEqual(9);
    expect(uptime!.fields.value as number).toBeLessThan(15);
  });

  // =========================================================================
  // Task spec test 2: memory_usage is a positive number
  // =========================================================================

  it("agent.memory_usage is a positive number (bytes)", async () => {
    const config = makeConfig();
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const mem = acc.metrics.find((m) => m.measurement === "agent.memory_usage");
    expect(mem).toBeDefined();
    expect(mem!.fields.heap_used).toBeGreaterThan(0);
    expect(mem!.fields.rss).toBeGreaterThan(0);
    expect(mem!.fields.heap_total).toBeGreaterThan(0);
    expect(typeof mem!.fields.heap_used).toBe("number");
  });

  // =========================================================================
  // Task spec test 3: metrics_gathered increases
  // =========================================================================

  it("agent.metrics_gathered increases as inputs produce metrics", async () => {
    const config = makeConfig();
    const input = new InternalInput(config, stats);

    // First gather — counter is 0
    stats.metricsGathered = 0;
    await input.gather(acc);

    const first = acc.metrics.find((m) => m.measurement === "agent.metrics_gathered");
    expect(first).toBeDefined();
    expect(first!.fields.value).toBe(0);

    // Simulate metrics being gathered
    stats.metricsGathered = 42;
    acc.metrics = [];
    await input.gather(acc);

    const second = acc.metrics.find((m) => m.measurement === "agent.metrics_gathered");
    expect(second).toBeDefined();
    expect(second!.fields.value).toBe(42);

    // Counter increases further
    stats.metricsGathered = 100;
    acc.metrics = [];
    await input.gather(acc);

    const third = acc.metrics.find((m) => m.measurement === "agent.metrics_gathered");
    expect(third!.fields.value).toBe(100);
  });

  // =========================================================================
  // Task spec test 4: per-input gather_time is non-negative
  // =========================================================================

  it("per-input gather_time is non-negative (milliseconds)", async () => {
    const config = makeConfig();
    stats.setInputStats([
      { name: "modbus_plc01", gatherTimeMs: 23.5, metricsCount: 15 },
      { name: "opcua_server1", gatherTimeMs: 0, metricsCount: 30 },
    ]);
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const inputMetrics = acc.metrics.filter((m) => m.measurement === "agent.input");
    expect(inputMetrics.length).toBe(2);

    const modbus = inputMetrics.find((m) => m.tags.input === "modbus_plc01");
    const opcua = inputMetrics.find((m) => m.tags.input === "opcua_server1");

    expect(modbus).toBeDefined();
    expect(modbus!.fields.gather_time_ms).toBe(23.5);
    expect(modbus!.fields.gather_time_ms as number).toBeGreaterThanOrEqual(0);
    expect(modbus!.fields.metrics_count).toBe(15);

    expect(opcua).toBeDefined();
    expect(opcua!.fields.gather_time_ms).toBe(0);
    expect(opcua!.fields.gather_time_ms as number).toBeGreaterThanOrEqual(0);
    expect(opcua!.fields.metrics_count).toBe(30);
  });

  // =========================================================================
  // Task spec test 5: metrics have correct agent.* prefix
  // =========================================================================

  it("metrics have correct agent.* prefix", async () => {
    const config = makeConfig();
    stats.setInputStats([{ name: "test_input", gatherTimeMs: 5, metricsCount: 10 }]);
    stats.setOutputStats([{ name: "test_output", writeTimeMs: 2, bufferSize: 50 }]);
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    // All metric names should start with "agent."
    for (const m of acc.metrics) {
      expect(m.measurement.startsWith("agent.")).toBe(true);
    }

    // Check specific expected names
    const names = acc.metrics.map((m) => m.measurement);
    expect(names).toContain("agent.uptime_seconds");
    expect(names).toContain("agent.metrics_gathered");
    expect(names).toContain("agent.metrics_written");
    expect(names).toContain("agent.metrics_dropped");
    expect(names).toContain("agent.gather_errors");
    expect(names).toContain("agent.write_errors");
    expect(names).toContain("agent.memory_usage");
    expect(names).toContain("agent.input");
    expect(names).toContain("agent.output");
  });

  // =========================================================================
  // Task spec test 6: hostname tag present
  // =========================================================================

  it("agent hostname tag present on all metrics", async () => {
    const config = makeConfig();
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    for (const m of acc.metrics) {
      expect(m.tags.host).toBeDefined();
      expect(m.tags.host.length).toBeGreaterThan(0);
    }
  });

  // =========================================================================
  // Task spec test 7: internal metrics flow through pipeline (unit-level check)
  // =========================================================================

  it("internal metrics flow through accumulator like normal metrics", async () => {
    const config = makeConfig();
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    // Verify we get a reasonable set of metrics
    // At minimum: uptime, gathered, written, dropped, gather_errors, write_errors, memory
    expect(acc.metrics.length).toBeGreaterThanOrEqual(7);

    // Each metric has fields
    for (const m of acc.metrics) {
      expect(Object.keys(m.fields).length).toBeGreaterThan(0);
    }

    // No errors should have occurred
    expect(acc.errors.length).toBe(0);
  });

  // =========================================================================
  // Additional tests
  // =========================================================================

  it("per-output stats emitted with correct tags", async () => {
    const config = makeConfig();
    stats.setOutputStats([
      { name: "local_store", writeTimeMs: 12.3, bufferSize: 500 },
      { name: "mqtt_hub", writeTimeMs: 45.6, bufferSize: 200 },
    ]);
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const outputMetrics = acc.metrics.filter((m) => m.measurement === "agent.output");
    expect(outputMetrics.length).toBe(2);

    const local = outputMetrics.find((m) => m.tags.output === "local_store");
    const mqtt = outputMetrics.find((m) => m.tags.output === "mqtt_hub");

    expect(local).toBeDefined();
    expect(local!.fields.write_time_ms).toBe(12.3);
    expect(local!.fields.buffer_size).toBe(500);

    expect(mqtt).toBeDefined();
    expect(mqtt!.fields.write_time_ms).toBe(45.6);
    expect(mqtt!.fields.buffer_size).toBe(200);
  });

  it("collect_memstats=false skips memory metrics", async () => {
    const config = makeConfig({ collect_memstats: false });
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const mem = acc.metrics.find((m) => m.measurement === "agent.memory_usage");
    expect(mem).toBeUndefined();

    // Other metrics still present
    const uptime = acc.metrics.find((m) => m.measurement === "agent.uptime_seconds");
    expect(uptime).toBeDefined();
  });

  it("no per-input/output metrics when stats has none", async () => {
    const config = makeConfig();
    // Default: empty input/output stats
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const inputMetrics = acc.metrics.filter((m) => m.measurement === "agent.input");
    const outputMetrics = acc.metrics.filter((m) => m.measurement === "agent.output");
    expect(inputMetrics.length).toBe(0);
    expect(outputMetrics.length).toBe(0);
  });

  it("config validation: defaults applied", () => {
    const config = InternalConfigSchema.parse({});
    expect(config.collect_memstats).toBe(true);

    const config2 = InternalConfigSchema.parse({ collect_memstats: false });
    expect(config2.collect_memstats).toBe(false);
  });

  it("write_errors and gather_errors counters reflected", async () => {
    const config = makeConfig();
    stats.gatherErrors = 3;
    stats.writeErrors = 7;
    const input = new InternalInput(config, stats);

    await input.gather(acc);

    const gatherErrs = acc.metrics.find((m) => m.measurement === "agent.gather_errors");
    const writeErrs = acc.metrics.find((m) => m.measurement === "agent.write_errors");

    expect(gatherErrs!.fields.value).toBe(3);
    expect(writeErrs!.fields.value).toBe(7);
  });
});
