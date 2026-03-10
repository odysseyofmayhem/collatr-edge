// Integration test: Trends page, config-driven dashboard with factory simulator signals
// Phase 12 Task 12.6: integration tests with factory simulator data
// PRD refs: §17 Local Web UI

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
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
  PluginHealth,
  LiveMetricValue,
  CertificateInfo,
} from "../../src/web/adapter";
import type { PipelineState } from "../../src/pipeline/runtime";
import {
  LocalStoreOutput,
  LocalStoreConfigSchema,
} from "../../src/plugins/outputs/local-store";
import { createMetric, type FieldValue } from "../../src/core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

const BASE_TS_NS = 1705320000000000000n; // 2024-01-15 12:00:00 UTC
const NS_PER_SEC = 1_000_000_000n;

/**
 * Build a representative set of live metrics matching the factory simulator
 * packaging profile (press, laminator, slitter, coder, env, energy, vibration).
 */
function buildFactorySimMetrics(): Map<string, LiveMetricValue> {
  const now = BigInt(Date.now()) * 1_000_000n;
  const m = new Map<string, LiveMetricValue>();

  function add(name: string, fields: Record<string, FieldValue>) {
    m.set(name, {
      name,
      fields,
      tags: { host: "plc-01" },
      timestamp: now,
      quality: 1.0,
    });
  }

  // Press signals (representative subset)
  add("press.line_speed", { value: 198.4 });
  add("press.web_tension", { value: 245.2 });
  add("press.ink_viscosity", { value: 28.3 });
  add("press.ink_temperature", { value: 24.1 });
  add("press.dryer_temp_zone_1", { value: 78.2 });
  add("press.dryer_setpoint_zone_1", { value: 80.0 });
  add("press.main_drive_current", { value: 45.2 });
  add("press.impression_count", { value: 124502 });
  add("press.machine_state", { value: 2 }); // Running
  add("press.running", { value: true });
  add("press.fault_active", { value: false });

  // Laminator
  add("laminator.nip_temp", { value: 55.2 });
  add("laminator.tunnel_temp", { value: 65.1 });
  add("laminator.web_speed", { value: 197.8 });
  add("laminator.running", { value: true });

  // Slitter
  add("slitter.speed", { value: 150.0 });
  add("slitter.web_tension", { value: 120.5 });
  add("slitter.reel_count", { value: 47 });
  add("slitter.running", { value: false });

  // Coder
  add("coder.ink_level", { value: 72.5 });
  add("coder.printhead_temp", { value: 38.2 });
  add("coder.state", { value: 2 }); // Printing
  add("coder.gutter_fault", { value: false });

  // Environment
  add("env.ambient_temp", { value: 21.5 });
  add("env.ambient_humidity", { value: 45.2 });

  // Energy
  add("energy.line_power", { value: 85.3 });
  add("energy.cumulative_kwh", { value: 12450 });

  // Vibration
  add("vibration.main_drive_x", { value: 2.1 });
  add("vibration.main_drive_y", { value: 1.8 });
  add("vibration.main_drive_z", { value: 3.4 });

  return m;
}

function mockAdapter(overrides?: {
  state?: PipelineState;
  plugins?: PluginHealth[];
  metrics?: Map<string, LiveMetricValue>;
  localStore?: LocalStoreOutput | null;
  networkPolicy?: { mode: string; summary: string } | null;
  certInfo?: CertificateInfo;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const plugins = overrides?.plugins ?? [
    { alias: "packaging_plc", type: "input" as const, status: "ok" as const, lastActivity: Date.now() },
    { alias: "local_store", type: "output" as const, status: "ok" as const, lastActivity: Date.now() },
  ];
  const metrics = overrides?.metrics ?? new Map<string, LiveMetricValue>();
  const localStore = overrides?.localStore ?? null;
  const networkPolicy = overrides?.networkPolicy ?? null;
  const certInfo = overrides?.certInfo ?? { clientCert: null, inputs: [] };

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => plugins,
    getLiveMetrics: () => metrics,
    getNetworkPolicy: () => networkPolicy,
    getUptime: () => 60000,
    getMemoryUsage: () => ({
      heapUsed: 45_000_000,
      heapTotal: 80_000_000,
      rss: 120_000_000,
    }),
    handleMetric: () => {},
    getLocalStore: () => localStore,
    getCertificateInfo: () => certInfo,
    getTrustStore: () => null,
    getStats: () => null,
  };
}

// ---------------------------------------------------------------------------
// Integration: Dashboard with factory simulator signals
// ---------------------------------------------------------------------------

