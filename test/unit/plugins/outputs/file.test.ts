// Unit tests: File output plugin
// PRD refs: §19 MVP Plugin Inventory (file output), Appendix A

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileOutput,
  FileOutputConfigSchema,
  type FileOutputConfig,
} from "@plugins/outputs/file";
import { createMetric, type Metric, type FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-file-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): FileOutputConfig {
  return FileOutputConfigSchema.parse({
    path: join(tempDir, "output.jsonl"),
    ...overrides,
  });
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

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf-8");
  if (content === "") return [];
  return content.trimEnd().split("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("File Output Plugin", () => {

  // =========================================================================
  // JSON-lines format
  // =========================================================================

  it("JSON format: write batch → file contains valid JSON-lines (one per metric)", async () => {
    const path = join(tempDir, "metrics.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    const batch = [
      makeMetric({ name: "temp", fields: { value: 23.5 }, tags: { host: "gw-01" } }),
      makeMetric({ name: "pressure", fields: { value: 101.3 }, tags: { host: "gw-01" } }),
      makeMetric({ name: "humidity", fields: { value: 45.2 } }),
    ];

    await output.write(batch);
    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(3);

    // Each line is valid JSON
    const parsed0 = JSON.parse(lines[0]!);
    expect(parsed0.name).toBe("temp");
    expect(parsed0.fields.value).toBe(23.5);
    expect(parsed0.tags.host).toBe("gw-01");

    const parsed1 = JSON.parse(lines[1]!);
    expect(parsed1.name).toBe("pressure");
    expect(parsed1.fields.value).toBe(101.3);

    const parsed2 = JSON.parse(lines[2]!);
    expect(parsed2.name).toBe("humidity");
    expect(parsed2.fields.value).toBe(45.2);
  });

  // =========================================================================
  // CSV format
  // =========================================================================

  it("CSV format: write batch → file has header row + data rows", async () => {
    const path = join(tempDir, "metrics.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    const batch = [
      makeMetric({
        name: "sensor",
        fields: { temperature: 23.5, humidity: 45.2 },
        tags: { host: "gw-01", location: "factory" },
        timestamp: 1700000000000000000n,
      }),
      makeMetric({
        name: "sensor",
        fields: { temperature: 24.0, humidity: 46.0 },
        tags: { host: "gw-01", location: "factory" },
        timestamp: 1700000001000000000n,
      }),
    ];

    await output.write(batch);
    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(3); // header + 2 data rows

    // Header: timestamp, name, sorted tags, sorted fields
    expect(lines[0]).toBe("timestamp,name,host,location,humidity,temperature");

    // Data row 1
    const row1 = lines[1]!.split(",");
    expect(row1[0]).toBe("1700000000000000000"); // timestamp
    expect(row1[1]).toBe("sensor"); // name
    expect(row1[2]).toBe("gw-01"); // host
    expect(row1[3]).toBe("factory"); // location
    expect(row1[4]).toBe("45.2"); // humidity
    expect(row1[5]).toBe("23.5"); // temperature

    // Data row 2
    const row2 = lines[2]!.split(",");
    expect(row2[0]).toBe("1700000001000000000");
    expect(row2[4]).toBe("46"); // humidity (46.0 → "46" in JS)
  });

  // =========================================================================
  // Append mode
  // =========================================================================

  it("Append mode: two write() calls → all metrics in file (not overwritten)", async () => {
    const path = join(tempDir, "append.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    await output.write([makeMetric({ name: "metric_1" })]);
    await output.write([makeMetric({ name: "metric_2" })]);
    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(2);

    const parsed0 = JSON.parse(lines[0]!);
    const parsed1 = JSON.parse(lines[1]!);
    expect(parsed0.name).toBe("metric_1");
    expect(parsed1.name).toBe("metric_2");
  });

  it("CSV append: two write() calls → header only once, all data rows present", async () => {
    const path = join(tempDir, "append.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    await output.write([makeMetric({ name: "m1", fields: { value: 1.5 } })]);
    await output.write([makeMetric({ name: "m2", fields: { value: 2.5 } })]);
    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(3); // 1 header + 2 data rows

    // Header only appears once
    expect(lines[0]).toContain("timestamp");
    expect(lines[1]).toContain("m1");
    expect(lines[2]).toContain("m2");
  });

  // =========================================================================
  // connect() behaviour
  // =========================================================================

  it("connect() creates file if it doesn't exist", async () => {
    const path = join(tempDir, "subdir", "new-file.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    // File should exist (possibly empty)
    const file = Bun.file(path);
    expect(await file.exists()).toBe(true);

    await output.close();
  });

  it("connect() appends to existing file (doesn't truncate)", async () => {
    const path = join(tempDir, "existing.jsonl");
    // Pre-populate file
    await writeFile(path, '{"existing":"data"}\n');

    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();
    await output.write([makeMetric({ name: "new_metric" })]);
    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(2);

    // Original data preserved
    const parsed0 = JSON.parse(lines[0]!);
    expect(parsed0.existing).toBe("data");

    // New data appended
    const parsed1 = JSON.parse(lines[1]!);
    expect(parsed1.name).toBe("new_metric");
  });

  // =========================================================================
  // close()
  // =========================================================================

  it("close() flushes buffered data", async () => {
    const path = join(tempDir, "flush.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    await output.write([makeMetric({ name: "before_close" })]);
    await output.close();

    // Data should be readable after close
    const lines = await readLines(path);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).name).toBe("before_close");
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  it("Write error (invalid path) → error propagated, not swallowed", async () => {
    // Use a path that won't be writable (null byte in filename)
    const path = join(tempDir, "valid.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    // Manually break the path after connect
    (output as unknown as { config: { path: string } }).config.path = "/dev/null/impossible/path.jsonl";

    await expect(output.write([makeMetric()])).rejects.toThrow();
  });

  // =========================================================================
  // Empty batch
  // =========================================================================

  it("Empty batch → no error, nothing written", async () => {
    const path = join(tempDir, "empty.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    await output.write([]);
    await output.close();

    const content = await readFile(path, "utf-8");
    expect(content).toBe("");
  });

  // =========================================================================
  // Field type handling
  // =========================================================================

  it("Metric fields of all types (number, bigint, string, boolean) serialised correctly — JSON", async () => {
    const path = join(tempDir, "types.jsonl");
    const output = new FileOutput(makeConfig({ path, format: "json" }));
    await output.connect();

    const metric = makeMetric({
      name: "types_test",
      fields: {
        float_val: 23.5,
        int_val: 42,
        string_val: "hello",
        bool_val: true,
      },
    });

    await output.write([metric]);
    await output.close();

    const lines = await readLines(path);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.fields.float_val).toBe(23.5);
    expect(parsed.fields.int_val).toBe(42);
    expect(parsed.fields.string_val).toBe("hello");
    expect(parsed.fields.bool_val).toBe(true);
  });

  it("Metric fields of all types serialised correctly — CSV", async () => {
    const path = join(tempDir, "types.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    const metric = makeMetric({
      name: "types_test",
      fields: {
        bool_val: true,
        float_val: 23.5,
        int_val: 42,
        string_val: "hello",
      },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);
    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(2); // header + 1 data row

    // Header: timestamp,name, then sorted field names
    expect(lines[0]).toBe("timestamp,name,bool_val,float_val,int_val,string_val");

    // Data: fields in correct order
    const row = lines[1]!.split(",");
    expect(row[0]).toBe("1700000000000000000");
    expect(row[1]).toBe("types_test");
    expect(row[2]).toBe("true");     // boolean
    expect(row[3]).toBe("23.5");     // float
    expect(row[4]).toBe("42");       // integer
    expect(row[5]).toBe("hello");    // string
  });

  it("CSV: bigint field value serialised as string", async () => {
    const path = join(tempDir, "bigint.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    const metric = makeMetric({
      name: "test",
      fields: { big: 9007199254740993n },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);
    await output.close();

    const lines = await readLines(path);
    const row = lines[1]!.split(",");
    expect(row[2]).toBe("9007199254740993");
  });

  // =========================================================================
  // CSV edge cases
  // =========================================================================

  it("CSV: field with comma is quoted", async () => {
    const path = join(tempDir, "comma.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    const metric = makeMetric({
      name: "test",
      fields: { msg: "hello, world" },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);
    await output.close();

    const content = await readFile(path, "utf-8");
    expect(content).toContain('"hello, world"');
  });

  it("CSV: field with quotes is double-quoted", async () => {
    const path = join(tempDir, "quotes.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    const metric = makeMetric({
      name: "test",
      fields: { msg: 'say "hello"' },
      timestamp: 1700000000000000000n,
    });

    await output.write([metric]);
    await output.close();

    const content = await readFile(path, "utf-8");
    expect(content).toContain('"say ""hello"""');
  });

  it("CSV: missing fields in later metrics → empty values", async () => {
    const path = join(tempDir, "missing.csv");
    const output = new FileOutput(makeConfig({ path, format: "csv" }));
    await output.connect();

    // First batch establishes columns with two fields
    await output.write([
      makeMetric({ name: "m1", fields: { a: 1.5, b: 2.5 }, timestamp: 1700000000000000000n }),
    ]);

    // Second batch has only field 'a' — 'b' should be empty
    await output.write([
      makeMetric({ name: "m2", fields: { a: 3.5 }, timestamp: 1700000001000000000n }),
    ]);

    await output.close();

    const lines = await readLines(path);
    expect(lines.length).toBe(3); // header + 2 rows

    expect(lines[0]).toBe("timestamp,name,a,b");
    const row2 = lines[2]!.split(",");
    expect(row2[2]).toBe("3.5"); // field a present
    expect(row2[3]).toBe("");     // field b missing → empty
  });

  // =========================================================================
  // Config validation
  // =========================================================================

  it("config defaults to json format", () => {
    const config = FileOutputConfigSchema.parse({ path: "/tmp/test.jsonl" });
    expect(config.format).toBe("json");
  });

  it("config requires path", () => {
    expect(() => FileOutputConfigSchema.parse({})).toThrow();
  });

  it("config rejects invalid format", () => {
    expect(() => FileOutputConfigSchema.parse({ path: "/tmp/test", format: "xml" })).toThrow();
  });
});
