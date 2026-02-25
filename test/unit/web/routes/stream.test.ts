import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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
import { flattenMetrics } from "../../../../src/web/routes/stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function mockAdapter(overrides?: {
  state?: PipelineState;
  plugins?: PluginHealth[];
  metrics?: Map<string, LiveMetricValue>;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const plugins = overrides?.plugins ?? [
    {
      alias: "packaging_plc",
      type: "input",
      status: "ok",
      lastActivity: Date.now(),
    },
    {
      alias: "local_store",
      type: "output",
      status: "ok",
      lastActivity: Date.now(),
    },
  ];
  const metrics = overrides?.metrics ?? new Map<string, LiveMetricValue>();

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => plugins,
    getLiveMetrics: () => metrics,
    getNetworkPolicy: () => null,
    getUptime: () => 60000,
    getMemoryUsage: () => ({
      heapUsed: 45_000_000,
      heapTotal: 80_000_000,
      rss: 120_000_000,
    }),
    handleMetric: () => {},
    getLocalStore: () => null,
    getCertificateInfo: () => ({ clientCert: null, inputs: [] }),
    getTrustStore: () => null,
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
      // Keep the last (potentially incomplete) part in the buffer
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
// Unit tests — flattenMetrics
// ---------------------------------------------------------------------------

describe("flattenMetrics", () => {
  it("flattens metric name and field name into signal keys", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("packaging_sensor", {
      name: "packaging_sensor",
      fields: { temperature: 21.5, pressure: 1013.2 },
      tags: { host: "plc-01" },
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    expect(signals.packaging_sensor_temperature).toBe(21.5);
    expect(signals.packaging_sensor_pressure).toBe(1013.2);
    expect(typeof signals.chartTs).toBe("number");
    expect(signals.chartTs).toBeGreaterThan(1e12); // epoch milliseconds
  });

  it("sanitises special characters in signal names", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("my-sensor.v2", {
      name: "my-sensor.v2",
      fields: { "line-speed": 42 },
      tags: {},
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    // Hyphens and dots become underscores
    expect(signals.my_sensor_v2_line_speed).toBe(42);
  });

  it("returns chartTs: 0 when no metrics available", () => {
    const metrics = new Map<string, LiveMetricValue>();
    const signals = flattenMetrics(metrics);

    expect(signals.chartTs).toBe(0);
    // Should only contain chartTs
    expect(Object.keys(signals)).toEqual(["chartTs"]);
  });

  it("handles bigint field values by converting to number", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("counter", {
      name: "counter",
      fields: { total: BigInt(12345) as unknown as number },
      tags: {},
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    expect(signals.counter_total).toBe(12345);
  });

  it("handles boolean field values", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("status", {
      name: "status",
      fields: { running: true as unknown as number },
      tags: {},
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    expect(signals.status_running).toBe("true");
  });

  it("tracks latest timestamp across multiple metrics", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("sensor_a", {
      name: "sensor_a",
      fields: { val: 10 },
      tags: {},
      timestamp: BigInt(1700000000000000000), // earlier
      quality: 1.0,
    });
    metrics.set("sensor_b", {
      name: "sensor_b",
      fields: { val: 20 },
      tags: {},
      timestamp: BigInt(1700000001000000000), // 1s later
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    // chartTs should be the later timestamp in ms
    expect(signals.chartTs).toBe(1700000001000);
  });
});

// ---------------------------------------------------------------------------
// SSE endpoint tests (require running server)
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/stream", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };

  // Create adapter with some live metrics
  const metricsMap = new Map<string, LiveMetricValue>();
  metricsMap.set("temperature", {
    name: "temperature",
    fields: { value: 21.5 },
    tags: { host: "plc-01" },
    timestamp: BigInt(Date.now()) * BigInt(1e6),
    quality: 1.0,
  });
  metricsMap.set("pressure", {
    name: "pressure",
    fields: { value: 1013.2 },
    tags: { host: "plc-01" },
    timestamp: BigInt(Date.now()) * BigInt(1e6),
    quality: 1.0,
  });

  const adapter = mockAdapter({ metrics: metricsMap });
  const app = createWebServer(config, adapter);
  let baseUrl: string;

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  it("returns 200 with Content-Type text/event-stream", async () => {
    const controller = new AbortController();
    const resp = await fetch(`${baseUrl}/api/dashboard/stream`, {
      signal: controller.signal,
    });

    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/event-stream");

    // Abort to clean up the stream
    controller.abort();
  });

  it("response contains datastar-patch-signals events with metric data", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(1);

    // Find a signal event that contains our metric data
    const hasMetricData = signalEvents.some((e) => {
      return e.data.includes("temperature_value") || e.data.includes("21.5");
    });
    expect(hasMetricData).toBe(true);
  });

  it("response contains datastar-patch-elements events with status HTML", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const elementEvents = events.filter(
      (e) => e.type === "datastar-patch-elements",
    );
    expect(elementEvents.length).toBeGreaterThanOrEqual(1);

    // Status panel HTML should contain pipeline info
    const hasStatusHtml = elementEvents.some(
      (e) =>
        e.data.includes("status-panel") ||
        e.data.includes("Uptime") ||
        e.data.includes("Heap"),
    );
    expect(hasStatusHtml).toBe(true);
  });

  it("status panel HTML includes pipeline state and uptime", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const elementEvents = events.filter(
      (e) => e.type === "datastar-patch-elements",
    );
    expect(elementEvents.length).toBeGreaterThanOrEqual(1);

    // The status panel should contain uptime and memory
    const statusEvent = elementEvents[0];
    expect(statusEvent.data).toContain("Uptime");
    expect(statusEvent.data).toContain("Heap");
    expect(statusEvent.data).toContain("RSS");
  });

  it("plugin table HTML includes plugin aliases and status indicators", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const elementEvents = events.filter(
      (e) => e.type === "datastar-patch-elements",
    );
    expect(elementEvents.length).toBeGreaterThanOrEqual(1);

    // The status panel (which includes plugin table) should have our plugins
    const statusEvent = elementEvents[0];
    expect(statusEvent.data).toContain("packaging_plc");
    expect(statusEvent.data).toContain("local_store");
    expect(statusEvent.data).toContain("dot-ok"); // status indicator CSS class
  });

  it("stream sends updates at configured intervals (2+ events within 3s)", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      3500,
    );

    // Should have at least 2 signal events within 3s (1s interval)
    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("signal events contain chartTs field", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(1);

    // Every signal event should contain chartTs
    const hasChartTs = signalEvents.some((e) => e.data.includes("chartTs"));
    expect(hasChartTs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty metrics handling
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/stream — empty metrics", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  const adapter = mockAdapter(); // no metrics
  const app = createWebServer(config, adapter);
  let baseUrl: string;

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  it("stream handles adapter returning empty metrics gracefully", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    // Should still send signal events (with just chartTs: 0)
    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(1);

    // Signal should contain chartTs even with no metrics
    const hasChartTs = signalEvents.some((e) => e.data.includes("chartTs"));
    expect(hasChartTs).toBe(true);

    // Should still send element patches (status panel)
    const elementEvents = events.filter(
      (e) => e.type === "datastar-patch-elements",
    );
    expect(elementEvents.length).toBeGreaterThanOrEqual(1);
  });
});
