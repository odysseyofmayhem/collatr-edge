// Unit tests: Metric filtering framework
// PRD refs: §7 Configuration (Filtering on every plugin)

import { describe, it, expect } from "bun:test";
import {
  MetricFilter,
  MetricFilterSchema,
  globToRegex,
  type MetricFilterConfig,
} from "@core/metric-filter";
import { createMetric, type Metric } from "@core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, number | bigint | string | boolean>;
  tags?: Record<string, string>;
  timestamp?: bigint;
} = {}): Metric {
  return createMetric({
    name: overrides.name ?? "temperature",
    fields: overrides.fields ?? { value: 23.5 },
    tags: overrides.tags,
    timestamp: overrides.timestamp ?? 1700000000000000000n,
  });
}

function makeFilter(config: MetricFilterConfig): MetricFilter {
  return new MetricFilter(MetricFilterSchema.parse(config));
}

// ---------------------------------------------------------------------------
// globToRegex unit tests
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("* matches any sequence of characters", () => {
    const re = globToRegex("temperature_*");
    expect(re.test("temperature_motor")).toBe(true);
    expect(re.test("temperature_oven")).toBe(true);
    expect(re.test("temperature_")).toBe(true);
    expect(re.test("pressure_motor")).toBe(false);
  });

  it("? matches exactly one character", () => {
    const re = globToRegex("temp_?");
    expect(re.test("temp_1")).toBe(true);
    expect(re.test("temp_a")).toBe(true);
    expect(re.test("temp_12")).toBe(false);
    expect(re.test("temp_")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    const re = globToRegex("value.count");
    expect(re.test("value.count")).toBe(true);
    expect(re.test("valuexcount")).toBe(false);
  });

  it("exact match without wildcards", () => {
    const re = globToRegex("temperature");
    expect(re.test("temperature")).toBe(true);
    expect(re.test("temperature_motor")).toBe(false);
    expect(re.test("xtemperature")).toBe(false);
  });

  it("combined * and ?", () => {
    const re = globToRegex("sensor_?_*");
    expect(re.test("sensor_1_value")).toBe(true);
    expect(re.test("sensor_a_temperature")).toBe(true);
    expect(re.test("sensor_12_value")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MetricFilter — no filters configured
// ---------------------------------------------------------------------------

describe("MetricFilter", () => {
  it("no filters configured → metric passes through unchanged", () => {
    const filter = makeFilter({});
    const metric = makeMetric({ name: "anything", fields: { a: 1, b: 2 } });
    const result = filter.apply(metric);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("anything");
    expect(result!.fields.size).toBe(2);
    expect(filter.isNoop).toBe(true);
  });

  it("empty filter arrays → no filtering (pass everything)", () => {
    const filter = makeFilter({
      namepass: [],
      namedrop: [],
      fieldpass: [],
      fielddrop: [],
      tagpass: {},
      tagdrop: {},
    });
    const metric = makeMetric({ name: "anything" });
    const result = filter.apply(metric);
    expect(result).not.toBeNull();
    expect(filter.isNoop).toBe(true);
  });

  // =========================================================================
  // namepass
  // =========================================================================

  describe("namepass", () => {
    it("matching name → passes", () => {
      const filter = makeFilter({ namepass: ["temperature_*"] });
      const metric = makeMetric({ name: "temperature_motor" });
      expect(filter.apply(metric)).not.toBeNull();
    });

    it("non-matching name → dropped", () => {
      const filter = makeFilter({ namepass: ["temperature_*"] });
      const metric = makeMetric({ name: "pressure_motor" });
      expect(filter.apply(metric)).toBeNull();
    });

    it("multiple patterns: matches if any pattern matches", () => {
      const filter = makeFilter({ namepass: ["temp_*", "pressure_*"] });
      expect(filter.apply(makeMetric({ name: "temp_1" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "pressure_2" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "humidity" }))).toBeNull();
    });
  });

  // =========================================================================
  // namedrop
  // =========================================================================

  describe("namedrop", () => {
    it("matching name → dropped", () => {
      const filter = makeFilter({ namedrop: ["debug_*"] });
      const metric = makeMetric({ name: "debug_internal" });
      expect(filter.apply(metric)).toBeNull();
    });

    it("non-matching name → passes", () => {
      const filter = makeFilter({ namedrop: ["debug_*"] });
      const metric = makeMetric({ name: "temperature" });
      expect(filter.apply(metric)).not.toBeNull();
    });
  });

  // =========================================================================
  // namepass + namedrop together
  // =========================================================================

  describe("namepass + namedrop together", () => {
    it("whitelist first, then blacklist", () => {
      const filter = makeFilter({
        namepass: ["temperature_*"],
        namedrop: ["temperature_debug"],
      });

      // Passes namepass, not in namedrop → passes
      expect(filter.apply(makeMetric({ name: "temperature_motor" }))).not.toBeNull();

      // Passes namepass, but in namedrop → dropped
      expect(filter.apply(makeMetric({ name: "temperature_debug" }))).toBeNull();

      // Fails namepass → dropped (never reaches namedrop)
      expect(filter.apply(makeMetric({ name: "pressure" }))).toBeNull();
    });
  });

  // =========================================================================
  // tagpass
  // =========================================================================

  describe("tagpass", () => {
    it("matching tag value → passes", () => {
      const filter = makeFilter({
        tagpass: { line: ["line_1", "line_2"] },
      });
      const metric = makeMetric({
        name: "temperature",
        tags: { line: "line_1", host: "gw-01" },
      });
      expect(filter.apply(metric)).not.toBeNull();
    });

    it("non-matching tag value → dropped", () => {
      const filter = makeFilter({
        tagpass: { line: ["line_1", "line_2"] },
      });
      const metric = makeMetric({
        name: "temperature",
        tags: { line: "line_3" },
      });
      expect(filter.apply(metric)).toBeNull();
    });

    it("metric missing the tag key → dropped", () => {
      const filter = makeFilter({
        tagpass: { line: ["line_1"] },
      });
      const metric = makeMetric({
        name: "temperature",
        tags: { host: "gw-01" },
      });
      expect(filter.apply(metric)).toBeNull();
    });

    it("multiple tag keys: all must match", () => {
      const filter = makeFilter({
        tagpass: { line: ["line_1"], host: ["gw-*"] },
      });

      // Both match
      expect(
        filter.apply(makeMetric({ tags: { line: "line_1", host: "gw-01" } })),
      ).not.toBeNull();

      // line matches, host doesn't
      expect(
        filter.apply(makeMetric({ tags: { line: "line_1", host: "server-01" } })),
      ).toBeNull();

      // host matches, line doesn't
      expect(
        filter.apply(makeMetric({ tags: { line: "line_2", host: "gw-01" } })),
      ).toBeNull();
    });
  });

  // =========================================================================
  // tagdrop
  // =========================================================================

  describe("tagdrop", () => {
    it("matching tag value → dropped", () => {
      const filter = makeFilter({
        tagdrop: { env: ["test"] },
      });
      const metric = makeMetric({
        name: "temperature",
        tags: { env: "test" },
      });
      expect(filter.apply(metric)).toBeNull();
    });

    it("non-matching tag value → passes", () => {
      const filter = makeFilter({
        tagdrop: { env: ["test"] },
      });
      const metric = makeMetric({
        name: "temperature",
        tags: { env: "production" },
      });
      expect(filter.apply(metric)).not.toBeNull();
    });

    it("tag key not present → passes (nothing to drop)", () => {
      const filter = makeFilter({
        tagdrop: { env: ["test"] },
      });
      const metric = makeMetric({
        name: "temperature",
        tags: { host: "gw-01" },
      });
      expect(filter.apply(metric)).not.toBeNull();
    });
  });

  // =========================================================================
  // fieldpass
  // =========================================================================

  describe("fieldpass", () => {
    it("only matching fields kept, others removed", () => {
      const filter = makeFilter({ fieldpass: ["value", "quality"] });
      const metric = makeMetric({
        fields: { value: 23.5, quality: 1, debug_info: "test", count: 42 },
      });
      const result = filter.apply(metric);
      expect(result).not.toBeNull();
      expect(result!.fields.size).toBe(2);
      expect(result!.hasField("value")).toBe(true);
      expect(result!.hasField("quality")).toBe(true);
      expect(result!.hasField("debug_info")).toBe(false);
      expect(result!.hasField("count")).toBe(false);
    });

    it("fieldpass with glob pattern", () => {
      const filter = makeFilter({ fieldpass: ["temp_*"] });
      const metric = makeMetric({
        fields: { temp_motor: 23.5, temp_oven: 100, pressure: 1.5 },
      });
      const result = filter.apply(metric);
      expect(result).not.toBeNull();
      expect(result!.fields.size).toBe(2);
      expect(result!.hasField("temp_motor")).toBe(true);
      expect(result!.hasField("temp_oven")).toBe(true);
      expect(result!.hasField("pressure")).toBe(false);
    });

    it("removes all fields → metric dropped entirely", () => {
      const filter = makeFilter({ fieldpass: ["nonexistent_*"] });
      const metric = makeMetric({
        fields: { value: 23.5, count: 42 },
      });
      expect(filter.apply(metric)).toBeNull();
    });
  });

  // =========================================================================
  // fielddrop
  // =========================================================================

  describe("fielddrop", () => {
    it("matching fields removed, others kept", () => {
      const filter = makeFilter({ fielddrop: ["debug_*"] });
      const metric = makeMetric({
        fields: { value: 23.5, debug_info: "test", debug_count: 42 },
      });
      const result = filter.apply(metric);
      expect(result).not.toBeNull();
      expect(result!.fields.size).toBe(1);
      expect(result!.hasField("value")).toBe(true);
      expect(result!.hasField("debug_info")).toBe(false);
      expect(result!.hasField("debug_count")).toBe(false);
    });

    it("no fields match → all kept", () => {
      const filter = makeFilter({ fielddrop: ["nonexistent"] });
      const metric = makeMetric({
        fields: { value: 23.5, count: 42 },
      });
      const result = filter.apply(metric);
      expect(result).not.toBeNull();
      expect(result!.fields.size).toBe(2);
    });

    it("all fields dropped → metric dropped entirely", () => {
      const filter = makeFilter({ fielddrop: ["*"] });
      const metric = makeMetric({
        fields: { value: 23.5 },
      });
      expect(filter.apply(metric)).toBeNull();
    });
  });

  // =========================================================================
  // Glob wildcard edge cases
  // =========================================================================

  describe("glob wildcards", () => {
    it("* matches temperature_motor", () => {
      const filter = makeFilter({ namepass: ["temperature_*"] });
      expect(filter.apply(makeMetric({ name: "temperature_motor" }))).not.toBeNull();
    });

    it("? matches temp_1 but not temp_12", () => {
      const filter = makeFilter({ namepass: ["temp_?"] });
      expect(filter.apply(makeMetric({ name: "temp_1" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "temp_a" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "temp_12" }))).toBeNull();
    });

    it("multiple patterns: [temp_*, pressure_*] matches either", () => {
      const filter = makeFilter({ namepass: ["temp_*", "pressure_*"] });
      expect(filter.apply(makeMetric({ name: "temp_1" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "pressure_main" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "humidity" }))).toBeNull();
    });
  });

  // =========================================================================
  // Case sensitivity
  // =========================================================================

  describe("case sensitivity", () => {
    it("case-sensitive matching: Temperature ≠ temperature", () => {
      const filter = makeFilter({ namepass: ["temperature"] });
      expect(filter.apply(makeMetric({ name: "temperature" }))).not.toBeNull();
      expect(filter.apply(makeMetric({ name: "Temperature" }))).toBeNull();
      expect(filter.apply(makeMetric({ name: "TEMPERATURE" }))).toBeNull();
    });
  });

  // =========================================================================
  // Combined filter evaluation order
  // =========================================================================

  describe("evaluation order", () => {
    it("namepass → namedrop → tagpass → tagdrop → fieldpass → fielddrop", () => {
      const filter = makeFilter({
        namepass: ["sensor_*"],
        namedrop: ["sensor_debug"],
        tagpass: { line: ["line_1"] },
        tagdrop: { env: ["test"] },
        fieldpass: ["value", "quality"],
      });

      // Fails namepass
      expect(filter.apply(makeMetric({ name: "other", tags: { line: "line_1" } }))).toBeNull();

      // Passes namepass, fails namedrop
      expect(filter.apply(makeMetric({ name: "sensor_debug", tags: { line: "line_1" } }))).toBeNull();

      // Passes namepass, passes namedrop, fails tagpass (wrong line)
      expect(
        filter.apply(makeMetric({ name: "sensor_1", tags: { line: "line_2" } })),
      ).toBeNull();

      // Passes namepass, namedrop, tagpass, fails tagdrop
      expect(
        filter.apply(makeMetric({
          name: "sensor_1",
          tags: { line: "line_1", env: "test" },
        })),
      ).toBeNull();

      // Passes all name/tag filters, fieldpass trims fields
      const metric = makeMetric({
        name: "sensor_1",
        fields: { value: 23.5, quality: 1, debug: "x" },
        tags: { line: "line_1", env: "production" },
      });
      const result = filter.apply(metric);
      expect(result).not.toBeNull();
      expect(result!.fields.size).toBe(2);
      expect(result!.hasField("value")).toBe(true);
      expect(result!.hasField("quality")).toBe(true);
      expect(result!.hasField("debug")).toBe(false);
    });
  });

  // =========================================================================
  // Config validation
  // =========================================================================

  describe("config validation", () => {
    it("empty config is valid", () => {
      expect(() => MetricFilterSchema.parse({})).not.toThrow();
    });

    it("all fields optional", () => {
      const config = MetricFilterSchema.parse({
        namepass: ["test_*"],
        tagdrop: { env: ["test"] },
      });
      expect(config.namepass).toEqual(["test_*"]);
      expect(config.tagdrop).toEqual({ env: ["test"] });
      expect(config.namedrop).toBeUndefined();
    });
  });
});
