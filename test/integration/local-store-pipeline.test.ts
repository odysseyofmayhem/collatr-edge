// Integration test: mock input → pipeline → local store (SQLite)
// Verifies metrics flow through the full pipeline and persist to SQLite correctly.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { PipelineRuntime } from "@pipeline/runtime";
import {
  LocalStoreOutput,
  LocalStoreConfigSchema,
  decodeFields,
} from "@plugins/outputs/local-store";
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
  tempDir = await mkdtemp(join(tmpdir(), "collatr-localstore-int-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Find the daily data file(s) created in the temp directory. */
async function findDailyFiles(): Promise<string[]> {
  const entries = await readdir(tempDir);
  return entries.filter(f => f.startsWith("data_") && f.endsWith(".db")).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: mock input → pipeline → local store", () => {
  it("Mock input → pipeline → local store: metrics in SQLite with correct fields", async () => {
    const storeConfig = LocalStoreConfigSchema.parse({ path: tempDir });
    const storeOutput = new LocalStoreOutput(storeConfig);
    const mockInput = new MockPollingInput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: storeOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    await Bun.sleep(250);
    await pipeline.stop();

    // Find the daily DB file
    const dailyFiles = await findDailyFiles();
    expect(dailyFiles.length).toBeGreaterThanOrEqual(1);

    const db = new Database(join(tempDir, dailyFiles[0]!), { readonly: true });
    const rows = db.prepare(
      "SELECT name, tags, fields FROM metrics ORDER BY timestamp",
    ).all() as { name: string; tags: string; fields: Uint8Array }[];

    // Should have at least 2 metrics (temperature + pressure from first gather)
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const temps = rows.filter(r => r.name === "temperature");
    const pressures = rows.filter(r => r.name === "pressure");
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(pressures.length).toBeGreaterThanOrEqual(1);

    // Verify field values decode correctly via MessagePack
    const tempFields = decodeFields(temps[0]!.fields);
    expect(tempFields.value).toBeGreaterThan(22);

    const tempTags = JSON.parse(temps[0]!.tags) as Record<string, string>;
    expect(tempTags.sensor).toBe("s1");

    const pressureFields = decodeFields(pressures[0]!.fields);
    expect(pressureFields.value).toBe(101.3);

    const pressureTags = JSON.parse(pressures[0]!.tags) as Record<string, string>;
    expect(pressureTags.sensor).toBe("s2");

    db.close();
  });

  it("Stored metrics decode back to original values via MessagePack", async () => {
    const storeConfig = LocalStoreConfigSchema.parse({ path: tempDir });
    const storeOutput = new LocalStoreOutput(storeConfig);
    const mockInput = new MockPollingInput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: storeOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    await Bun.sleep(200);
    await pipeline.stop();

    const dailyFiles = await findDailyFiles();
    const db = new Database(join(tempDir, dailyFiles[0]!), { readonly: true });
    const rows = db.prepare("SELECT fields FROM metrics").all() as { fields: Uint8Array }[];

    // Every stored row should decode successfully via MessagePack
    for (const row of rows) {
      const decoded = decodeFields(row.fields);
      expect(decoded).toBeDefined();
      expect(typeof decoded).toBe("object");
      // Every metric has a "value" field
      expect(decoded.value).toBeDefined();
      expect(typeof decoded.value).toBe("number");
    }

    db.close();
  });

  it("Tag index reflects stored metric series", async () => {
    const storeConfig = LocalStoreConfigSchema.parse({ path: tempDir });
    const storeOutput = new LocalStoreOutput(storeConfig);
    const mockInput = new MockPollingInput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: storeOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    await Bun.sleep(200);
    await pipeline.stop();

    const dailyFiles = await findDailyFiles();
    const db = new Database(join(tempDir, dailyFiles[0]!), { readonly: true });
    const tagRows = db.prepare(
      "SELECT name, tags_hash, tags FROM tag_index ORDER BY name",
    ).all() as { name: string; tags_hash: number; tags: string }[];

    // Should have entries for both metric series
    expect(tagRows.length).toBeGreaterThanOrEqual(2);

    const names = tagRows.map(r => r.name);
    expect(names).toContain("pressure");
    expect(names).toContain("temperature");

    // Each entry should have a valid tags_hash and parseable tags JSON
    for (const row of tagRows) {
      expect(row.tags_hash).toBeGreaterThan(0);
      const tags = JSON.parse(row.tags) as Record<string, string>;
      expect(tags.sensor).toBeDefined();
    }

    db.close();
  });

  it("Global tags present in stored metrics", async () => {
    const storeConfig = LocalStoreConfigSchema.parse({ path: tempDir });
    const storeOutput = new LocalStoreOutput(storeConfig);
    const mockInput = new MockPollingInput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mockInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: storeOutput }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      globalTags: { site: "factory_a", line: "3" },
    });

    await pipeline.start();
    await Bun.sleep(200);
    await pipeline.stop();

    const dailyFiles = await findDailyFiles();
    const db = new Database(join(tempDir, dailyFiles[0]!), { readonly: true });
    const rows = db.prepare("SELECT name, tags FROM metrics").all() as {
      name: string; tags: string;
    }[];

    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Every metric should have global tags merged in
    for (const row of rows) {
      const tags = JSON.parse(row.tags) as Record<string, string>;
      expect(tags.site).toBe("factory_a");
      expect(tags.line).toBe("3");
    }

    // Original tags should also be present
    const temp = rows.find(r => r.name === "temperature");
    expect(temp).toBeDefined();
    const tempTags = JSON.parse(temp!.tags) as Record<string, string>;
    expect(tempTags.sensor).toBe("s1");

    db.close();
  });
});
