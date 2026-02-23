import { describe, it, expect } from "bun:test";
import { createMetric, type Metric, type FieldValue } from "../../../src/core/metric.ts";

describe("Metric", () => {
  it("created with all 4 field types (number, bigint, string, boolean)", () => {
    const m = createMetric({
      name: "test",
      fields: {
        float_val: 42.5,
        int_val: 100n,
        str_val: "hello",
        bool_val: true,
      },
    });

    expect(m.getField("float_val")).toBe(42.5);
    expect(m.getField("int_val")).toBe(100n);
    expect(m.getField("str_val")).toBe("hello");
    expect(m.getField("bool_val")).toBe(true);
    expect(m.fields.size).toBe(4);
  });

  describe("hashId", () => {
    it("same for same name+tags across calls", () => {
      const m = createMetric({
        name: "temperature",
        fields: { value: 23.5 },
        tags: { device: "sensor-01", area: "line-1" },
      });

      const hash1 = m.hashId();
      const hash2 = m.hashId();
      expect(hash1).toBe(hash2);
    });

    it("same regardless of tag insertion order", () => {
      const m1 = createMetric({
        name: "temperature",
        fields: { value: 23.5 },
        tags: { device: "sensor-01", area: "line-1" },
      });

      const m2 = createMetric({
        name: "temperature",
        fields: { value: 23.5 },
        tags: { area: "line-1", device: "sensor-01" },
      });

      expect(m1.hashId()).toBe(m2.hashId());
    });

    it("differs when name changes", () => {
      const m1 = createMetric({
        name: "temperature",
        fields: { value: 1 },
        tags: { host: "a" },
      });

      const m2 = createMetric({
        name: "pressure",
        fields: { value: 1 },
        tags: { host: "a" },
      });

      expect(m1.hashId()).not.toBe(m2.hashId());
    });

    it("differs when any tag key or value changes", () => {
      const base = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { host: "a", zone: "b" },
      });

      const diffValue = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { host: "CHANGED", zone: "b" },
      });

      const diffKey = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { host: "a", region: "b" },
      });

      expect(base.hashId()).not.toBe(diffValue.hashId());
      expect(base.hashId()).not.toBe(diffKey.hashId());
    });

    it("works with empty tags (base case)", () => {
      const m = createMetric({
        name: "simple_metric",
        fields: { value: 42 },
      });

      const hash1 = m.hashId();
      const hash2 = m.hashId();
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("bigint");
    });

    it("unchanged by field value differences (fields excluded from hash)", () => {
      const m1 = createMetric({
        name: "test",
        fields: { value: 100, count: 1n },
        tags: { host: "a" },
      });

      const m2 = createMetric({
        name: "test",
        fields: { value: 999, count: 999n, extra: "hello" },
        tags: { host: "a" },
      });

      expect(m1.hashId()).toBe(m2.hashId());
    });

    it("stable across tag mutation cycles (add then remove)", () => {
      const m = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { host: "a", zone: "b" },
      });

      const hashBefore = m.hashId();

      // Add a tag, then remove it — hash should return to original
      m.addTag("temp", "xyz");
      expect(m.hashId()).not.toBe(hashBefore);

      m.removeTag("temp");
      expect(m.hashId()).toBe(hashBefore);
    });
  });

  describe("copy", () => {
    it("produces independent instance (mutate copy, original unchanged)", () => {
      const original = createMetric({
        name: "motor_speed",
        fields: { rpm: 1500 },
        tags: { line: "A" },
      });

      const copied = original.copy();

      // Mutate the copy
      copied.addField("rpm", 9999);
      copied.addTag("line", "Z");
      copied.addTag("new_tag", "new_val");

      // Original is unchanged
      expect(original.getField("rpm")).toBe(1500);
      expect(original.getTag("line")).toBe("A");
      expect(original.hasTag("new_tag")).toBe(false);
    });

    it("copy then mutate tags → different hashId", () => {
      const original = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { host: "a" },
      });

      const copied = original.copy();
      copied.addTag("host", "b");

      expect(copied.hashId()).not.toBe(original.hashId());
    });

    it("preserves name, tags, fields, timestamp, type, priority", () => {
      const ts = 1700000000000000000n;
      const original = createMetric({
        name: "vibration",
        fields: { x: 0.5, y: 1.2, label: "normal", active: true, big: 999n },
        tags: { sensor: "vib-01", area: "press" },
        timestamp: ts,
        type: "gauge",
        priority: "high",
      });

      const copied = original.copy();

      expect(copied.name).toBe("vibration");
      expect(copied.timestamp).toBe(ts);
      expect(copied.type).toBe("gauge");
      expect(copied.priority).toBe("high");
      expect(copied.getTag("sensor")).toBe("vib-01");
      expect(copied.getTag("area")).toBe("press");
      expect(copied.getField("x")).toBe(0.5);
      expect(copied.getField("y")).toBe(1.2);
      expect(copied.getField("label")).toBe("normal");
      expect(copied.getField("active")).toBe(true);
      expect(copied.getField("big")).toBe(999n);
    });
  });

  describe("createMetric", () => {
    it("defaults: timestamp set, type=untyped, priority=normal", () => {
      const before = BigInt(Date.now()) * 1_000_000n;
      const m = createMetric({
        name: "test",
        fields: { v: 1 },
      });
      const after = BigInt(Date.now()) * 1_000_000n;

      expect(m.type).toBe("untyped");
      expect(m.priority).toBe("normal");
      // Timestamp should be between before and after (nanoseconds)
      expect(m.timestamp).toBeGreaterThanOrEqual(before);
      expect(m.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("tag sorting", () => {
    it("tags are sorted by key in iteration order", () => {
      const m = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { zebra: "z", alpha: "a", middle: "m" },
      });

      const keys = Array.from(m.tags.keys());
      expect(keys).toEqual(["alpha", "middle", "zebra"]);
    });

    it("tags remain sorted after addTag", () => {
      const m = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { beta: "b", delta: "d" },
      });

      m.addTag("alpha", "a");
      m.addTag("charlie", "c");

      const keys = Array.from(m.tags.keys());
      expect(keys).toEqual(["alpha", "beta", "charlie", "delta"]);
    });
  });

  describe("tracking methods", () => {
    it("accept/reject/drop do not throw", () => {
      const m = createMetric({ name: "test", fields: { v: 1 } });
      expect(() => m.accept()).not.toThrow();
      expect(() => m.reject()).not.toThrow();
      expect(() => m.drop()).not.toThrow();
    });
  });

  describe("tag helpers", () => {
    it("hasTag/getTag/removeTag work correctly", () => {
      const m = createMetric({
        name: "test",
        fields: { v: 1 },
        tags: { host: "pi-01" },
      });

      expect(m.hasTag("host")).toBe(true);
      expect(m.hasTag("missing")).toBe(false);
      expect(m.getTag("host")).toBe("pi-01");
      expect(m.getTag("missing")).toBeUndefined();

      m.removeTag("host");
      expect(m.hasTag("host")).toBe(false);
    });
  });

  describe("field helpers", () => {
    it("hasField/getField/addField/removeField work correctly", () => {
      const m = createMetric({
        name: "test",
        fields: { temp: 22.5 },
      });

      expect(m.hasField("temp")).toBe(true);
      expect(m.hasField("missing")).toBe(false);
      expect(m.getField("temp")).toBe(22.5);
      expect(m.getField("missing")).toBeUndefined();

      m.addField("pressure", 1013.25);
      expect(m.getField("pressure")).toBe(1013.25);

      m.removeField("temp");
      expect(m.hasField("temp")).toBe(false);
    });
  });
});
