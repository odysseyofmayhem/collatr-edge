// Integration test: mock input → pipeline → file output
// Verifies metrics flow through the full pipeline and arrive in file correctly.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PipelineRuntime } from "@pipeline/runtime";
import { FileOutput, FileOutputConfigSchema } from "@plugins/outputs/file";
import type { Metric } from "@core/metric";
import type { Input, Processor } from "@core/plugin-types";
import type { Accumulator } from "@core/accumulator";

// ---------------------------------------------------------------------------
// Mock polling input (emits known metrics)
// ---------------------------------------------------------------------------

class MockPollingInput implements Input {
  private callCount = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.callCount++;
    acc.addFields("temperature", { value: 22.5 + this.callCount * 0.1 }, { sensor: "s1" });
    acc.addFields("pressure", { value: 101.3 }, { sensor: "s2" });
  }
}

// ---------------------------------------------------------------------------
// Mock processor (adds a tag to every metric passing through)
// ---------------------------------------------------------------------------

class TaggingProcessor implements Processor {
  async process(metric: Metric, acc: Accumulator): Promise<void> {
    metric.addTag("processed", "true");
    acc.addMetric(metric);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-file-int-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function parseJSONLines(content: string): Record<string, unknown>[] {
  if (content.trim() === "") return [];
  return content.trimEnd().split("\n").map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: mock input → pipeline → file output", () => {
  it("Mock input → pipeline → file output: JSON-lines file contains correct metrics", async () => {
    const path = join(tempDir, "metrics.jsonl");
    const fileConfig = FileOutputConfigSchema.parse({ path, data_format: "json" });
    const fileOutput = new FileOutput(fileConfig);
    const mockInput = new MockPollingInput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: fileOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    await Bun.sleep(250);
    await pipeline.stop();

    const content = await readFile(path, "utf-8");
    const records = parseJSONLines(content);

    // Should have at least 2 metrics (one temperature + one pressure from first gather)
    expect(records.length).toBeGreaterThanOrEqual(2);

    const temps = records.filter((r) => r.name === "temperature");
    const pressures = records.filter((r) => r.name === "pressure");
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(pressures.length).toBeGreaterThanOrEqual(1);

    // Verify field values
    const firstTemp = temps[0]! as { fields: { value: number }; tags: { sensor: string } };
    expect(firstTemp.fields.value).toBeGreaterThan(22);
    expect(firstTemp.tags.sensor).toBe("s1");

    const firstPressure = pressures[0]! as { fields: { value: number }; tags: { sensor: string } };
    expect(firstPressure.fields.value).toBe(101.3);
    expect(firstPressure.tags.sensor).toBe("s2");
  });

  it("Global tags present in file output metrics", async () => {
    const path = join(tempDir, "global-tags.jsonl");
    const fileConfig = FileOutputConfigSchema.parse({ path, data_format: "json" });
    const fileOutput = new FileOutput(fileConfig);
    const mockInput = new MockPollingInput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: fileOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      globalTags: { site: "factory_a", line: "3" },
    });

    await pipeline.start();
    await Bun.sleep(200);
    await pipeline.stop();

    const content = await readFile(path, "utf-8");
    const records = parseJSONLines(content);

    expect(records.length).toBeGreaterThanOrEqual(1);

    // Every metric should have global tags
    for (const record of records) {
      const tags = record.tags as Record<string, string>;
      expect(tags.site).toBe("factory_a");
      expect(tags.line).toBe("3");
    }

    // Original tags should also be present
    const temp = records.find((r) => r.name === "temperature") as {
      tags: Record<string, string>;
    };
    expect(temp).toBeDefined();
    expect(temp.tags.sensor).toBe("s1");
  });

  it("Processor transforms reflected in file output", async () => {
    const path = join(tempDir, "processed.jsonl");
    const fileConfig = FileOutputConfigSchema.parse({ path, data_format: "json" });
    const fileOutput = new FileOutput(fileConfig);
    const mockInput = new MockPollingInput();
    const processor = new TaggingProcessor();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [{ plugin: processor }],
      aggregators: [],
      outputs: [{ plugin: fileOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    await Bun.sleep(200);
    await pipeline.stop();

    const content = await readFile(path, "utf-8");
    const records = parseJSONLines(content);

    expect(records.length).toBeGreaterThanOrEqual(2);

    // Every metric should have the tag added by the processor
    for (const record of records) {
      const tags = record.tags as Record<string, string>;
      expect(tags.processed).toBe("true");
    }
  });
});
