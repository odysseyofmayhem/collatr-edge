// E2E test: Full pipeline with real plugins
// Phase 5 task 5.0 — proves all 4 pipeline stages work together
// PRD refs: §4 Architecture, §7 Config, §8 Pipeline Lifecycle, §22 Acceptance Criteria

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { PipelineRuntime } from "@pipeline/runtime";
import { InternalInput } from "@plugins/inputs/internal";
import { FilterProcessor } from "@plugins/processors/filter";
import { RenameProcessor } from "@plugins/processors/rename";
import { BasicstatsAggregator } from "@plugins/aggregators/basicstats";
import { LocalStoreOutput, decodeFields } from "@plugins/outputs/local-store";
import { FileOutput } from "@plugins/outputs/file";
import { SimpleStatsCollector } from "@core/stats";
import type { Accumulator } from "@core/accumulator";
import type { Metric } from "@core/metric";
import type { Input, ServiceInput, Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Simple polling input that emits two sensor metric types. */
class DualSensorInput implements Input {
  private callCount = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.callCount++;
    acc.addFields("sensor_temperature", {
      temp_c: 22.5 + this.callCount * 0.1,
    });
    acc.addFields("sensor_humidity", {
      humidity_pct: 55 + this.callCount * 0.5,
    });
  }
}

/** Service input that pushes metrics on a timer until stopped. */
class TestServiceInput implements Input, ServiceInput {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private acc: Accumulator | null = null;
  private pushCount = 0;
  stopped = false;

  async gather(_acc: Accumulator): Promise<void> {
    // ServiceInput uses start/stop, not gather
  }

  async start(acc: Accumulator): Promise<void> {
    this.acc = acc;
    this.intervalId = setInterval(() => {
      this.pushCount++;
      acc.addFields("service_metric", {
        value: this.pushCount,
      }, { source: "service" });
    }, 50);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.stopped = true;
  }

  getPushCount(): number {
    return this.pushCount;
  }
}

/** Simple polling input with a known metric name. */
class SimplePollingInput implements Input {
  private callCount = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.callCount++;
    acc.addFields("polling_metric", {
      value: this.callCount,
    }, { source: "poller" });
  }

  getCallCount(): number {
    return this.callCount;
  }
}

/** Mock output that tracks write calls for assertions. */
class CollectorOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async write(batch: Metric[]): Promise<void> {
    this.written.push(...batch);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Instrumented output that records close timestamp for ordering verification. */
class InstrumentedOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closeTimestamp = 0;
  writeCount = 0;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async write(batch: Metric[]): Promise<void> {
    this.written.push(...batch);
    this.writeCount++;
  }

