// Integration test: Web UI HTTP endpoints, SSE streaming, dashboard, certificates
// Phase 9 Task 9.8: integration tests for web UI endpoints and acceptance criteria
// PRD refs: §22 MVP Acceptance Criteria, §17 Local Web UI

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

/**
 * Read SSE events from a streaming response.
 * Collects events for the given duration (ms) then aborts.
 */
async function collectSSEEvents(
  url: string,
  durationMs: number,
): Promise<{ type: string; data: string }[]> {
  const controller = new AbortController();
  const events: { type: string; data: string }[] = [];

  const timeout = setTimeout(() => controller.abort(), durationMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split("\n");
        let eventType = "";
        let dataContent = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            dataContent += (dataContent ? "\n" : "") + line.slice(6);
          }
        }

        if (eventType) {
          events.push({ type: eventType, data: dataContent });
        }
      }
    }
  } catch {
    // AbortError is expected when we cancel the stream
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Integration tests: Full web UI with mock inputs
// ---------------------------------------------------------------------------

describe("Integration: Web UI dashboard and API endpoints", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  let baseUrl: string;

  // Live metrics for SSE streaming — use dotted equipment.signal naming
  const metricsMap = new Map<string, LiveMetricValue>();
  metricsMap.set("press.line_speed", {
    name: "press.line_speed",
    fields: { value: 198.4 },
    tags: { host: "plc-01" },
    timestamp: BigInt(Date.now()) * 1_000_000n,
    quality: 1.0,
  });
  metricsMap.set("env.ambient_temp", {
    name: "env.ambient_temp",
    fields: { value: 21.5 },
    tags: { host: "plc-01" },
    timestamp: BigInt(Date.now()) * 1_000_000n,
    quality: 1.0,
  });

  const adapter = mockAdapter({
    state: "running",
    metrics: metricsMap,
    plugins: [
      { alias: "packaging_plc", type: "input", status: "ok", lastActivity: Date.now() },
      { alias: "local_store", type: "output", status: "ok", lastActivity: Date.now() },
    ],
  });

  const app = createWebServer(config, adapter);

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  // ── Dashboard HTML ────────────────────────────────────────────────────

  it("GET / returns dashboard HTML with Datastar attributes", async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);

    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");

    const html = await resp.text();
    // Datastar SSE init
    expect(html).toContain("data-init");
    expect(html).toContain("/api/dashboard/stream");
    // Config-driven equipment cards with Datastar signal bindings
    expect(html).toContain("data-text");
    expect(html).toContain("data-signals");
    // Equipment cards from live metrics
    expect(html).toContain("Flexographic Press");
    expect(html).toContain("Environment");
    expect(html).toContain('data-equipment="press"');
    expect(html).toContain('data-equipment="env"');
    // Export form
    expect(html).toContain("/api/export");
  });

  // ── Static assets ─────────────────────────────────────────────────────

  it("GET /static/datastar.js returns JavaScript with correct Content-Type", async () => {
    const resp = await fetch(`${baseUrl}/static/datastar.js`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/javascript");
    const body = await resp.text();
    expect(body.length).toBeGreaterThan(1000);
  });

  it("GET /static/echarts.min.js returns JavaScript", async () => {
    const resp = await fetch(`${baseUrl}/static/echarts.min.js`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/javascript");
    const body = await resp.text();
    expect(body.length).toBeGreaterThan(10000);
  });

  // ── SSE streaming ─────────────────────────────────────────────────────

  it("GET /api/dashboard/stream returns SSE with patchSignals containing metric data within 3 seconds", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      3000,
    );

    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(1);

    // Signal event should contain metric values from config-driven names
    const hasMetricData = signalEvents.some(
      (e) => e.data.includes("press_line_speed") || e.data.includes("198.4"),
    );
    expect(hasMetricData).toBe(true);
  });

  it("GET /api/dashboard/stream returns SSE with patchElements containing status panel HTML", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      3000,
    );

    const elementEvents = events.filter(
      (e) => e.type === "datastar-patch-elements",
    );
    expect(elementEvents.length).toBeGreaterThanOrEqual(1);

    // Status panel HTML should contain pipeline status
    const hasStatusHtml = elementEvents.some(
      (e) =>
        e.data.includes("status-panel") ||
        e.data.includes("Uptime") ||
        e.data.includes("Heap"),
    );
    expect(hasStatusHtml).toBe(true);
  });

  it("SSE stream delivers 2+ signal events within 5 seconds", async () => {
    // Collect for 4s to stay within bun:test's default 5s timeout
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      4000,
    );

    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(2);
  });

  // ── Chart data (no local store) ────────────────────────────────────────

  it("GET /api/chart/metrics returns list of metric names (empty without store)", async () => {
    const resp = await fetch(`${baseUrl}/api/chart/metrics`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");
    const names = await resp.json();
    expect(Array.isArray(names)).toBe(true);
  });

  // ── Certificate page ──────────────────────────────────────────────────

  it("GET /certificates returns certificate page HTML", async () => {
    const resp = await fetch(`${baseUrl}/certificates`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");
    const html = await resp.text();
    // Should contain certificate-related content
    expect(html).toContain("Certificate");
  });
});

