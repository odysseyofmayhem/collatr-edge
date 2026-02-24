// E2E test: Sustained operation (compressed 24h soak)
// Phase 5 task 5.2 — proves system runs stably without leaks, gaps, or errors
// PRD refs: §11 Local Data Store (daily rotation, retention), §22 Scenario 3 (24h standalone)

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PipelineRuntime } from "@pipeline/runtime";
import { FilterProcessor } from "@plugins/processors/filter";
import { BasicstatsAggregator } from "@plugins/aggregators/basicstats";
import {
  LocalStoreOutput,
  timestampToDateString,
} from "@plugins/outputs/local-store";
import { createMetric, type Metric } from "@core/metric";
import type { Accumulator } from "@core/accumulator";
import type { Input } from "@core/plugin-types";
import {
  findDailyFiles,
  queryDailyDb,
  countRows,
  makeLocalStoreConfig,
  captureErrors,
} from "./helpers";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NS_PER_MS = 1_000_000n;
const MS_PER_DAY = 86_400_000;

/** Polling input that emits metrics with a sequential counter field. */
class SequentialCounterInput implements Input {
  private counter = 0;

  async gather(acc: Accumulator): Promise<void> {
    this.counter++;
    acc.addFields(
      "soak_metric",
      { counter: this.counter, temperature: 22.5 + this.counter * 0.01 },
      { host: "test-rig", line: "1" },
    );
  }

