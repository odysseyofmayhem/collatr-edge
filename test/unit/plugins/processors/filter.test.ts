// Unit tests: Filter processor plugin
// PRD refs: §6 Plugin System (Processor contract), §7 Configuration (Filtering)

import { describe, it, expect } from "bun:test";
import { FilterProcessor, FilterConfigSchema, type FilterConfig } from "@plugins/processors/filter";
import { createMetric, type Metric, type FieldValue } from "@core/metric";
import type { Accumulator } from "@core/accumulator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
  tags?: Record<string, string>;
} = {}): Metric {
  return createMetric({
    name: overrides.name ?? "temperature",
    fields: overrides.fields ?? { value: 23.5 },
    tags: overrides.tags,
    timestamp: 1700000000000000000n,
  });
}

class TestAccumulator implements Accumulator {
  emitted: Metric[] = [];
  errors: Error[] = [];

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    timestamp?: bigint,
  ): void {
    this.emitted.push(createMetric({ name: measurement, fields, tags, timestamp }));
  }

  addMetric(metric: Metric): void {
    this.emitted.push(metric);
  }

  addError(error: Error): void {
    this.errors.push(error);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Filter Processor", () => {
  it("namepass: matching metrics pass, non-matching dropped", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({
      namepass: ["temperature_*"],
    }));
    const acc = new TestAccumulator();

    await proc.process(makeMetric({ name: "temperature_motor" }), acc);
    await proc.process(makeMetric({ name: "pressure_main" }), acc);
    await proc.process(makeMetric({ name: "temperature_oven" }), acc);

    expect(acc.emitted.length).toBe(2);
    expect(acc.emitted[0]!.name).toBe("temperature_motor");
    expect(acc.emitted[1]!.name).toBe("temperature_oven");
  });

  it("namedrop: matching metrics dropped", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({
      namedrop: ["debug_*"],
    }));
    const acc = new TestAccumulator();

    await proc.process(makeMetric({ name: "temperature" }), acc);
    await proc.process(makeMetric({ name: "debug_internal" }), acc);
    await proc.process(makeMetric({ name: "pressure" }), acc);

    expect(acc.emitted.length).toBe(2);
    expect(acc.emitted[0]!.name).toBe("temperature");
    expect(acc.emitted[1]!.name).toBe("pressure");
  });

  it("tagpass: metrics with matching tags pass", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({
      tagpass: { line: ["line_1", "line_2"] },
    }));
    const acc = new TestAccumulator();

    await proc.process(makeMetric({ tags: { line: "line_1" } }), acc);
    await proc.process(makeMetric({ tags: { line: "line_3" } }), acc);
    await proc.process(makeMetric({ tags: { line: "line_2" } }), acc);
    await proc.process(makeMetric({ tags: { host: "gw-01" } }), acc); // missing "line" tag

    expect(acc.emitted.length).toBe(2);
    expect(acc.emitted[0]!.getTag("line")).toBe("line_1");
    expect(acc.emitted[1]!.getTag("line")).toBe("line_2");
  });

  it("Combined namepass + tagdrop: both applied", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({
      namepass: ["sensor_*"],
      tagdrop: { env: ["test"] },
    }));
    const acc = new TestAccumulator();

    // Fails namepass
    await proc.process(makeMetric({ name: "other", tags: { env: "prod" } }), acc);
    // Passes namepass, dropped by tagdrop
    await proc.process(makeMetric({ name: "sensor_1", tags: { env: "test" } }), acc);
    // Passes both
    await proc.process(makeMetric({ name: "sensor_2", tags: { env: "prod" } }), acc);

    expect(acc.emitted.length).toBe(1);
    expect(acc.emitted[0]!.name).toBe("sensor_2");
  });

  it("No filters configured → all metrics pass (no-op)", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({}));
    const acc = new TestAccumulator();

    await proc.process(makeMetric({ name: "anything" }), acc);
    await proc.process(makeMetric({ name: "whatever" }), acc);

    expect(acc.emitted.length).toBe(2);
  });

  it("fieldpass: only specified fields kept", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({
      fieldpass: ["value", "quality"],
    }));
    const acc = new TestAccumulator();

    await proc.process(
      makeMetric({ fields: { value: 23.5, quality: 1, debug: 0, internal: 99 } }),
      acc,
    );

    expect(acc.emitted.length).toBe(1);
    const m = acc.emitted[0]!;
    expect(m.fields.size).toBe(2);
    expect(m.hasField("value")).toBe(true);
    expect(m.hasField("quality")).toBe(true);
    expect(m.hasField("debug")).toBe(false);
    expect(m.hasField("internal")).toBe(false);
  });

  it("All fields filtered → metric dropped entirely", async () => {
    const proc = new FilterProcessor(FilterConfigSchema.parse({
      fieldpass: ["nonexistent"],
    }));
    const acc = new TestAccumulator();

    await proc.process(makeMetric({ fields: { value: 23.5, count: 42 } }), acc);

    expect(acc.emitted.length).toBe(0);
  });
});