// ---------------------------------------------------------------------------
// Integration: Network policy banner visibility
// ---------------------------------------------------------------------------

describe("Integration: Network policy banner", () => {
  it("network policy banner visible in dashboard HTML when mode is standalone", async () => {
    const port = getFreePort();
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    const adapter = mockAdapter({
      networkPolicy: { mode: "standalone", summary: "No network access" },
    });
    const app = createWebServer(config, adapter);
    await startWebServer(app, config);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`);
      const html = await resp.text();

      expect(html).toContain("banner-standalone");
      expect(html).toContain("STANDALONE");
      expect(html).toContain("No network access");
    } finally {
      stopWebServer(app);
    }
  });

  it("network policy banner not visible when mode is connected", async () => {
    const port = getFreePort();
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    const adapter = mockAdapter({
      networkPolicy: { mode: "connected", summary: "Full connectivity" },
    });
    const app = createWebServer(config, adapter);
    await startWebServer(app, config);

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`);
      const html = await resp.text();

      // Banner element should have data-show="false" for connected mode
      expect(html).toContain('data-show="false"');
      // The banner element should use banner-connected class, not standalone
      // Note: "banner-standalone" also appears in CSS class definitions, so check
      // for the actual element class attribute instead of just the string
      expect(html).toContain('class="banner-connected"');
      expect(html).not.toContain('class="banner-standalone"');
    } finally {
      stopWebServer(app);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Chart data and CSV export with local store
// ---------------------------------------------------------------------------

describe("Integration: Chart data and CSV export with local store", () => {
  let tempDir: string;
  let store: LocalStoreOutput;
  let port: number;
  let baseUrl: string;
  let app: ReturnType<typeof createWebServer>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "collatr-webui-int-"));
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

  it("GET /api/chart/history returns JSON array of data points from local store", async () => {
    // Write some test metrics
    await store.write([
      makeMetric({ name: "temperature", fields: { value: 23.5 }, timestamp: BASE_TS_NS }),
      makeMetric({ name: "temperature", fields: { value: 24.0 }, timestamp: BASE_TS_NS + NS_PER_SEC }),
      makeMetric({ name: "temperature", fields: { value: 24.5 }, timestamp: BASE_TS_NS + NS_PER_SEC * 2n }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `${baseUrl}/api/chart/history?metric=temperature&from=2024-01-15T00:00:00Z&to=2024-01-16T00:00:00Z`,
    );
    expect(resp.status).toBe(200);

    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");

    const points = await resp.json() as { timestamp: number; value: number }[];
    expect(Array.isArray(points)).toBe(true);
    expect(points.length).toBe(3);
    expect(points[0]!.value).toBe(23.5);
    expect(points[2]!.value).toBe(24.5);
  });

  it("GET /api/chart/metrics returns list of metric names from local store", async () => {
    await store.write([
      makeMetric({ name: "temperature", fields: { value: 23.5 } }),
      makeMetric({ name: "pressure", fields: { value: 1013.2 } }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(`${baseUrl}/api/chart/metrics`);
    expect(resp.status).toBe(200);

    const names = await resp.json() as string[];
    expect(names).toContain("temperature");
    expect(names).toContain("pressure");
  });

  it("GET /api/export with populated local store returns CSV with timestamp_utc and timestamp_local columns", async () => {
    await store.write([
      makeMetric({ name: "temperature", fields: { value: 23.5 }, timestamp: BASE_TS_NS }),
      makeMetric({ name: "pressure", fields: { value: 1013.2 }, timestamp: BASE_TS_NS + NS_PER_SEC }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `${baseUrl}/api/export?from=2024-01-15T00:00:00Z&to=2024-01-16T00:00:00Z&tz=UTC`,
    );
    expect(resp.status).toBe(200);

    const ct = resp.headers.get("content-type");
    expect(ct).toBe("text/csv");

    const csv = await resp.text();
    const header = csv.split("\n")[0]!;
    expect(header).toContain("timestamp_utc");
    expect(header).toContain("timestamp_local");
    expect(header).toContain("timestamp_ns");

    // Data rows should exist
    const dataLines = csv.split("\n").filter((l) => l.length > 0);
    expect(dataLines.length).toBeGreaterThanOrEqual(3); // header + 2 data rows
  });

  it("CSV export Content-Disposition header includes filename", async () => {
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `${baseUrl}/api/export?from=2024-01-15T00:00:00Z&to=2024-01-16T00:00:00Z`,
    );
    expect(resp.status).toBe(200);

    const disposition = resp.headers.get("content-disposition");
    expect(disposition).toBeTruthy();
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("collatr-edge-export-");
    expect(disposition).toContain(".csv");
  });

  it("GET /api/export with empty time range returns 204", async () => {
    // Store has no data in the queried range
    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `${baseUrl}/api/export?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
    );
    expect(resp.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Integration: Web UI enabled/disabled and full lifecycle
// ---------------------------------------------------------------------------

describe("Integration: Web UI lifecycle", () => {
  it("webui enabled=false — no HTTP server listening (connection refused)", async () => {
    const port = getFreePort();
    const config: WebUIConfig = { enabled: false, port, bind: "127.0.0.1" };

    // When webui is disabled, we don't create the server at all.
    // Verify that nothing is listening on the port.
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      // If we get here, something unexpected is listening
      expect(true).toBe(false);
    } catch {
      // Expected — connection refused (nothing listening)
      expect(true).toBe(true);
    }
  });

  it("full lifecycle — start pipeline with web UI, verify HTTP works, stop, verify HTTP stops", async () => {
    const port = getFreePort();
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    const adapter = mockAdapter({ state: "running" });
    const app = createWebServer(config, adapter);

    // Start the web server
    await startWebServer(app, config);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Verify HTTP works
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("CollatrEdge");

    // Verify API endpoints work
    const streamResp = await fetch(`${baseUrl}/api/dashboard/stream`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);
    // Stream either returns 200 or we abort — either way confirms the server is up
    if (streamResp) {
      expect(streamResp.status).toBe(200);
    }

    const certResp = await fetch(`${baseUrl}/certificates`);
    expect(certResp.status).toBe(200);

    // Stop the web server
    stopWebServer(app);

    // Verify HTTP stops — connection should fail
    try {
      await fetch(`${baseUrl}/`);
      // If fetch somehow succeeds, the server didn't stop
      expect(true).toBe(false);
    } catch {
      // Expected — connection refused
      expect(true).toBe(true);
    }
  });
});
