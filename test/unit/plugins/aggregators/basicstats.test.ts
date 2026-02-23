// Unit tests: Basicstats aggregator plugin
// PRD refs: §6 Plugin System (Aggregator contract), §19 MVP Plugin Inventory

import { describe, it, expect } from "bun:test";
import {
  BasicstatsAggregator,
  BasicstatsConfigSchema,
  type BasicstatsConfig,
} from "@plugins/aggregators/basicstats";
import { createMetric, type Metric, type FieldValue } from "@core/metric";
import type { Accumulator } from "@core/accumulator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): BasicstatsConfig {
  return BasicstatsConfigSchema.parse(overrides);
}

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
  tags?: Record<string, string>;
} = {}): Metric {
  return createMetric({
    name: overrides.name ?? "sensor",
    fields: overrides.fields ?? { value: 1.0 },
    tags: overrides.tags,
    timestamp: 1700000000000000000n,
  });
}

class TestAccumulator implements Accumulator {
  emitted: { name: string; fields: Record<string, FieldValue>; tags: Record<string, string> }[] = [];
  errors: Error[] = [];

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
    _timestamp?: bigint,
  ): void {
    this.emitted.push({ name: measurement, fields: { ...fields }, tags: { ...(tags ?? {}) } });
  }

  addMetric(metric: Metric): void {
    const fields: Record<string, FieldValue> = {};
    for (const [k, v] of metric.fields) fields[k] = v;
    const tags: Record<string, string> = {};
    for (const [k, v] of metric.tags) tags[k] = v;
    this.emitted.push({ name: metric.name, fields, tags });
  }

  addError(error: Error): void {
    this.errors.push(error);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Basicstats Aggregator", () => {
  // =========================================================================
  // Core statistics
  // =========================================================================

  it("10 numeric values → correct min, max, mean, count, sum", () => {
    const agg = new BasicstatsAggregator(makeConfig());
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    for (const v of values) {
      agg.add(makeMetric({ fields: { value: v } }));
    }

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    const f = acc.emitted[0]!.fields;
    expect(f.value_count).toBe(10);
    expect(f.value_min).toBe(10);
    expect(f.value_max).toBe(100);
    expect(f.value_sum).toBe(550);
    expect(f.value_mean).toBe(55);
  });

  it("single value: min=max=mean=value, count=1, variance=0, stdev=0", () => {
    const agg = new BasicstatsAggregator(makeConfig({
      stats: ["count", "min", "max", "mean", "sum", "variance", "stdev"],
    }));

    agg.add(makeMetric({ fields: { value: 42.5 } }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    const f = acc.emitted[0]!.fields;
    expect(f.value_count).toBe(1);
    expect(f.value_min).toBe(42.5);
    expect(f.value_max).toBe(42.5);
    expect(f.value_mean).toBe(42.5);
    expect(f.value_sum).toBe(42.5);
    expect(f.value_variance).toBe(0);
    expect(f.value_stdev).toBe(0);
  });

  // =========================================================================
  // Variance and stdev (Welford's algorithm)
  // =========================================================================

  it("variance and stdev correct (Welford's algorithm)", () => {
    const agg = new BasicstatsAggregator(makeConfig({
      stats: ["count", "mean", "variance", "stdev"],
    }));

    // Values: 2, 4, 4, 4, 5, 5, 7, 9
    // Population mean = 5.0
    // Population variance = ((2-5)² + (4-5)² + (4-5)² + (4-5)² + (5-5)² + (5-5)² + (7-5)² + (9-5)²) / 8
    //                     = (9 + 1 + 1 + 1 + 0 + 0 + 4 + 16) / 8 = 32 / 8 = 4.0
    // Population stdev = sqrt(4.0) = 2.0
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    for (const v of values) {
      agg.add(makeMetric({ fields: { value: v } }));
    }

    const acc = new TestAccumulator();
    agg.push(acc);

    const f = acc.emitted[0]!.fields;
    expect(f.value_count).toBe(8);
    expect(f.value_mean).toBe(5.0);
    expect(f.value_variance).toBeCloseTo(4.0, 10);
    expect(f.value_stdev).toBeCloseTo(2.0, 10);
  });

  // =========================================================================
  // Multiple series
  // =========================================================================

  it("multiple series (different tags) → separate stats per series", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    // Series A: host=gw-01
    agg.add(makeMetric({ fields: { value: 10 }, tags: { host: "gw-01" } }));
    agg.add(makeMetric({ fields: { value: 20 }, tags: { host: "gw-01" } }));

    // Series B: host=gw-02
    agg.add(makeMetric({ fields: { value: 100 }, tags: { host: "gw-02" } }));
    agg.add(makeMetric({ fields: { value: 200 }, tags: { host: "gw-02" } }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(2);

    // Find each series by tags
    const seriesA = acc.emitted.find(e => e.tags.host === "gw-01")!;
    const seriesB = acc.emitted.find(e => e.tags.host === "gw-02")!;

    expect(seriesA).toBeDefined();
    expect(seriesB).toBeDefined();

    expect(seriesA.fields.value_count).toBe(2);
    expect(seriesA.fields.value_mean).toBe(15);
    expect(seriesA.fields.value_min).toBe(10);
    expect(seriesA.fields.value_max).toBe(20);

    expect(seriesB.fields.value_count).toBe(2);
    expect(seriesB.fields.value_mean).toBe(150);
    expect(seriesB.fields.value_min).toBe(100);
    expect(seriesB.fields.value_max).toBe(200);
  });

  // =========================================================================
  // Mixed field types
  // =========================================================================

  it("mixed field types: number aggregated, string/boolean ignored", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    agg.add(makeMetric({
      fields: { temperature: 23.5, label: "sensor-1", active: true },
    }));
    agg.add(makeMetric({
      fields: { temperature: 24.5, label: "sensor-1", active: false },
    }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    const f = acc.emitted[0]!.fields;

    // Numeric field aggregated
    expect(f.temperature_count).toBe(2);
    expect(f.temperature_mean).toBe(24);

    // String and boolean fields NOT aggregated — no label_* or active_* fields
    expect(f.label_count).toBeUndefined();
    expect(f.active_count).toBeUndefined();
  });

  // =========================================================================
  // BigInt fields
  // =========================================================================

  it("BigInt field aggregated (converted to Number)", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    agg.add(makeMetric({ fields: { counter: 100n } }));
    agg.add(makeMetric({ fields: { counter: 200n } }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    const f = acc.emitted[0]!.fields;
    expect(f.counter_count).toBe(2);
    expect(f.counter_sum).toBe(300);
    expect(f.counter_mean).toBe(150);
  });

  // =========================================================================
  // Empty window
  // =========================================================================

  it("empty window → push() emits nothing", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(0);
  });

  // =========================================================================
  // reset()
  // =========================================================================

  it("reset() clears state — next push() reflects only new data", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    // Window 1
    agg.add(makeMetric({ fields: { value: 10 } }));
    agg.add(makeMetric({ fields: { value: 20 } }));

    const acc1 = new TestAccumulator();
    agg.push(acc1);
    agg.reset();

    // Window 2 — new data only
    agg.add(makeMetric({ fields: { value: 100 } }));

    const acc2 = new TestAccumulator();
    agg.push(acc2);

    // Window 1 stats
    expect(acc1.emitted[0]!.fields.value_count).toBe(2);
    expect(acc1.emitted[0]!.fields.value_mean).toBe(15);

    // Window 2 stats — only the new value
    expect(acc2.emitted[0]!.fields.value_count).toBe(1);
    expect(acc2.emitted[0]!.fields.value_mean).toBe(100);
  });

  it("reset() then push() with no new data → emits nothing", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    agg.add(makeMetric({ fields: { value: 10 } }));
    agg.push(new TestAccumulator());
    agg.reset();

    const acc = new TestAccumulator();
    agg.push(acc);
    expect(acc.emitted.length).toBe(0);
  });

  // =========================================================================
  // Configurable stats selection
  // =========================================================================

  it("stats config: stats=[count, mean] → only count and mean emitted", () => {
    const agg = new BasicstatsAggregator(makeConfig({
      stats: ["count", "mean"],
    }));

    agg.add(makeMetric({ fields: { value: 10 } }));
    agg.add(makeMetric({ fields: { value: 20 } }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    const f = acc.emitted[0]!.fields;

    // Requested stats present
    expect(f.value_count).toBe(2);
    expect(f.value_mean).toBe(15);

    // Non-requested stats absent
    expect(f.value_min).toBeUndefined();
    expect(f.value_max).toBeUndefined();
    expect(f.value_sum).toBeUndefined();
    expect(f.value_variance).toBeUndefined();
    expect(f.value_stdev).toBeUndefined();
  });

  // =========================================================================
  // Summary metric naming and tags
  // =========================================================================

  it("summary field names: {field}_min, {field}_max, {field}_mean, etc.", () => {
    const agg = new BasicstatsAggregator(makeConfig({
      stats: ["count", "min", "max", "sum", "mean", "variance", "stdev"],
    }));

    agg.add(makeMetric({ fields: { temperature: 20, pressure: 1.0 } }));
    agg.add(makeMetric({ fields: { temperature: 30, pressure: 2.0 } }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    const f = acc.emitted[0]!.fields;

    // temperature stats
    expect(f.temperature_count).toBeDefined();
    expect(f.temperature_min).toBeDefined();
    expect(f.temperature_max).toBeDefined();
    expect(f.temperature_sum).toBeDefined();
    expect(f.temperature_mean).toBeDefined();
    expect(f.temperature_variance).toBeDefined();
    expect(f.temperature_stdev).toBeDefined();

    // pressure stats
    expect(f.pressure_count).toBeDefined();
    expect(f.pressure_min).toBeDefined();
    expect(f.pressure_max).toBeDefined();
    expect(f.pressure_sum).toBeDefined();
    expect(f.pressure_mean).toBeDefined();
    expect(f.pressure_variance).toBeDefined();
    expect(f.pressure_stdev).toBeDefined();
  });

  it("summary metric preserves original tags", () => {
    const agg = new BasicstatsAggregator(makeConfig());

    agg.add(makeMetric({
      name: "motor_speed",
      fields: { value: 1500 },
      tags: { host: "gw-01", line: "3" },
    }));

    const acc = new TestAccumulator();
    agg.push(acc);

    expect(acc.emitted.length).toBe(1);
    expect(acc.emitted[0]!.name).toBe("motor_speed");
    expect(acc.emitted[0]!.tags.host).toBe("gw-01");
    expect(acc.emitted[0]!.tags.line).toBe("3");
  });

  // =========================================================================
  // Per-plugin filtering (namepass/namedrop)
  // =========================================================================

  it("namepass on aggregator: only matching metrics accumulated", () => {
    const agg = new BasicstatsAggregator(makeConfig({
      namepass: ["motor_*"],
    }));

    agg.add(makeMetric({ name: "motor_speed", fields: { value: 1500 } }));
    agg.add(makeMetric({ name: "temperature", fields: { value: 23.5 } }));
    agg.add(makeMetric({ name: "motor_temp", fields: { value: 85.0 } }));

    const acc = new TestAccumulator();
    agg.push(acc);

    // Only motor_* series accumulated
    expect(acc.emitted.length).toBe(2);
    const names = acc.emitted.map(e => e.name).sort();
    expect(names).toEqual(["motor_speed", "motor_temp"]);
  });

  // =========================================================================
  // Config validation
  // =========================================================================

  describe("config validation", () => {
    it("defaults: period=60s, drop_original=false, stats=5 defaults", () => {
      const config = BasicstatsConfigSchema.parse({});
      expect(config.period).toBe("60s");
      expect(config.drop_original).toBe(false);
      expect(config.stats).toEqual(["count", "min", "max", "sum", "mean"]);
    });

    it("custom stats selection", () => {
      const config = BasicstatsConfigSchema.parse({ stats: ["count", "mean"] });
      expect(config.stats).toEqual(["count", "mean"]);
    });

    it("rejects invalid stat name", () => {
      expect(() => BasicstatsConfigSchema.parse({ stats: ["invalid"] })).toThrow();
    });

    it("period is a string (validated by caller, not by aggregator)", () => {
      const config = BasicstatsConfigSchema.parse({ period: "30s" });
      expect(config.period).toBe("30s");
    });
  });
});