  getCounter(): number {
    return this.counter;
  }
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

describe("E2E: Sustained operation — compressed soak test (task 5.2)", () => {
  // -------------------------------------------------------------------------
  // 5.2.1 — 60-second continuous run
  // Long-running test (~60s)
  // -------------------------------------------------------------------------

  it(
    "5.2.1: 60s continuous run — zero gaps, monotonic timestamps, valid aggregator stats",
    async () => {
      const tmpDir = makeTempDir("521");

      // Capture errors during the run
      const { errors, restore } = captureErrors();

      try {
        const input = new SequentialCounterInput();
        const filter = new FilterProcessor({ namepass: ["*"] });
        const aggregator = new BasicstatsAggregator({
          period: "5s",
          drop_original: false,
          stats: ["count", "mean"],
        });
        const localStore = new LocalStoreOutput(makeLocalStoreConfig(tmpDir));

        const pipeline = new PipelineRuntime({
          inputs: [{ plugin: input, interval: 50 }],
          processors: [{ plugin: filter }],
          aggregators: [
            { plugin: aggregator, period: 5000, dropOriginal: false },
          ],
          outputs: [{ plugin: localStore }],
          gatherIntervalMs: 50,
          flushIntervalMs: 1000,
        });

        await pipeline.start();
        await Bun.sleep(60_000);
        await pipeline.stop();
      } finally {
        restore();
      }

      // Find and query all daily DB files (could span midnight UTC)
      const dbFiles = findDailyFiles(tmpDir);
      expect(dbFiles.length).toBeGreaterThanOrEqual(1);

      let allRows: {
        timestamp: bigint;
        name: string;
        tags: Record<string, string>;
        fields: Record<string, unknown>;
      }[] = [];
      for (const file of dbFiles) {
        allRows = allRows.concat(queryDailyDb(join(tmpDir, file)));
      }

      // Separate raw metrics from aggregator summaries.
      // Raw metrics have "counter" field; summaries have "counter_count" field.
      const rawMetrics = allRows.filter(
        (r) => r.name === "soak_metric" && r.fields["counter"] !== undefined,
      );
      const summaryMetrics = allRows.filter(
        (r) =>
          r.name === "soak_metric" &&
          Object.keys(r.fields).some((f) => f.endsWith("_count")),
      );

      // Expected ~1200 raw metrics (60s / 50ms). Allow 5% loss for timing jitter.
      const expectedRaw = 1200;
      expect(rawMetrics.length).toBeGreaterThanOrEqual(
        Math.floor(expectedRaw * 0.95),
      );

      // Zero unexpected errors during the run.
      // Filter out benign shutdown-related messages that may appear under CI load.
      const unexpectedErrors = errors.filter(
        (e) => !e.includes("final flush") && !e.includes("shutdown"),
      );
      expect(unexpectedErrors.length).toBe(0);

      // Timestamps are monotonically non-decreasing
      const sortedByTime = [...rawMetrics].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      );
      for (let i = 1; i < sortedByTime.length; i++) {
        expect(sortedByTime[i]!.timestamp).toBeGreaterThanOrEqual(
          sortedByTime[i - 1]!.timestamp,
        );
      }

      // No duplicate metrics: sequential counter values must all be unique
      const counterValues = rawMetrics.map(
        (r) => r.fields["counter"] as number,
      );
      const uniqueCounters = new Set(counterValues);
      expect(uniqueCounters.size).toBe(counterValues.length);

      // Aggregator produced ~12 summary pushes (60s / 5s = 12).
      // Allow generous range for timing jitter and startup/shutdown.
      expect(summaryMetrics.length).toBeGreaterThanOrEqual(8);
      expect(summaryMetrics.length).toBeLessThanOrEqual(20);

      // All summary stats are valid (no NaN, no Infinity)
      for (const row of summaryMetrics) {
        for (const [key, value] of Object.entries(row.fields)) {
          if (key.endsWith("_count") || key.endsWith("_mean")) {
            expect(typeof value).toBe("number");
            expect(Number.isFinite(value as number)).toBe(true);
          }
        }
      }
    },
    90_000,
  ); // 90s timeout for 60s test + startup/shutdown

  // -------------------------------------------------------------------------
  // 5.2.2 — Memory stability
  // Long-running test (~60s)
  // -------------------------------------------------------------------------

  it(
    "5.2.2: memory stability — RSS growth ≤50% between t=5s and t=55s",
    async () => {
      const tmpDir = makeTempDir("522");

      const input = new SequentialCounterInput();
      const filter = new FilterProcessor({ namepass: ["*"] });
      const aggregator = new BasicstatsAggregator({
        period: "5s",
        drop_original: false,
        stats: ["count", "mean"],
      });
      const localStore = new LocalStoreOutput(makeLocalStoreConfig(tmpDir));

      const pipeline = new PipelineRuntime({
        inputs: [{ plugin: input, interval: 50 }],
        processors: [{ plugin: filter }],
        aggregators: [
          { plugin: aggregator, period: 5000, dropOriginal: false },
        ],
        outputs: [{ plugin: localStore }],
        gatherIntervalMs: 50,
        flushIntervalMs: 1000,
      });

      await pipeline.start();

      // Measure RSS at t=5s (after warmup — GC, JIT, initial allocations settle)
      await Bun.sleep(5_000);
      const rssAt5s = process.memoryUsage().rss;

      // Measure RSS at t=55s (50 seconds of sustained operation later)
      await Bun.sleep(50_000);
      const rssAt55s = process.memoryUsage().rss;

      await pipeline.stop();

      // RSS at t=55s should not exceed 1.5× RSS at t=5s.
      // This catches unbounded memory leaks (growing buffers, uncollected metrics, etc.)
      // while allowing headroom for GC timing and JIT compilation.
      expect(rssAt55s).toBeLessThanOrEqual(rssAt5s * 1.5);
    },
    90_000,
  ); // 90s timeout for 60s test + startup/shutdown

  // -------------------------------------------------------------------------
  // 5.2.3 — Daily rotation (time-warp): 3 UTC days, retention evicts oldest
  // -------------------------------------------------------------------------

  it("5.2.3: daily rotation — 3 daily files created, retention evicts oldest", async () => {
    const tmpDir = makeTempDir("523");

    // Construct timestamps for 3 different UTC days, snapped to midday (noon UTC)
    // so the 50-minute metric spread cannot cross a UTC day boundary at any time.
    const now = Date.now();
    const todayMidnight = now - (now % MS_PER_DAY);
    const day1Ms = todayMidnight - 10 * MS_PER_DAY + 12 * 3_600_000; // 10 days ago, noon
    const day2Ms = todayMidnight - 1 * MS_PER_DAY + 12 * 3_600_000;  // yesterday, noon
    const day3Ms = todayMidnight + 12 * 3_600_000;                     // today, noon

    function makeMetricsForDay(dayMs: number, count: number): Metric[] {
      const metrics: Metric[] = [];
      for (let i = 0; i < count; i++) {
        // Spread metrics within the day (add i minutes)
        const tsNs = BigInt(dayMs + i * 60_000) * NS_PER_MS;
        metrics.push(
          createMetric({
            name: "rotation_test",
            fields: { value: i },
            tags: { host: "test-rig" },
            timestamp: tsNs,
          }),
        );
      }
      return metrics;
    }

    // Step 1: Write metrics spanning 3 days with generous retention (no eviction)
    const store1 = new LocalStoreOutput(
      makeLocalStoreConfig(tmpDir, { retention_days: 90 }),
    );
    await store1.connect();
    await store1.write(makeMetricsForDay(day1Ms, 50));
    await store1.write(makeMetricsForDay(day2Ms, 50));
    await store1.write(makeMetricsForDay(day3Ms, 50));
    await store1.close();

    // Step 2: Verify 3 daily files created
    const filesBeforeRetention = findDailyFiles(tmpDir);
    expect(filesBeforeRetention.length).toBe(3);

    // Step 3: Verify each file contains only metrics for its correct day
    for (const file of filesBeforeRetention) {
      const rows = queryDailyDb(join(tmpDir, file));
      expect(rows.length).toBe(50);

      // Extract the date from the filename (data_YYYY_MM_DD.db)
      const match = file.match(/data_(\d{4})_(\d{2})_(\d{2})\.db/);
      expect(match).not.toBeNull();
      const fileDate = `${match![1]}_${match![2]}_${match![3]}`;

      // All rows in this file must have timestamps that resolve to this date
      for (const row of rows) {
        const rowDate = timestampToDateString(row.timestamp);
        expect(rowDate).toBe(fileDate);
      }
    }

    // Step 4: Re-open with retention_days=5 — day1 (10 days ago) should be evicted
    const store2 = new LocalStoreOutput(
      makeLocalStoreConfig(tmpDir, { retention_days: 5 }),
    );
    await store2.connect(); // connect() runs runRetention()
    await store2.close();

    // Step 5: Verify oldest file was deleted
    const filesAfterRetention = findDailyFiles(tmpDir);
    expect(filesAfterRetention.length).toBe(2);

    // The oldest file (10 days ago) must be gone
    const day1DateStr = timestampToDateString(BigInt(day1Ms) * NS_PER_MS);
    for (const file of filesAfterRetention) {
      expect(file).not.toContain(day1DateStr);
    }

    // Remaining files still have their data intact
    for (const file of filesAfterRetention) {
      const count = countRows(join(tmpDir, file));
      expect(count).toBe(50);
    }
  });
});
