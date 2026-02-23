// Unit tests: Rename processor plugin
// PRD refs: §6 Plugin System (Processor contract), §19 MVP Plugin Inventory

import { describe, it, expect } from "bun:test";
import {
  RenameProcessor,
  RenameConfigSchema,
  type RenameConfig,
} from "@plugins/processors/rename";
import { createMetric, type Metric, type FieldValue } from "@core/metric";
import type { Accumulator } from "@core/accumulator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): RenameConfig {
  return RenameConfigSchema.parse(overrides);
}

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
  tags?: Record<string, string>;
} = {}): Metric {
  return createMetric({
    name: overrides.name ?? "sensor_data",
    fields: overrides.fields ?? { temperature: 23.5 },
    tags: overrides.tags,
    timestamp: 1700000000000000000n,
  });
}

/** Collecting accumulator for testing processor output. */
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

describe("Rename Processor", () => {
  // =========================================================================
  // Field rename
  // =========================================================================

  it("rename field: temperature → motor_temp_c", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [{ field: "temperature", dest: "motor_temp_c" }],
    }));
    const metric = makeMetric({ fields: { temperature: 23.5, pressure: 1.5 } });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    expect(acc.emitted.length).toBe(1);
    const m = acc.emitted[0]!;
    expect(m.hasField("motor_temp_c")).toBe(true);
    expect(m.getField("motor_temp_c")).toBe(23.5);
    expect(m.hasField("temperature")).toBe(false);
  });

  it("rename doesn't affect other fields", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [{ field: "temperature", dest: "motor_temp_c" }],
    }));
    const metric = makeMetric({
      fields: { temperature: 23.5, pressure: 1.5, humidity: 45.0 },
    });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    const m = acc.emitted[0]!;
    expect(m.getField("pressure")).toBe(1.5);
    expect(m.getField("humidity")).toBe(45.0);
    expect(m.fields.size).toBe(3);
  });

  // =========================================================================
  // Tag rename
  // =========================================================================

  it("rename tag: host → hostname", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [{ tag: "host", dest: "hostname" }],
    }));
    const metric = makeMetric({
      tags: { host: "gw-01", region: "uk" },
    });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    expect(acc.emitted.length).toBe(1);
    const m = acc.emitted[0]!;
    expect(m.hasTag("hostname")).toBe(true);
    expect(m.getTag("hostname")).toBe("gw-01");
    expect(m.hasTag("host")).toBe(false);
    // Other tags preserved
    expect(m.getTag("region")).toBe("uk");
  });

  it("tag rename: hashId changes (tags re-sorted)", async () => {
    const metric = makeMetric({
      tags: { aaa: "1", host: "gw-01" },
    });
    const hashBefore = metric.hashId();

    const proc = new RenameProcessor(makeConfig({
      replace: [{ tag: "host", dest: "zzz_hostname" }],
    }));
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    const m = acc.emitted[0]!;
    // Tag sort order changed: "aaa" + "zzz_hostname" vs "aaa" + "host"
    const hashAfter = m.hashId();
    expect(hashAfter).not.toBe(hashBefore);
    // Tags are sorted: aaa before zzz_hostname
    const tagKeys = Array.from(m.tags.keys());
    expect(tagKeys).toEqual(["aaa", "zzz_hostname"]);
  });

  // =========================================================================
  // Missing source field/tag
  // =========================================================================

  it("source field not present → rule skipped, metric still forwarded", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [{ field: "nonexistent", dest: "renamed" }],
    }));
    const metric = makeMetric({ fields: { temperature: 23.5 } });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    expect(acc.emitted.length).toBe(1);
    const m = acc.emitted[0]!;
    // Original field unchanged, no "renamed" field added
    expect(m.getField("temperature")).toBe(23.5);
    expect(m.hasField("renamed")).toBe(false);
    expect(m.fields.size).toBe(1);
  });

  it("source tag not present → rule skipped, metric still forwarded", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [{ tag: "nonexistent", dest: "renamed" }],
    }));
    const metric = makeMetric({ tags: { host: "gw-01" } });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    expect(acc.emitted.length).toBe(1);
    const m = acc.emitted[0]!;
    expect(m.getTag("host")).toBe("gw-01");
    expect(m.hasTag("renamed")).toBe(false);
  });

  // =========================================================================
  // Multiple rename rules
  // =========================================================================

  it("multiple rename rules applied in order", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [
        { field: "temperature", dest: "temp_c" },
        { field: "pressure", dest: "press_bar" },
        { tag: "host", dest: "hostname" },
      ],
    }));
    const metric = makeMetric({
      fields: { temperature: 23.5, pressure: 1.5 },
      tags: { host: "gw-01" },
    });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    expect(acc.emitted.length).toBe(1);
    const m = acc.emitted[0]!;
    expect(m.getField("temp_c")).toBe(23.5);
    expect(m.getField("press_bar")).toBe(1.5);
    expect(m.hasField("temperature")).toBe(false);
    expect(m.hasField("pressure")).toBe(false);
    expect(m.getTag("hostname")).toBe("gw-01");
    expect(m.hasTag("host")).toBe(false);
  });

  it("chained rename: field A → B → C in sequence", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [
        { field: "a", dest: "b" },
        { field: "b", dest: "c" },
      ],
    }));
    const metric = makeMetric({ fields: { a: 1.0 } });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    const m = acc.emitted[0]!;
    // Rule 1: a → b. Rule 2: b → c. Final: only "c" exists.
    expect(m.hasField("a")).toBe(false);
    expect(m.hasField("b")).toBe(false);
    expect(m.getField("c")).toBe(1.0);
  });

  // =========================================================================
  // Explicit emit (processor contract)
  // =========================================================================

  it("metric forwarded via acc.addMetric() (explicit emit)", async () => {
    // Even with no replace rules, metric is still forwarded
    const proc = new RenameProcessor(makeConfig({ replace: [] }));
    const metric = makeMetric({ fields: { value: 42 } });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    expect(acc.emitted.length).toBe(1);
    expect(acc.emitted[0]!.getField("value")).toBe(42);
  });

  // =========================================================================
  // Field value types preserved
  // =========================================================================

  it("rename preserves field value types", async () => {
    const proc = new RenameProcessor(makeConfig({
      replace: [
        { field: "num_field", dest: "renamed_num" },
        { field: "str_field", dest: "renamed_str" },
        { field: "bool_field", dest: "renamed_bool" },
        { field: "bigint_field", dest: "renamed_bigint" },
      ],
    }));
    const metric = makeMetric({
      fields: {
        num_field: 23.5,
        str_field: "hello",
        bool_field: true,
        bigint_field: 9007199254740993n,
      },
    });
    const acc = new TestAccumulator();

    await proc.process(metric, acc);

    const m = acc.emitted[0]!;
    expect(m.getField("renamed_num")).toBe(23.5);
    expect(m.getField("renamed_str")).toBe("hello");
    expect(m.getField("renamed_bool")).toBe(true);
    expect(m.getField("renamed_bigint")).toBe(9007199254740993n);
  });

  // =========================================================================
  // Config validation
  // =========================================================================

  describe("config validation", () => {
    it("empty replace array is valid", () => {
      const config = RenameConfigSchema.parse({ replace: [] });
      expect(config.replace).toEqual([]);
    });

    it("replace defaults to empty array", () => {
      const config = RenameConfigSchema.parse({});
      expect(config.replace).toEqual([]);
    });

    it("dest is required in replace rules", () => {
      expect(() =>
        RenameConfigSchema.parse({ replace: [{ field: "a" }] }),
      ).toThrow();
    });

    it("valid config with field + dest", () => {
      const config = RenameConfigSchema.parse({
        replace: [{ field: "temperature", dest: "motor_temp_c" }],
      });
      expect(config.replace.length).toBe(1);
      expect(config.replace[0]!.field).toBe("temperature");
      expect(config.replace[0]!.dest).toBe("motor_temp_c");
    });

    it("valid config with tag + dest", () => {
      const config = RenameConfigSchema.parse({
        replace: [{ tag: "host", dest: "hostname" }],
      });
      expect(config.replace[0]!.tag).toBe("host");
    });

    it("rejects rule with neither field nor tag", () => {
      expect(() =>
        RenameConfigSchema.parse({ replace: [{ dest: "foo" }] }),
      ).toThrow();
    });

    it("rejects rule with both field and tag", () => {
      expect(() =>
        RenameConfigSchema.parse({
          replace: [{ field: "temperature", tag: "host", dest: "renamed" }],
        }),
      ).toThrow();
    });
  });
});