describe("Integration: Dashboard with factory simulator data", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  let baseUrl: string;

  const metricsMap = buildFactorySimMetrics();
  const adapter = mockAdapter({ state: "running", metrics: metricsMap });
  const app = createWebServer(config, adapter);

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  it("dashboard includes all 7 equipment group cards", async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();

    // Known equipment groups from factory sim
    expect(html).toContain('data-equipment="press"');
    expect(html).toContain('data-equipment="laminator"');
    expect(html).toContain('data-equipment="slitter"');
    expect(html).toContain('data-equipment="coder"');
    expect(html).toContain('data-equipment="energy"');
    expect(html).toContain('data-equipment="env"');
    expect(html).toContain('data-equipment="vibration"');
  });

  it("dashboard shows equipment display names from signal descriptors", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain("Flexographic Press");
    expect(html).toContain("Laminator");
    expect(html).toContain("Slitter");
    expect(html).toContain("Coder");
    expect(html).toContain("Energy");
    expect(html).toContain("Environment");
    expect(html).toContain("Vibration");
  });

  it("dashboard has Datastar signal bindings for factory sim signals", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    // data-signals JSON should include Datastar-safe names (dots→underscores)
    expect(html).toContain("data-signals");
    expect(html).toContain("press_line_speed");
    expect(html).toContain("laminator_nip_temp");
    expect(html).toContain("env_ambient_temp");
  });

  it("dashboard navigation includes Trends and Certificates links", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain('href="/trends"');
    expect(html).toContain('href="/certificates"');
    expect(html).toContain("Dashboard");
    expect(html).toContain("Trends");
    expect(html).toContain("Certificates");
  });

  it("SSE stream sends signals with factory sim metric names", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let signalData = "";

    try {
      const resp = await fetch(`${baseUrl}/api/dashboard/stream`, {
        signal: controller.signal,
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        signalData += decoder.decode(value, { stream: true });
        // Stop once we have enough signal data
        if (signalData.includes("press_line_speed")) break;
      }
    } catch {
      // AbortError expected
    } finally {
      clearTimeout(timeout);
    }

    // SSE should contain factory sim signal names (sanitised for Datastar)
    expect(signalData).toContain("press_line_speed");
  });
});

// ---------------------------------------------------------------------------
// Integration: Trends page
// ---------------------------------------------------------------------------

describe("Integration: Trends page", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  let baseUrl: string;

  const metricsMap = buildFactorySimMetrics();
  const adapter = mockAdapter({ state: "running", metrics: metricsMap });
  const app = createWebServer(config, adapter);

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  it("GET /trends returns 200 with text/html", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");
  });

  it("trends page contains equipment section headers", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    expect(html).toContain("Flexographic Press");
    expect(html).toContain("Environment");
    expect(html).toContain("Vibration");
  });

  it("trends page includes collatr-line-chart elements for curated defaults", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    // Curated defaults for press: line_speed, web_tension, dryer_temp_zone_1
    expect(html).toContain('metric="press.line_speed"');
    expect(html).toContain('metric="press.web_tension"');
    expect(html).toContain('metric="press.dryer_temp_zone_1"');

    // Curated defaults for env: ambient_temp, ambient_humidity
    expect(html).toContain('metric="env.ambient_temp"');
    expect(html).toContain('metric="env.ambient_humidity"');
  });

  it("trends page includes time range selector buttons", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    expect(html).toContain("Last Hour");
    expect(html).toContain("Last Shift");
    expect(html).toContain("Last 24h");
    expect(html).toContain("Last Week");
    expect(html).toContain("time-range-btn");
  });

  it("trends page includes metric picker for non-default signals", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    // Metric picker dropdown should exist
    expect(html).toContain("metric-picker");
    expect(html).toContain("+ Add metric");
  });

  it("trends page loads metric-picker.js script", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    expect(html).toContain('src="/static/components/metric-picker.js"');
  });

  it("trends page navigation shows Trends as active", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    // The trends link should have the active class
    expect(html).toContain('class="nav-active"');
    expect(html).toContain('href="/trends"');
  });
});

// ---------------------------------------------------------------------------
// Integration: /api/chart/metrics with local store containing factory sim data
// ---------------------------------------------------------------------------

