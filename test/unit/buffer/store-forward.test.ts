// Unit tests: Store-and-forward buffer
// PRD refs: §12 Buffers & Delivery Guarantees

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  StoreForwardBuffer,
  StoreForwardConfigSchema,
  type StoreForwardConfig,
  encodeMetric,
  decodeMetric,
} from "@buffer/store-forward";
import { createMetric, type Metric, type FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-buffer-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): StoreForwardConfig {
  return StoreForwardConfigSchema.parse({
    metric_buffer_limit: 10000,
    metric_batch_size: 1000,
    ...overrides,
  });
}

function dbPath(): string {
  return join(tempDir, "buffer.db");
}

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
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

function openBuffer(alias = "test_output", config?: StoreForwardConfig): StoreForwardBuffer {
  const buf = new StoreForwardBuffer(alias, dbPath(), config ?? makeConfig());
  buf.open();
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Store-and-Forward Buffer", () => {

  // =========================================================================
  // Core add/read
  // =========================================================================

  it("add() persists metrics to SQLite buffer table", () => {
    const buf = openBuffer();

    buf.add([
      makeMetric({ name: "temp", fields: { value: 23.5 }, tags: { sensor: "s1" } }),
      makeMetric({ name: "pressure", fields: { value: 101.3 }, tags: { sensor: "s2" } }),
    ]);

    // Verify via beginTransaction
    const tx = buf.beginTransaction(10);
    expect(tx.metrics().length).toBe(2);
    expect(tx.metrics()[0]!.name).toBe("temp");
    expect(tx.metrics()[1]!.name).toBe("pressure");

    buf.close();
  });

  it("beginTransaction() returns oldest N metrics in order", () => {
    const buf = openBuffer();

    // Add 5 metrics with ascending timestamps
    for (let i = 0; i < 5; i++) {
      buf.add([makeMetric({
        name: `metric_${i}`,
        fields: { value: i },
        timestamp: 1700000000000000000n + BigInt(i) * 1000000000n,
      })]);
    }

    // Request 3 — should get the oldest 3
    const tx = buf.beginTransaction(3);
    expect(tx.metrics().length).toBe(3);
    expect(tx.metrics()[0]!.name).toBe("metric_0");
    expect(tx.metrics()[1]!.name).toBe("metric_1");
    expect(tx.metrics()[2]!.name).toBe("metric_2");

    buf.close();
  });

  // =========================================================================
  // Transaction model
  // =========================================================================

  it("acceptAll() removes all transaction metrics from buffer", () => {
    const buf = openBuffer();

    buf.add([
      makeMetric({ name: "m1" }),
      makeMetric({ name: "m2" }),
      makeMetric({ name: "m3" }),
    ]);
    expect(buf.length).toBe(3);

    const tx = buf.beginTransaction(10);
    tx.acceptAll();

    expect(buf.length).toBe(0);

    // Buffer should be empty
    const tx2 = buf.beginTransaction(10);
    expect(tx2.metrics().length).toBe(0);

    buf.close();
  });

  it("keepAll() leaves all metrics for retry (buffer unchanged)", () => {
    const buf = openBuffer();

    buf.add([
      makeMetric({ name: "m1" }),
      makeMetric({ name: "m2" }),
    ]);
    expect(buf.length).toBe(2);

    const tx = buf.beginTransaction(10);
    tx.keepAll(); // no-op

    expect(buf.length).toBe(2);

    // Metrics still available
    const tx2 = buf.beginTransaction(10);
    expect(tx2.metrics().length).toBe(2);
    expect(tx2.metrics()[0]!.name).toBe("m1");
    expect(tx2.metrics()[1]!.name).toBe("m2");

    buf.close();
  });

  it("accept(indices) removes selected metrics, keeps others", () => {
    const buf = openBuffer();

    buf.add([
      makeMetric({ name: "m0" }),
      makeMetric({ name: "m1" }),
      makeMetric({ name: "m2" }),
      makeMetric({ name: "m3" }),
      makeMetric({ name: "m4" }),
    ]);

    const tx = buf.beginTransaction(10);
    // Accept indices 0, 2, 4 (m0, m2, m4 succeeded)
    tx.accept([0, 2, 4]);

    expect(buf.length).toBe(2);

    // Remaining should be m1 and m3
    const tx2 = buf.beginTransaction(10);
    expect(tx2.metrics().length).toBe(2);
    expect(tx2.metrics()[0]!.name).toBe("m1");
    expect(tx2.metrics()[1]!.name).toBe("m3");

    buf.close();
  });

  it("reject(indices) removes rejected metrics (won't retry)", () => {
    const buf = openBuffer();

    buf.add([
      makeMetric({ name: "m0" }),
      makeMetric({ name: "m1" }),
      makeMetric({ name: "m2" }),
    ]);

    const tx = buf.beginTransaction(10);
    // Reject index 1 (m1 permanently failed — bad format, etc.)
    tx.reject([1]);

    expect(buf.length).toBe(2);

    // m0 and m2 remain for retry
    const tx2 = buf.beginTransaction(10);
    expect(tx2.metrics().length).toBe(2);
    expect(tx2.metrics()[0]!.name).toBe("m0");
    expect(tx2.metrics()[1]!.name).toBe("m2");

    buf.close();
  });

  it("acceptAll() handles batch > 999 (SQLite parameter limit)", () => {
    const buf = openBuffer("test", makeConfig({
      metric_buffer_limit: 20000,
      metric_batch_size: 1500,
    }));

    // Add 1500 metrics — exceeds SQLite's default 999-parameter limit
    const metrics = Array.from({ length: 1500 }, (_, i) =>
      makeMetric({ name: `m${i}`, fields: { value: i } }),
    );
    buf.add(metrics);
    expect(buf.length).toBe(1500);

    const tx = buf.beginTransaction(1500);
    expect(tx.metrics().length).toBe(1500);

    // This would crash without chunked deletes
    tx.acceptAll();
    expect(buf.length).toBe(0);

    buf.close();
  });

  // =========================================================================
  // Overflow policies
  // =========================================================================

  it("Buffer limit (drop_oldest): oldest dropped when limit exceeded", () => {
    const buf = openBuffer("test", makeConfig({
      metric_buffer_limit: 100,
      overflow_policy: "drop_oldest",
    }));

    // Add 100 metrics (at limit)
    for (let i = 0; i < 100; i++) {
      buf.add([makeMetric({ name: `m${i}` })]);
    }
    expect(buf.length).toBe(100);

    // Add 3 more — oldest 3 should be dropped
    buf.add([
      makeMetric({ name: "new_0" }),
      makeMetric({ name: "new_1" }),
      makeMetric({ name: "new_2" }),
    ]);
    expect(buf.length).toBe(100);

    // Adding 3 to buffer of 100 gives 103, excess = 3, oldest 3 (m0, m1, m2) deleted
    const tx = buf.beginTransaction(200);
    expect(tx.metrics().length).toBe(100);
    expect(tx.metrics()[0]!.name).toBe("m3");
    expect(tx.metrics()[1]!.name).toBe("m4");
    expect(tx.metrics()[2]!.name).toBe("m5");

    buf.close();
  });

  it("disk_spill: metrics persist to SQLite, oldest dropped only at limit", () => {
    const buf = openBuffer("test", makeConfig({
      metric_buffer_limit: 100,
      overflow_policy: "disk_spill",
    }));

    // Add 98 metrics (under limit) — all should be kept
    for (let i = 0; i < 98; i++) {
      buf.add([makeMetric({ name: `m${i}` })]);
    }
    expect(buf.length).toBe(98);

    // Add 5 more — total 103, exceeds limit of 100, oldest 3 dropped
    buf.add([
      makeMetric({ name: "new_0" }),
      makeMetric({ name: "new_1" }),
      makeMetric({ name: "new_2" }),
      makeMetric({ name: "new_3" }),
      makeMetric({ name: "new_4" }),
    ]);
    expect(buf.length).toBe(100);

    // Verify oldest were dropped (m0, m1, m2 gone)
    const tx = buf.beginTransaction(200);
    expect(tx.metrics()[0]!.name).toBe("m3");
    expect(tx.metrics()[1]!.name).toBe("m4");
    expect(tx.metrics()[2]!.name).toBe("m5");

    buf.close();
  });

  // =========================================================================
  // Recovery
  // =========================================================================

  it("Recovery: metrics written → close → reopen → metrics still in buffer", () => {
    // First session: add metrics
    const buf1 = openBuffer();
    buf1.add([
      makeMetric({ name: "survivor_1", fields: { value: 1 } }),
      makeMetric({ name: "survivor_2", fields: { value: 2 } }),
    ]);
    buf1.close();

    // Second session: reopen — metrics should still be there
    const buf2 = new StoreForwardBuffer("test_output", dbPath(), makeConfig());
    buf2.open();

    expect(buf2.length).toBe(2);

    const tx = buf2.beginTransaction(10);
    expect(tx.metrics().length).toBe(2);
    expect(tx.metrics()[0]!.name).toBe("survivor_1");
    expect(tx.metrics()[0]!.fields.get("value")).toBe(1);
    expect(tx.metrics()[1]!.name).toBe("survivor_2");
    expect(tx.metrics()[1]!.fields.get("value")).toBe(2);

    buf2.close();
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it("Empty buffer: beginTransaction returns empty batch", () => {
    const buf = openBuffer();

    const tx = buf.beginTransaction(10);
    expect(tx.metrics().length).toBe(0);

    // acceptAll on empty is a no-op
    tx.acceptAll();
    expect(buf.length).toBe(0);

    buf.close();
  });

  it("Buffer length tracks current count accurately", () => {
    const buf = openBuffer();

    expect(buf.length).toBe(0);

    buf.add([makeMetric({ name: "m1" }), makeMetric({ name: "m2" })]);
    expect(buf.length).toBe(2);

    buf.add([makeMetric({ name: "m3" })]);
    expect(buf.length).toBe(3);

    // Accept 1 metric
    const tx = buf.beginTransaction(1);
    tx.acceptAll();
    expect(buf.length).toBe(2);

    // Accept remaining
    const tx2 = buf.beginTransaction(10);
    tx2.acceptAll();
    expect(buf.length).toBe(0);

    buf.close();
  });

  it("Multiple add() calls → beginTransaction returns all in order", () => {
    const buf = openBuffer();

    buf.add([makeMetric({ name: "batch1_m0" }), makeMetric({ name: "batch1_m1" })]);
    buf.add([makeMetric({ name: "batch2_m0" })]);
    buf.add([makeMetric({ name: "batch3_m0" }), makeMetric({ name: "batch3_m1" })]);

    const tx = buf.beginTransaction(10);
    expect(tx.metrics().length).toBe(5);
    expect(tx.metrics()[0]!.name).toBe("batch1_m0");
    expect(tx.metrics()[1]!.name).toBe("batch1_m1");
    expect(tx.metrics()[2]!.name).toBe("batch2_m0");
    expect(tx.metrics()[3]!.name).toBe("batch3_m0");
    expect(tx.metrics()[4]!.name).toBe("batch3_m1");

    buf.close();
  });

  it("Per-output table naming: different aliases get different tables", () => {
    const path = dbPath();

    const buf1 = new StoreForwardBuffer("mqtt_hub", path, makeConfig());
    buf1.open();
    buf1.add([makeMetric({ name: "mqtt_metric" })]);

    const buf2 = new StoreForwardBuffer("http_influx", path, makeConfig());
    buf2.open();
    buf2.add([makeMetric({ name: "http_metric" })]);

    // Each buffer should only see its own metrics
    expect(buf1.length).toBe(1);
    expect(buf2.length).toBe(1);

    const tx1 = buf1.beginTransaction(10);
    expect(tx1.metrics().length).toBe(1);
    expect(tx1.metrics()[0]!.name).toBe("mqtt_metric");

    const tx2 = buf2.beginTransaction(10);
    expect(tx2.metrics().length).toBe(1);
    expect(tx2.metrics()[0]!.name).toBe("http_metric");

    buf1.close();
    buf2.close();
  });

  // =========================================================================
  // Metric encoding round-trip
  // =========================================================================

  it("encodeMetric/decodeMetric round-trip preserves all field types", () => {
    const metric = createMetric({
      name: "multi_type",
      fields: {
        float_val: 23.5,
        int_val: 42,
        string_val: "hello",
        bool_val: true,
      },
      tags: { host: "gw-01", location: "factory" },
      timestamp: 1700000000000000000n,
    });

    const encoded = encodeMetric(metric);
    const decoded = decodeMetric(encoded);

    expect(decoded.name).toBe("multi_type");
    expect(decoded.timestamp).toBe(1700000000000000000n);
    expect(decoded.fields.get("float_val")).toBe(23.5);
    expect(decoded.fields.get("int_val")).toBe(42);
    expect(decoded.fields.get("string_val")).toBe("hello");
    expect(decoded.fields.get("bool_val")).toBe(true);
    expect(decoded.tags.get("host")).toBe("gw-01");
    expect(decoded.tags.get("location")).toBe("factory");
  });

  // =========================================================================
  // Config defaults
  // =========================================================================

  it("Config defaults match PRD §12", () => {
    const config = StoreForwardConfigSchema.parse({});
    expect(config.metric_buffer_limit).toBe(10000);
    expect(config.metric_batch_size).toBe(1000);
    expect(config.overflow_policy).toBe("drop_oldest");
  });
});