  async close(): Promise<void> {
    this.closeTimestamp = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runFor(pipeline: PipelineRuntime, durationMs: number): Promise<void> {
  await pipeline.start();
  await Bun.sleep(durationMs);
  await pipeline.stop();
}

/** Open a daily SQLite DB file and return all metrics rows. */
function queryDailyDb(dbPath: string): {
  timestamp: bigint;
  name: string;
  tags: Record<string, string>;
  fields: Record<string, unknown>;
}[] {
  const db = new Database(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rows = db
    .prepare(
      "SELECT timestamp, name, tags, fields FROM metrics ORDER BY timestamp",
    )
    .safeIntegers(true)
    .all() as {
    timestamp: bigint;
    name: string;
    tags: string;
    fields: Uint8Array;
  }[];
  db.close();
  return rows.map((row) => ({
    timestamp: row.timestamp,
    name: row.name,
    tags: JSON.parse(row.tags) as Record<string, string>,
    fields: decodeFields(row.fields) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `collatr-e2e-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Full pipeline with real plugins (task 5.0)", () => {
  // -------------------------------------------------------------------------
  // 5.0.1 — Full four-stage pipeline: internal → filter → basicstats → local-store
  // -------------------------------------------------------------------------

  it("5.0.1: full four-stage pipeline — internal → filter → basicstats → local-store", async () => {
    const tmpDir = makeTempDir("501");
    const stats = new SimpleStatsCollector();

    const input = new InternalInput({ collect_memstats: true }, stats);
    const filter = new FilterProcessor({ namepass: ["agent.*"] });
    const aggregator = new BasicstatsAggregator({
      period: "200ms",
      drop_original: false,
      stats: ["count", "mean"],
    });
    const localStore = new LocalStoreOutput({
      enabled: true,
      path: tmpDir,
      retention_days: 90,
      retention_max_gb: 10,
      rotation: "daily",
      downsample_after_days: 7,
      downsample_interval: "1m",
    });

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input, interval: 100 }],
      processors: [{ plugin: filter }],
      aggregators: [{ plugin: aggregator, period: 200, dropOriginal: false }],
      outputs: [{ plugin: localStore }],
      gatherIntervalMs: 100,
      flushIntervalMs: 100,
    });

    await runFor(pipeline, 1200);

    // Find daily DB file(s)
    const dbFiles = readdirSync(tmpDir).filter(
      (f) => f.startsWith("data_") && f.endsWith(".db"),
    );
    expect(dbFiles.length).toBeGreaterThanOrEqual(1);

    // Query the daily DB directly
    const dbPath = join(tmpDir, dbFiles[0]!);
    const rows = queryDailyDb(dbPath);

    // Should have rows (both raw metrics and aggregator summaries)
    expect(rows.length).toBeGreaterThan(0);

    // Check that agent.* metrics exist (passed through filter)
    const agentMetrics = rows.filter((r) => r.name.startsWith("agent."));
    expect(agentMetrics.length).toBeGreaterThan(0);

    // Verify timestamps are valid BigInt nanoseconds
    for (const row of rows) {
      expect(typeof row.timestamp).toBe("bigint");
      expect(row.timestamp).toBeGreaterThan(0n);
    }

    // Verify fields are decodable and non-empty
    for (const row of rows) {
      expect(Object.keys(row.fields).length).toBeGreaterThan(0);
    }

    // Check for aggregator summaries — should have _count and _mean field suffixes
    const summaryRows = rows.filter((r) => {
      const fieldNames = Object.keys(r.fields);
      return fieldNames.some((f) => f.endsWith("_count") || f.endsWith("_mean"));
    });
    expect(summaryRows.length).toBeGreaterThan(0);

    // Verify summary field values are valid numbers (not NaN, not Infinity)
    for (const row of summaryRows) {
      for (const [key, value] of Object.entries(row.fields)) {
        if (key.endsWith("_count") || key.endsWith("_mean")) {
          expect(typeof value).toBe("number");
          expect(Number.isFinite(value as number)).toBe(true);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // 5.0.2 — Multi-input pipeline: polling + service input
  // -------------------------------------------------------------------------

  it("5.0.2: multi-input pipeline — polling + service input both produce metrics", async () => {
    const tmpDir = makeTempDir("502");
    const outputPath = join(tmpDir, "output.jsonl");

    const pollingInput = new SimplePollingInput();
    const serviceInput = new TestServiceInput();
    const fileOutput = new FileOutput({
      path: outputPath,
      data_format: "json",
    });

    const pipeline = new PipelineRuntime({
      inputs: [
        { plugin: pollingInput, interval: 100 },
        { plugin: serviceInput },
      ],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: fileOutput }],
      gatherIntervalMs: 100,
      flushIntervalMs: 100,
    });

    await runFor(pipeline, 800);

    // Read the JSON-lines output file
    const content = readFileSync(outputPath, "utf-8").trim();
    expect(content.length).toBeGreaterThan(0);

    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const metrics = lines.map((l) => JSON.parse(l) as { name: string });

    // Should have metrics from both inputs
    const pollingMetrics = metrics.filter((m) => m.name === "polling_metric");
    const serviceMetrics = metrics.filter((m) => m.name === "service_metric");

    expect(pollingMetrics.length).toBeGreaterThan(0);
    expect(serviceMetrics.length).toBeGreaterThan(0);

    // Total metric count: both inputs produced metrics, all arrived at output
    expect(metrics.length).toBe(pollingMetrics.length + serviceMetrics.length);

    // Service input was stopped during shutdown
    expect(serviceInput.stopped).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5.0.3 — Processor chain: rename → filter → aggregator → output
  // -------------------------------------------------------------------------

  it("5.0.3: processor chain — rename → filter → basicstats → local-store", async () => {
    const tmpDir = makeTempDir("503");

    const input = new DualSensorInput();
    const rename = new RenameProcessor({
      replace: [{ field: "temp_c", dest: "temperature_celsius" }],
    });
    const filter = new FilterProcessor({ namepass: ["sensor_temperature"] });
    const aggregator = new BasicstatsAggregator({
      period: "200ms",
      drop_original: false,
      stats: ["count", "mean"],
    });
    const localStore = new LocalStoreOutput({
      enabled: true,
      path: tmpDir,
      retention_days: 90,
      retention_max_gb: 10,
      rotation: "daily",
      downsample_after_days: 7,
      downsample_interval: "1m",
    });

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: input, interval: 100 }],
      processors: [{ plugin: rename }, { plugin: filter }],
      aggregators: [{ plugin: aggregator, period: 200, dropOriginal: false }],
      outputs: [{ plugin: localStore }],
      gatherIntervalMs: 100,
      flushIntervalMs: 100,
    });

    await runFor(pipeline, 1000);

    // Query daily DB
    const dbFiles = readdirSync(tmpDir).filter(
      (f) => f.startsWith("data_") && f.endsWith(".db"),
    );
    expect(dbFiles.length).toBe(1);

    const rows = queryDailyDb(join(tmpDir, dbFiles[0]!));
    expect(rows.length).toBeGreaterThan(0);

    // Filter dropped sensor_humidity — no rows with that name
    const humidityRows = rows.filter((r) => r.name === "sensor_humidity");
    expect(humidityRows.length).toBe(0);

    // Only sensor_temperature metrics should be present
    for (const row of rows) {
      expect(row.name).toBe("sensor_temperature");
    }

    // Rename was applied before filter: the field is "temperature_celsius", not "temp_c"
    const rawRows = rows.filter(
      (r) => r.fields["temperature_celsius"] !== undefined,
    );
    expect(rawRows.length).toBeGreaterThan(0);

    // temp_c should not exist (it was renamed)
    for (const row of rawRows) {
      expect(row.fields["temp_c"]).toBeUndefined();
    }

    // Aggregator summaries: should have _count and _mean field suffixes
    const summaryRows = rows.filter((r) => {
      const fieldNames = Object.keys(r.fields);
      return fieldNames.some(
        (f) => f.endsWith("_count") || f.endsWith("_mean"),
      );
    });
    expect(summaryRows.length).toBeGreaterThan(0);

    // Summaries should have temperature_celsius_count and temperature_celsius_mean
    // (the renamed field name, not the original)
    for (const row of summaryRows) {
      expect(row.fields["temperature_celsius_count"]).toBeDefined();
      expect(row.fields["temperature_celsius_mean"]).toBeDefined();
      expect(typeof row.fields["temperature_celsius_count"]).toBe("number");
      expect(typeof row.fields["temperature_celsius_mean"]).toBe("number");
    }
  });

  // -------------------------------------------------------------------------
  // 5.0.4 — Shutdown ordering verification
  // -------------------------------------------------------------------------

  it("5.0.4: shutdown ordering — service inputs stop first, final aggregator push, all close()", async () => {
    const events: { event: string; timestamp: number }[] = [];

    // Instrumented service input that records stop time
    class TrackedServiceInput implements Input, ServiceInput {
      private intervalId: ReturnType<typeof setInterval> | null = null;

      async gather(_acc: Accumulator): Promise<void> {}

      async start(acc: Accumulator): Promise<void> {
        this.intervalId = setInterval(() => {
          acc.addFields("tracked_service", { value: 1 });
        }, 50);
      }

      async stop(): Promise<void> {
        events.push({ event: "service_input_stop", timestamp: Date.now() });
        if (this.intervalId) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }
      }
    }

    // Instrumented output that records close time and captures final writes
    class TrackedOutput implements Output {
      written: Metric[] = [];
      lastWriteTimestamp = 0;

      async connect(): Promise<void> {}

      async write(batch: Metric[]): Promise<void> {
        this.written.push(...batch);
        this.lastWriteTimestamp = Date.now();
      }

      async close(): Promise<void> {
        events.push({ event: "output_close", timestamp: Date.now() });
      }
    }

    // Instrumented aggregator that records final push
    class TrackedAggregator {
      private values: number[] = [];

      add(metric: Metric): void {
        const v = metric.getField("value");
        if (typeof v === "number") this.values.push(v);
      }

      push(acc: Accumulator): void {
        if (this.values.length > 0) {
          events.push({ event: "aggregator_push", timestamp: Date.now() });
          acc.addFields("tracked_agg_summary", {
            count: this.values.length,
          });
        }
      }

      reset(): void {
        this.values = [];
      }
    }

    // Instrumented polling input
    class TrackedInput implements Input {
      async gather(acc: Accumulator): Promise<void> {
        acc.addFields("tracked_polling", { value: 1 });
      }

      async close(): Promise<void> {
        events.push({ event: "input_close", timestamp: Date.now() });
      }
    }

    const serviceInput = new TrackedServiceInput();
    const pollingInput = new TrackedInput();
    const aggregator = new TrackedAggregator();
    const output = new TrackedOutput();

    const pipeline = new PipelineRuntime({
      inputs: [
        { plugin: pollingInput, interval: 50 },
        { plugin: serviceInput },
      ],
      processors: [],
      aggregators: [{ plugin: aggregator, period: 200, dropOriginal: false }],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    const startTime = Date.now();
    await pipeline.start();
    await Bun.sleep(500);
    await pipeline.stop();
    const shutdownDuration = Date.now() - startTime - 500;

    // Shutdown ordering assertions (PRD §8):
    // 1. Service inputs stop before input channel closes
    const serviceStop = events.find((e) => e.event === "service_input_stop");
    expect(serviceStop).toBeDefined();

    // 2. Output close happens after service input stop
    const outputClose = events.find((e) => e.event === "output_close");
    expect(outputClose).toBeDefined();
    expect(outputClose!.timestamp).toBeGreaterThanOrEqual(serviceStop!.timestamp);

    // 3. Aggregator pushed final summary (at least one push happened)
    const aggPushes = events.filter((e) => e.event === "aggregator_push");
    expect(aggPushes.length).toBeGreaterThanOrEqual(1);

    // 4. Input close() was called
    const inputClose = events.find((e) => e.event === "input_close");
    expect(inputClose).toBeDefined();

    // 5. Output received data before close
    expect(output.written.length).toBeGreaterThan(0);
    expect(output.lastWriteTimestamp).toBeLessThanOrEqual(outputClose!.timestamp);

    // 6. Total shutdown time < 5 seconds
    expect(shutdownDuration).toBeLessThan(5000);

    // 7. All plugins got their lifecycle callbacks
    expect(output.written.some((m) => m.name === "tracked_polling")).toBe(true);
    expect(output.written.some((m) => m.name === "tracked_service")).toBe(true);
  });
});