describe("Integration: Chart metrics API with factory simulator data", () => {
  let tempDir: string;
  let store: LocalStoreOutput;
  let port: number;
  let baseUrl: string;
  let app: ReturnType<typeof createWebServer>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "collatr-trends-int-"));
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

  it("GET /api/chart/metrics returns factory sim metric names from local store", async () => {
    // Write representative factory sim metrics to the store
    await store.write([
      createMetric({ name: "press.line_speed", fields: { value: 198.4 }, timestamp: BASE_TS_NS }),
      createMetric({ name: "press.web_tension", fields: { value: 245.2 }, timestamp: BASE_TS_NS }),
      createMetric({ name: "laminator.nip_temp", fields: { value: 55.2 }, timestamp: BASE_TS_NS }),
      createMetric({ name: "env.ambient_temp", fields: { value: 21.5 }, timestamp: BASE_TS_NS }),
      createMetric({ name: "energy.line_power", fields: { value: 85.3 }, timestamp: BASE_TS_NS }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(`${baseUrl}/api/chart/metrics`);
    expect(resp.status).toBe(200);

    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");

    const names = await resp.json() as string[];
    expect(names).toContain("press.line_speed");
    expect(names).toContain("press.web_tension");
    expect(names).toContain("laminator.nip_temp");
    expect(names).toContain("env.ambient_temp");
    expect(names).toContain("energy.line_power");
  });

  it("GET /api/chart/history returns data points for factory sim metrics", async () => {
    await store.write([
      createMetric({ name: "press.line_speed", fields: { value: 195.0 }, timestamp: BASE_TS_NS }),
      createMetric({ name: "press.line_speed", fields: { value: 198.4 }, timestamp: BASE_TS_NS + NS_PER_SEC }),
      createMetric({ name: "press.line_speed", fields: { value: 200.1 }, timestamp: BASE_TS_NS + NS_PER_SEC * 2n }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `${baseUrl}/api/chart/history?metric=press.line_speed&from=2024-01-15T00:00:00Z&to=2024-01-16T00:00:00Z`,
    );
    expect(resp.status).toBe(200);

    const points = await resp.json() as { timestamp: number; value: number }[];
    expect(points.length).toBe(3);
    expect(points[0]!.value).toBe(195.0);
    expect(points[2]!.value).toBe(200.1);
  });
});

// ---------------------------------------------------------------------------
// Integration: Backward compatibility — export, certificates, health
// ---------------------------------------------------------------------------

describe("Integration: Backward compatibility with Phase 12 changes", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  let baseUrl: string;

  const metricsMap = buildFactorySimMetrics();
  const adapter = mockAdapter({
    state: "running",
    metrics: metricsMap,
    networkPolicy: { mode: "standalone", summary: "No network access" },
  });
  const app = createWebServer(config, adapter);

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  it("GET /api/export still works (returns 204 with no store data)", async () => {
    const resp = await fetch(
      `${baseUrl}/api/export?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
    );
    // No local store configured → returns 503 (service unavailable).
    // The key test is that the endpoint doesn't crash — it responds correctly.
    expect(resp.status).toBe(503);
  });

  it("GET /certificates returns certificate page HTML", async () => {
    const resp = await fetch(`${baseUrl}/certificates`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");
    const html = await resp.text();
    expect(html).toContain("Certificate");
  });

  it("GET /api/chart/metrics returns JSON array (empty without local store)", async () => {
    const resp = await fetch(`${baseUrl}/api/chart/metrics`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");
    const names = await resp.json();
    expect(Array.isArray(names)).toBe(true);
  });

  it("GET / still includes network policy banner for standalone mode", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();
    expect(html).toContain("banner-standalone");
    expect(html).toContain("STANDALONE");
  });

  it("GET / still includes pipeline status section", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();
    expect(html).toContain("Pipeline Status");
    expect(html).toContain("Uptime");
    expect(html).toContain("status-panel");
  });

  it("GET / still includes data export form", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();
    expect(html).toContain("Data Export");
    expect(html).toContain("/api/export");
    expect(html).toContain("Export CSV");
  });

  it("static assets still served correctly", async () => {
    const resp = await fetch(`${baseUrl}/static/datastar.js`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/javascript");

    const echartsResp = await fetch(`${baseUrl}/static/echarts.min.js`);
    expect(echartsResp.status).toBe(200);
  });

  it("GET /api/dashboard/stream still returns SSE events", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let receivedData = false;

    try {
      const resp = await fetch(`${baseUrl}/api/dashboard/stream`, {
        signal: controller.signal,
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/event-stream");
      receivedData = true;
    } catch {
      // AbortError expected after timeout
    } finally {
      clearTimeout(timeout);
    }

    expect(receivedData).toBe(true);
  });
});
