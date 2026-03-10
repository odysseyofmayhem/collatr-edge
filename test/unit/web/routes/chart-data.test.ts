// Unit tests: Chart data endpoints for historical queries and metric discovery
// Phase 9 Task 9.4: ECharts trend charts — historical data load + live append via SSE

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleChartHistory,
  handleChartMetrics,
  downsample,
  type ChartDataPoint,
} from "../../../../src/web/routes/chart-data";
import {
  createWebServer,
  startWebServer,
  stopWebServer,
} from "../../../../src/web/server";
import type { WebUIConfig } from "../../../../src/web/server";
import type {
  WebUIAdapter,
  PluginHealth,
  LiveMetricValue,
} from "../../../../src/web/adapter";
import type { PipelineState } from "../../../../src/pipeline/runtime";
import {
  LocalStoreOutput,
  LocalStoreConfigSchema,
  type LocalStoreConfig,
} from "../../../../src/plugins/outputs/local-store";
import { createMetric, type FieldValue } from "../../../../src/core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-chartdata-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeStoreConfig(overrides: Partial<Record<string, unknown>> = {}): LocalStoreConfig {
  return LocalStoreConfigSchema.parse({
    path: tempDir,
    retention_days: 9999,
    retention_max_gb: 100,
    ...overrides,
  });
}

// Fixed timestamp: 2024-01-15 12:00:00 UTC in nanoseconds
const BASE_TS_NS = 1705320000000000000n;
const NS_PER_SEC = 1_000_000_000n;
const NS_PER_MS = 1_000_000n;

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
  tags?: Record<string, string>;
  timestamp?: bigint;
} = {}) {
  return createMetric({
    name: overrides.name ?? "temperature",
    fields: overrides.fields ?? { value: 23.5 },
    tags: overrides.tags,
    timestamp: overrides.timestamp ?? BASE_TS_NS,
  });
}

