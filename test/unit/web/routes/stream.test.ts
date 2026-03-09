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
import { toDatastarName } from "../../../../src/web/views/fragments/signal-value";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/** Build a LiveMetricValue for testing (single "value" field — common case). */
function liveMetric(
  name: string,
  value: number | boolean | string,
  fieldName = "value",
): LiveMetricValue {
  return {
    name,
    fields: { [fieldName]: value },
    tags: {},
    timestamp: BigInt(1700000000000000000),
    quality: 1.0,
  };
}

/** Build a LiveMetricValue with multiple fields. */
function multiFieldMetric(
  name: string,
  fields: Record<string, number>,
): LiveMetricValue {
  return {
    name,
    fields,
    tags: {},
    timestamp: BigInt(1700000000000000000),
    quality: 1.0,
  };
}

/** Representative packaging profile metrics for SSE endpoint tests. */
function packagingMetrics(): Map<string, LiveMetricValue> {
  const m = new Map<string, LiveMetricValue>();
  m.set("press.line_speed", liveMetric("press.line_speed", 198.4));
  m.set("press.web_tension", liveMetric("press.web_tension", 245.2));
  m.set("press.dryer_temp_zone_1", liveMetric("press.dryer_temp_zone_1", 78.2));
  m.set("press.running", liveMetric("press.running", true));
  m.set("press.machine_state", liveMetric("press.machine_state", 2));
  m.set("laminator.nip_temp", liveMetric("laminator.nip_temp", 55.2));
  m.set("env.ambient_temp", liveMetric("env.ambient_temp", 22.5));
  return m;
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
  it("uses metric name as signal key for single-value-field metrics", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.line_speed", liveMetric("press.line_speed", 198.4));
    metrics.set("laminator.nip_temp", liveMetric("laminator.nip_temp", 55.2));

    const signals = flattenMetrics(metrics);

    // Signal keys should match toDatastarName() — no _value suffix
    expect(signals.press_line_speed).toBe(198.4);
    expect(signals.laminator_nip_temp).toBe(55.2);
    expect(typeof signals.chartTs).toBe("number");
    expect(signals.chartTs).toBeGreaterThan(1e12);
  });

  it("signal keys match dashboard toDatastarName() for packaging profile metrics", () => {
    const metricNames = [
      "press.line_speed",
      "press.web_tension",
      "press.dryer_temp_zone_1",
      "laminator.nip_temp",
      "env.ambient_temp",
      "slitter.speed",
    ];

    const metrics = new Map<string, LiveMetricValue>();
    for (const name of metricNames) {
      metrics.set(name, liveMetric(name, 42));
    }

    const signals = flattenMetrics(metrics);

    // Every signal key from flattenMetrics must match toDatastarName
    for (const name of metricNames) {
      const expectedKey = toDatastarName(name);
      expect(signals[expectedKey]).toBe(42);
    }
  });

  it("appends field name for multi-field metrics", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set(
      "press.registration_error",
      multiFieldMetric("press.registration_error", { x: 0.12, y: -0.05 }),
    );

    const signals = flattenMetrics(metrics);

    expect(signals.press_registration_error_x).toBe(0.12);
    expect(signals.press_registration_error_y).toBe(-0.05);
    // Should NOT have a bare press_registration_error key
    expect(signals.press_registration_error).toBeUndefined();
  });

  it("appends field name when single field is not named 'value'", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.line_speed", {
      name: "press.line_speed",
      fields: { speed: 198.4 },
      tags: {},
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    expect(signals.press_line_speed_speed).toBe(198.4);
    expect(signals.press_line_speed).toBeUndefined();
  });

  it("sanitises special characters in signal names", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("my-sensor.v2", liveMetric("my-sensor.v2", 42));

    const signals = flattenMetrics(metrics);

    // Hyphens and dots become underscores
    expect(signals.my_sensor_v2).toBe(42);
  });

  it("returns chartTs: 0 when no metrics available", () => {
    const metrics = new Map<string, LiveMetricValue>();
    const signals = flattenMetrics(metrics);

    expect(signals.chartTs).toBe(0);
    expect(Object.keys(signals)).toEqual(["chartTs"]);
  });

  it("handles bigint field values by converting to number", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.impression_count", {
      name: "press.impression_count",
      fields: { value: BigInt(124502) as unknown as number },
      tags: {},
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    expect(signals.press_impression_count).toBe(124502);
  });

  it("handles boolean field values", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.running", {
      name: "press.running",
      fields: { value: true as unknown as number },
      tags: {},
      timestamp: BigInt(1700000000000000000),
      quality: 1.0,
    });

    const signals = flattenMetrics(metrics);

    expect(signals.press_running).toBe("true");
  });

  it("rounds floating-point values to 2 decimal places", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.line_speed", liveMetric("press.line_speed", 199.8390655517578));
    metrics.set("press.web_tension", liveMetric("press.web_tension", 97.17400360107422));
    metrics.set("press.registration_error_x", liveMetric("press.registration_error_x", -0.00876115346751007));

    const signals = flattenMetrics(metrics);

    expect(signals.press_line_speed).toBe(199.84);
    expect(signals.press_web_tension).toBe(97.17);
    expect(signals.press_registration_error_x).toBe(-0.01);
  });

  it("does not round integer values", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.impression_count", liveMetric("press.impression_count", 124502));

    const signals = flattenMetrics(metrics);

    expect(signals.press_impression_count).toBe(124502);
  });

  it("tracks latest timestamp across multiple metrics", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("press.line_speed", {
      name: "press.line_speed",
      fields: { value: 198 },
      tags: {},
      timestamp: BigInt(1700000000000000000), // earlier
      quality: 1.0,
    });
    metrics.set("laminator.nip_temp", {
      name: "laminator.nip_temp",
      fields: { value: 55 },
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

  // Create adapter with representative packaging profile metrics
  const metricsMap = packagingMetrics();

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

  it("response contains datastar-patch-signals events with packaging profile data", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(1);

    // Find a signal event containing packaging profile metric data
    const hasPackagingData = signalEvents.some((e) => {
      return (
        e.data.includes("press_line_speed") ||
        e.data.includes("198.4")
      );
    });
    expect(hasPackagingData).toBe(true);
  });

  it("SSE signal names match dashboard Datastar signal names", async () => {
    const events = await collectSSEEvents(
      `${baseUrl}/api/dashboard/stream`,
      2500,
    );

    const signalEvents = events.filter(
      (e) => e.type === "datastar-patch-signals",
    );
    expect(signalEvents.length).toBeGreaterThanOrEqual(1);

    // Verify key packaging signals appear WITHOUT the _value suffix
    const eventData = signalEvents.map((e) => e.data).join(" ");
    expect(eventData).toContain("press_line_speed");
    expect(eventData).toContain("laminator_nip_temp");
    expect(eventData).toContain("env_ambient_temp");

    // Should NOT have _value suffix (old behaviour)
    expect(eventData).not.toContain("press_line_speed_value");
    expect(eventData).not.toContain("laminator_nip_temp_value");
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
