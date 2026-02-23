// Unit tests: Stdout output plugin
// PRD refs: §19 MVP Plugin Inventory (stdout output)

import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  StdoutOutput,
  StdoutConfigSchema,
  toJSON,
  toLineProtocol,
  type StdoutConfig,
} from "@plugins/outputs/stdout";
import { createMetric, type Metric } from "@core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): StdoutConfig {
  return StdoutConfigSchema.parse(overrides);
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Stdout Output Plugin", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let logOutput: string[];

  beforeEach(() => {
    logOutput = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // =========================================================================
  // connect() and close() — no-ops
  // =========================================================================

  it("connect() and close() don't throw", async () => {
    const output = new StdoutOutput(makeConfig());
    await output.connect();
    await output.close();
    // No assertions needed beyond no exception thrown
  });

  // =========================================================================
  // JSON format
  // =========================================================================

  it("write() outputs JSON representation of each metric", async () => {
    const output = new StdoutOutput(makeConfig({ format: "json" }));
    await output.connect();

    const metric = makeMetric({
      name: "temperature",
      fields: { value: 23.5 },
      tags: { host: "factory-a" },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    expect(logOutput.length).toBe(1);
    const parsed = JSON.parse(logOutput[0]!);
    expect(parsed.name).toBe("temperature");
    expect(parsed.tags.host).toBe("factory-a");
    expect(parsed.fields.value).toBe(23.5);
    expect(parsed.timestamp).toBe("1700000000000000000");
  });

  it("Metric with tags and multiple fields serialised correctly in JSON", async () => {
    const output = new StdoutOutput(makeConfig({ format: "json" }));
    await output.connect();

    const metric = makeMetric({
      name: "sensor_data",
      fields: { temperature: 23.5, humidity: 45.2, active: true, label: "sensor-1" },
      tags: { host: "gw-01", location: "factory-a", line: "3" },
    });

    await output.write([metric]);

    expect(logOutput.length).toBe(1);
    const parsed = JSON.parse(logOutput[0]!);
    expect(parsed.name).toBe("sensor_data");
    expect(parsed.tags.host).toBe("gw-01");
    expect(parsed.tags.location).toBe("factory-a");
    expect(parsed.tags.line).toBe("3");
    expect(parsed.fields.temperature).toBe(23.5);
    expect(parsed.fields.humidity).toBe(45.2);
    expect(parsed.fields.active).toBe(true);
    expect(parsed.fields.label).toBe("sensor-1");
  });

  it("Batch of 10 metrics → 10 output lines (JSON)", async () => {
    const output = new StdoutOutput(makeConfig({ format: "json" }));
    await output.connect();

    const batch: Metric[] = [];
    for (let i = 0; i < 10; i++) {
      batch.push(makeMetric({ name: `metric_${i}`, fields: { value: i } }));
    }

    await output.write(batch);
    expect(logOutput.length).toBe(10);

    // Verify each line is valid JSON with correct name
    for (let i = 0; i < 10; i++) {
      const parsed = JSON.parse(logOutput[i]!);
      expect(parsed.name).toBe(`metric_${i}`);
      expect(parsed.fields.value).toBe(i);
    }
  });

  // =========================================================================
  // Line protocol format
  // =========================================================================

  it("write() with line_protocol format outputs Telegraf-compatible strings", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const metric = makeMetric({
      name: "temperature",
      fields: { value: 23.5 },
      tags: { host: "factory-a" },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    expect(logOutput.length).toBe(1);
    // Line protocol: measurement,tag=value field=value timestamp
    expect(logOutput[0]).toBe("temperature,host=factory-a value=23.5 1700000000000000000");
  });

  it("line protocol: multiple tags and fields formatted correctly", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const metric = makeMetric({
      name: "sensor",
      fields: { temp: 23.5, count: 42 },
      tags: { host: "gw-01", region: "uk" },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    expect(logOutput.length).toBe(1);
    // Tags sorted alphabetically (host before region)
    const line = logOutput[0]!;
    expect(line).toContain("sensor,host=gw-01,region=uk");
    expect(line).toContain("temp=23.5");
    expect(line).toContain("count=42i");
    expect(line).toEndWith("1700000000000000000");
  });

  it("Batch of 10 metrics → 10 output lines (line_protocol)", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const batch: Metric[] = [];
    for (let i = 0; i < 10; i++) {
      batch.push(makeMetric({ name: `metric_${i}`, fields: { value: i * 1.0 + 0.5 } }));
    }

    await output.write(batch);
    expect(logOutput.length).toBe(10);

    for (let i = 0; i < 10; i++) {
      expect(logOutput[i]).toContain(`metric_${i}`);
    }
  });

  // =========================================================================
  // Field type handling
  // =========================================================================

  it("line protocol: all field types formatted correctly", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const metric = makeMetric({
      name: "types_test",
      fields: {
        float_val: 23.5,
        int_val: 42,
        bigint_val: 9007199254740993n,
        string_val: "hello",
        bool_true: true,
        bool_false: false,
      },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    const line = logOutput[0]!;
    expect(line).toContain("float_val=23.5");
    expect(line).toContain("int_val=42i");
    expect(line).toContain("bigint_val=9007199254740993i");
    expect(line).toContain('string_val="hello"');
    expect(line).toContain("bool_true=true");
    expect(line).toContain("bool_false=false");
  });

  it("JSON: all field types serialised correctly", async () => {
    const output = new StdoutOutput(makeConfig({ format: "json" }));
    await output.connect();

    const metric = makeMetric({
      name: "types_test",
      fields: {
        float_val: 23.5,
        int_val: 42,
        string_val: "hello",
        bool_val: true,
      },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    const parsed = JSON.parse(logOutput[0]!);
    expect(parsed.fields.float_val).toBe(23.5);
    expect(parsed.fields.int_val).toBe(42);
    expect(parsed.fields.string_val).toBe("hello");
    expect(parsed.fields.bool_val).toBe(true);
  });

  // =========================================================================
  // Special characters
  // =========================================================================

  it("Metric with special characters in names/tags handled correctly", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const metric = makeMetric({
      name: "my measurement",  // space in name
      fields: { "field key": 1.5, value: 2.0 },
      tags: { "tag key": "tag value", "comma,tag": "equals=val" },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    const line = logOutput[0]!;
    // Measurement name: spaces escaped
    expect(line).toStartWith("my\\ measurement");
    // Tag keys/values: spaces, commas, equals escaped
    expect(line).toContain("comma\\,tag=equals\\=val");
    expect(line).toContain("tag\\ key=tag\\ value");
    // Field key: spaces escaped
    expect(line).toContain("field\\ key=1.5");
  });

  it("JSON format: special characters in names serialised as-is", async () => {
    const output = new StdoutOutput(makeConfig({ format: "json" }));
    await output.connect();

    const metric = makeMetric({
      name: "metric with spaces",
      fields: { "field.key": 1.5 },
      tags: { "tag/key": "value with spaces" },
    });

    await output.write([metric]);

    const parsed = JSON.parse(logOutput[0]!);
    expect(parsed.name).toBe("metric with spaces");
    expect(parsed.fields["field.key"]).toBe(1.5);
    expect(parsed.tags["tag/key"]).toBe("value with spaces");
  });

  it("line protocol: string field values with quotes escaped", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const metric = makeMetric({
      name: "test",
      fields: { msg: 'hello "world"' },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    const line = logOutput[0]!;
    expect(line).toContain('msg="hello \\"world\\""');
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it("empty batch → no output", async () => {
    const output = new StdoutOutput(makeConfig());
    await output.connect();
    await output.write([]);
    expect(logOutput.length).toBe(0);
  });

  it("metric with no tags → no tag section in line protocol", async () => {
    const output = new StdoutOutput(makeConfig({ format: "line_protocol" }));
    await output.connect();

    const metric = makeMetric({
      name: "simple",
      fields: { value: 1.5 },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);

    // No comma between measurement and field set means no tags
    expect(logOutput[0]).toBe("simple value=1.5 1700000000000000000");
  });

  // =========================================================================
  // Config validation
  // =========================================================================

  it("config defaults to json format", () => {
    const config = StdoutConfigSchema.parse({});
    expect(config.format).toBe("json");
  });

  it("config rejects invalid format", () => {
    expect(() => StdoutConfigSchema.parse({ format: "xml" })).toThrow();
  });

  // =========================================================================
  // Serialisation helper unit tests
  // =========================================================================

  it("toJSON produces valid JSON string", () => {
    const metric = makeMetric({
      name: "test",
      fields: { a: 1.0, b: "hello" },
      tags: { host: "gw-01" },
      timestamp: 1700000000000000000n,
    });

    const json = toJSON(metric);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("test");
    expect(parsed.tags.host).toBe("gw-01");
    expect(parsed.fields.a).toBe(1);
    expect(parsed.fields.b).toBe("hello");
    expect(parsed.timestamp).toBe("1700000000000000000");
  });

  it("toLineProtocol produces valid line protocol string", () => {
    const metric = makeMetric({
      name: "test",
      fields: { value: 42.5 },
      tags: { host: "gw-01" },
      timestamp: 1700000000000000000n,
    });

    const line = toLineProtocol(metric);
    expect(line).toBe("test,host=gw-01 value=42.5 1700000000000000000");
  });
});