function mockAdapter(overrides?: {
  state?: PipelineState;
  plugins?: PluginHealth[];
  metrics?: Map<string, LiveMetricValue>;
  localStore?: LocalStoreOutput | null;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const localStore = overrides?.localStore ?? null;

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => overrides?.plugins ?? [],
    getLiveMetrics: () => overrides?.metrics ?? new Map<string, LiveMetricValue>(),
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

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// Unit tests — downsample
// ---------------------------------------------------------------------------

describe("downsample", () => {
  it("returns all points when under maxPoints", () => {
    const points: ChartDataPoint[] = [
      { timestamp: 1000, value: 1 },
      { timestamp: 2000, value: 2 },
      { timestamp: 3000, value: 3 },
    ];

    const result = downsample(points, 10);
    expect(result).toEqual(points);
  });

  it("reduces points to maxPoints when exceeding limit", () => {
    const points: ChartDataPoint[] = [];
    for (let i = 0; i < 100; i++) {
      points.push({ timestamp: i * 1000, value: i });
    }

    const result = downsample(points, 10);
    expect(result.length).toBe(10);
  });

  it("preserves the last point for accurate time range", () => {
    const points: ChartDataPoint[] = [];
    for (let i = 0; i < 100; i++) {
      points.push({ timestamp: i * 1000, value: i });
    }

    const result = downsample(points, 10);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
  });

  it("preserves the first point", () => {
    const points: ChartDataPoint[] = [];
    for (let i = 0; i < 100; i++) {
      points.push({ timestamp: i * 1000, value: i });
    }

    const result = downsample(points, 10);
    expect(result[0]).toEqual(points[0]);
  });

  it("handles empty array", () => {
    expect(downsample([], 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — handleChartHistory
// ---------------------------------------------------------------------------

describe("handleChartHistory", () => {
  it("returns 400 when metric parameter is missing", () => {
    const adapter = mockAdapter();
    const resp = handleChartHistory(adapter, {});

    expect(resp.status).toBe(400);
  });

  it("returns empty array when no local store configured", async () => {
    const adapter = mockAdapter({ localStore: null });
    const resp = handleChartHistory(adapter, { metric: "temperature" });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toEqual([]);
  });

  it("returns JSON array of data points for valid metric", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    // Write some test metrics
    const metrics = [
      makeMetric({ timestamp: BASE_TS_NS }),
      makeMetric({ timestamp: BASE_TS_NS + NS_PER_SEC }),
      makeMetric({ timestamp: BASE_TS_NS + NS_PER_SEC * 2n }),
    ];
    await store.write(metrics);

    const adapter = mockAdapter({ localStore: store });

    // Query covering our test data
    const fromDate = new Date(Number(BASE_TS_NS / NS_PER_MS) - 1000).toISOString();
    const toDate = new Date(Number((BASE_TS_NS + NS_PER_SEC * 3n) / NS_PER_MS)).toISOString();
    const resp = handleChartHistory(adapter, {
      metric: "temperature",
      from: fromDate,
      to: toDate,
    });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(3);

    // Each point should have timestamp (ms) and value
    expect(data[0]).toHaveProperty("timestamp");
    expect(data[0]).toHaveProperty("value");
    expect(data[0].value).toBe(23.5);

    await store.close();
  });

  it("default time range is last 24 hours", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    // Write a metric with "now" timestamp
    const nowNs = BigInt(Date.now()) * NS_PER_MS;
    await store.write([makeMetric({ timestamp: nowNs })]);

    const adapter = mockAdapter({ localStore: store });

    // No from/to — should default to last 24h
    const resp = handleChartHistory(adapter, { metric: "temperature" });
    expect(resp.status).toBe(200);

    const data = await resp.json();
    expect(data.length).toBe(1);

    await store.close();
  });

  it("filters to correct metric name", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    await store.write([
      makeMetric({ name: "temperature", fields: { value: 21.5 }, timestamp: BASE_TS_NS }),
      makeMetric({ name: "pressure", fields: { value: 1013.2 }, timestamp: BASE_TS_NS }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const fromDate = new Date(Number(BASE_TS_NS / NS_PER_MS) - 1000).toISOString();
    const toDate = new Date(Number(BASE_TS_NS / NS_PER_MS) + 1000).toISOString();

    const resp = handleChartHistory(adapter, {
      metric: "pressure",
      from: fromDate,
      to: toDate,
    });

    const data = await resp.json();
    expect(data.length).toBe(1);
    expect(data[0].value).toBe(1013.2);

    await store.close();
  });

  it("response is capped at 2000 points", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    // Write 2500 metrics (exceeds 2000 cap)
    const batch = [];
    for (let i = 0; i < 2500; i++) {
      batch.push(
        makeMetric({
          fields: { value: i * 0.1 },
          timestamp: BASE_TS_NS + BigInt(i) * NS_PER_SEC,
        }),
      );
    }
    await store.write(batch);

    const adapter = mockAdapter({ localStore: store });
    const fromDate = new Date(Number(BASE_TS_NS / NS_PER_MS) - 1000).toISOString();
    const toDate = new Date(Number((BASE_TS_NS + BigInt(3000) * NS_PER_SEC) / NS_PER_MS)).toISOString();

    const resp = handleChartHistory(adapter, {
      metric: "temperature",
      from: fromDate,
      to: toDate,
    });

    const data = await resp.json();
    expect(data.length).toBeLessThanOrEqual(2000);

    await store.close();
  });

  it("returns empty array when no data in store", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    const adapter = mockAdapter({ localStore: store });
    const resp = handleChartHistory(adapter, {
      metric: "temperature",
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
    });

    const data = await resp.json();
    expect(data).toEqual([]);

    await store.close();
  });

  it("returns 400 for invalid from/to timestamps", () => {
    const adapter = mockAdapter();
    const resp = handleChartHistory(adapter, {
      metric: "temperature",
      from: "not-a-date",
      to: "also-not-a-date",
    });

    expect(resp.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — handleChartMetrics
// ---------------------------------------------------------------------------

describe("handleChartMetrics", () => {
  it("returns list of metric names from store", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    await store.write([
      makeMetric({ name: "temperature", timestamp: BASE_TS_NS }),
      makeMetric({ name: "pressure", timestamp: BASE_TS_NS }),
      makeMetric({ name: "humidity", timestamp: BASE_TS_NS }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleChartMetrics(adapter);
    const data = await resp.json();

    expect(Array.isArray(data)).toBe(true);
    expect(data).toContain("temperature");
    expect(data).toContain("pressure");
    expect(data).toContain("humidity");
    expect(data.length).toBe(3);

    await store.close();
  });

  it("returns empty array when no data in store", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    const adapter = mockAdapter({ localStore: store });
    const resp = handleChartMetrics(adapter);
    const data = await resp.json();

    expect(data).toEqual([]);

    await store.close();
  });

  it("returns empty array when no local store configured", async () => {
    const adapter = mockAdapter({ localStore: null });
    const resp = handleChartMetrics(adapter);
    const data = await resp.json();

    expect(data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests (require running server)
// ---------------------------------------------------------------------------

describe("GET /api/chart/* endpoints", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  let store: LocalStoreOutput;
  let app: ReturnType<typeof createWebServer>;
  let baseUrl: string;

  beforeAll(async () => {
    // Create a temp dir for this test suite
    const dir = await mkdtemp(join(tmpdir(), "collatr-charthttp-test-"));

    store = new LocalStoreOutput(
      LocalStoreConfigSchema.parse({
        path: dir,
        retention_days: 9999,
        retention_max_gb: 100,
      }),
    );
    await store.connect();

    // Write some test data — use timestamps slightly in the past to ensure they're within default 24h range
    const nowNs = BigInt(Date.now()) * NS_PER_MS;
    const fiveSecAgoNs = nowNs - NS_PER_SEC * 5n;
    const fourSecAgoNs = nowNs - NS_PER_SEC * 4n;
    await store.write([
      makeMetric({ name: "temperature", fields: { value: 22.1 }, timestamp: fiveSecAgoNs }),
      makeMetric({ name: "temperature", fields: { value: 22.3 }, timestamp: fourSecAgoNs }),
      makeMetric({ name: "pressure", fields: { value: 1013 }, timestamp: fiveSecAgoNs }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    app = createWebServer(config, adapter);
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    stopWebServer(app);
    await store.close();
  });

  it("GET /api/chart/history returns JSON array of data points", async () => {
    const resp = await fetch(`${baseUrl}/api/chart/history?metric=temperature`);
    expect(resp.status).toBe(200);

    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");

    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    expect(data[0]).toHaveProperty("timestamp");
    expect(data[0]).toHaveProperty("value");
  });

  it("GET /api/chart/history without metric returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/chart/history`);
    expect(resp.status).toBe(400);
  });

  it("GET /api/chart/metrics returns list of metric names", async () => {
    const resp = await fetch(`${baseUrl}/api/chart/metrics`);
    expect(resp.status).toBe(200);

    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");

    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toContain("temperature");
    expect(data).toContain("pressure");
  });
});

// ---------------------------------------------------------------------------
// line-chart.js web component (basic structure validation)
// ---------------------------------------------------------------------------

describe("line-chart.js web component", () => {
  it("defines the CollatrLineChart custom element", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("class CollatrLineChart extends HTMLElement");
    expect(content).toContain("customElements.define('collatr-line-chart'");
  });

  it("has addPoint method for data-effect bridge", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("addPoint(timestamp, value)");
  });

  it("has _loadHistory method for fetching historical data", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("_loadHistory()");
    expect(content).toContain("/api/chart/history");
  });

  it("reads metric attribute for history fetch", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("getAttribute('metric')");
  });

  it("sets animation: false for high-frequency updates", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("animation: false");
  });

  it("sets yAxis min/max to dataMin/dataMax for auto-scaling", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("min: 'dataMin'");
    expect(content).toContain("max: 'dataMax'");
  });

  it("guards against initial signal value with timestamp check", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("timestamp < 1000000000000");
  });

  it("keeps maxPoints at 1000 for live data", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("this.maxPoints = 1000");
  });

  it("has ResizeObserver for responsive resize", async () => {
    const file = Bun.file(
      join(import.meta.dir, "../../../../src/web/public/components/line-chart.js"),
    );
    const content = await file.text();

    expect(content).toContain("ResizeObserver");
    expect(content).toContain("chart?.resize()");
  });
});
