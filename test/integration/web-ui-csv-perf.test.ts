// Integration test: CSV export performance — acceptance criteria Scenario 4
// Phase 9 Task 9.8: "insert 3600 metrics (1 per second for 1 hour), export 1-hour CSV in <5 seconds"
// PRD refs: §22 MVP Acceptance Criteria (Scenario 4), §17 Local Web UI (Data Export)

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWebServer,
  startWebServer,
  stopWebServer,
} from "../../src/web/server";
import type { WebUIConfig } from "../../src/web/server";
import type {
  WebUIAdapter,
  LiveMetricValue,
} from "../../src/web/adapter";
import {
  LocalStoreOutput,
  LocalStoreConfigSchema,
} from "../../src/plugins/outputs/local-store";
import { createMetric } from "../../src/core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

const NS_PER_SEC = 1_000_000_000n;
// 2024-01-15 12:00:00 UTC in nanoseconds
const BASE_TS_NS = 1705320000000000000n;

function mockAdapter(localStore: LocalStoreOutput): WebUIAdapter {
  return {
    getStatus: () => ({ state: "running" as const, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => [],
    getLiveMetrics: () => new Map<string, LiveMetricValue>(),
    getNetworkPolicy: () => null,
    getUptime: () => 60000,
    getMemoryUsage: () => ({
      heapUsed: 45_000_000,
      heapTotal: 80_000_000,
      rss: 120_000_000,
    }),
    handleMetric: () => {},
    getLocalStore: () => localStore,
    getCertificateInfo: () => ({ clientCert: null, inputs: [] }),
    getTrustStore: () => null,
    getStats: () => null,
  };
}

// ---------------------------------------------------------------------------
// CSV export performance test (acceptance criteria Scenario 4)
// ---------------------------------------------------------------------------

describe("Integration: CSV export performance — acceptance criteria Scenario 4", () => {
  let tempDir: string;
  let store: LocalStoreOutput;
  let port: number;
  let baseUrl: string;
  let app: ReturnType<typeof createWebServer>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "collatr-csv-perf-"));
    const storeConfig = LocalStoreConfigSchema.parse({
      path: tempDir,
      retention_days: 9999,
      retention_max_gb: 100,
    });
    store = new LocalStoreOutput(storeConfig);
    await store.connect();
    port = getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    try { stopWebServer(app); } catch { /* already stopped */ }
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("export 1-hour CSV (3600 metrics) completes in <5 seconds", async () => {
    // Insert 3600 metrics — 1 per second for 1 hour
    // Write in batches of 360 to avoid extremely large single-write calls
    const TOTAL_METRICS = 3600;
    const BATCH_SIZE = 360;

    for (let batchStart = 0; batchStart < TOTAL_METRICS; batchStart += BATCH_SIZE) {
      const batch = [];
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_METRICS);
      for (let i = batchStart; i < batchEnd; i++) {
        batch.push(
          createMetric({
            name: "temperature",
            fields: { value: 20 + Math.random() * 10 },
            tags: { sensor: "s1", line: "packaging" },
            timestamp: BASE_TS_NS + BigInt(i) * NS_PER_SEC,
          }),
        );
      }
      await store.write(batch);
    }

    // Create web server with the populated store
    const adapter = mockAdapter(store);
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    // Time the CSV export via HTTP
    const exportStart = performance.now();
    const resp = await fetch(
      `${baseUrl}/api/export?from=2024-01-15T12:00:00Z&to=2024-01-15T13:00:00Z&tz=UTC`,
    );
    const csv = await resp.text();
    const exportElapsed = performance.now() - exportStart;

    // Verify response
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/csv");

    // Verify CSV contents
    const lines = csv.split("\n").filter((l) => l.length > 0);
    const header = lines[0]!;
    expect(header).toContain("timestamp_utc");
    expect(header).toContain("timestamp_local");
    expect(header).toContain("timestamp_ns");

    // Should have header + 3600 data rows
    expect(lines.length).toBe(TOTAL_METRICS + 1);

    // Verify first and last row timestamps are correct
    const firstDataRow = lines[1]!;
    expect(firstDataRow).toContain("2024-01-15T12:00:00.000Z");

    const lastDataRow = lines[lines.length - 1]!;
    expect(lastDataRow).toContain("2024-01-15T12:59:59.000Z");

    // Acceptance criteria: export completes in <5 seconds
    expect(exportElapsed).toBeLessThan(5000);
  });
});
