import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TrendsPage } from "../../../../src/web/views/trends";
import type { WebUIAdapter, PluginHealth, LiveMetricValue } from "../../../../src/web/adapter";
import type { PipelineState } from "../../../../src/pipeline/runtime";
import {
  createWebServer,
  startWebServer,
  stopWebServer,
} from "../../../../src/web/server";
import type { WebUIConfig } from "../../../../src/web/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function liveMetric(
  name: string,
  value: number | boolean | string,
  fieldName = "value",
): LiveMetricValue {
  return {
    name,
    fields: { [fieldName]: value },
    tags: {},
    timestamp: BigInt(Date.now()) * 1_000_000n,
    quality: 1.0,
  };
}

function packagingMetrics(): Map<string, LiveMetricValue> {
  const m = new Map<string, LiveMetricValue>();
  // Press signals — numeric
  m.set("press.line_speed", liveMetric("press.line_speed", 198.4));
  m.set("press.web_tension", liveMetric("press.web_tension", 245.2));
  m.set("press.ink_viscosity", liveMetric("press.ink_viscosity", 28.3));
  m.set("press.ink_temperature", liveMetric("press.ink_temperature", 24.1));
  m.set("press.dryer_temp_zone_1", liveMetric("press.dryer_temp_zone_1", 78.2));
  m.set("press.main_drive_current", liveMetric("press.main_drive_current", 45.2));
  // Press signals — boolean (should be excluded from trends)
  m.set("press.running", liveMetric("press.running", true));
  m.set("press.fault_active", liveMetric("press.fault_active", false));
  // Press signals — counter (should be excluded from trends)
  m.set("press.impression_count", liveMetric("press.impression_count", 124502));
  m.set("press.good_count", liveMetric("press.good_count", 123115));
  // Press signals — enum (should be excluded from trends)
  m.set("press.machine_state", liveMetric("press.machine_state", 2));
  // Laminator signals
  m.set("laminator.nip_temp", liveMetric("laminator.nip_temp", 55.2));
  m.set("laminator.web_speed", liveMetric("laminator.web_speed", 197.8));
  m.set("laminator.nip_pressure", liveMetric("laminator.nip_pressure", 4.2));
  m.set("laminator.running", liveMetric("laminator.running", true));
  // Slitter signals
  m.set("slitter.speed", liveMetric("slitter.speed", 0));
  m.set("slitter.web_tension", liveMetric("slitter.web_tension", 0));
  m.set("slitter.reel_count", liveMetric("slitter.reel_count", 47));
  m.set("slitter.running", liveMetric("slitter.running", false));
  // Environment
  m.set("env.ambient_temp", liveMetric("env.ambient_temp", 22.5));
  m.set("env.ambient_humidity", liveMetric("env.ambient_humidity", 48.3));
  // Vibration
  m.set("vibration.main_drive_x", liveMetric("vibration.main_drive_x", 2.1));
  m.set("vibration.main_drive_y", liveMetric("vibration.main_drive_y", 1.8));
  m.set("vibration.main_drive_z", liveMetric("vibration.main_drive_z", 0.9));
  return m;
}

function mockAdapter(overrides?: {
  state?: PipelineState;
  metrics?: Map<string, LiveMetricValue>;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const metrics = overrides?.metrics ?? packagingMetrics();

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => [],
    getLiveMetrics: () => metrics,
    getNetworkPolicy: () => null,
    getUptime: () => 60000,
    getMemoryUsage: () => ({ heapUsed: 45_000_000, heapTotal: 80_000_000, rss: 120_000_000 }),
    handleMetric: () => {},
    getLocalStore: () => null,
    getCertificateInfo: () => ({ clientCert: null, inputs: [] }),
    getTrustStore: () => null,
    getStats: () => null,
  };
}

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// JSX rendering tests
// ---------------------------------------------------------------------------

describe("TrendsPage JSX rendering", () => {
  it("renders to a valid HTML string", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(typeof html).toBe("string");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("CollatrEdge");
    expect(html).toContain("</html>");
  });

  // ── Navigation ────────────────────────────────────────────────────────

  it("includes navigation links with Trends marked active", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
    expect(html).toContain('href="/trends"');
    expect(html).toContain("Trends");
    expect(html).toContain('href="/certificates"');
    expect(html).toContain("Certificates");
    // Trends link should be active
    expect(html).toMatch(/href="\/trends"\s+class="nav-active"/);
  });

  it("does not mark Dashboard link as active", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // Dashboard link should NOT have nav-active
    expect(html).not.toMatch(/href="\/"\s+class="nav-active"/);
  });

  // ── Time range controls ────────────────────────────────────────────────

  it("renders time range selector buttons", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain("Time Range:");
    expect(html).toContain("Last Hour");
    expect(html).toContain("Last Shift");
    expect(html).toContain("Last 24h");
    expect(html).toContain("Last Week");
    expect(html).toContain("time-range-btn");
  });

  it("marks Last Hour as the default active time range", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain("time-range-active");
    // The first button (Last Hour) should have the active class
    expect(html).toMatch(/time-range-active.*Last Hour/s);
  });

  it("renders time range buttons with data-time-range attributes", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('data-time-range="1"');
    expect(html).toContain('data-time-range="8"');
    expect(html).toContain('data-time-range="24"');
    expect(html).toContain('data-time-range="168"');
  });

  // ── Equipment sections ─────────────────────────────────────────────────

  it("renders equipment sections for groups with numeric signals", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('data-equipment="press"');
    expect(html).toContain('data-equipment="laminator"');
    expect(html).toContain('data-equipment="slitter"');
    expect(html).toContain('data-equipment="env"');
    expect(html).toContain('data-equipment="vibration"');
  });

  it("renders equipment display names as section headers", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain("Flexographic Press");
    expect(html).toContain("Laminator");
    expect(html).toContain("Slitter");
    expect(html).toContain("Environment");
    expect(html).toContain("Vibration");
  });

  // ── Default chart elements ─────────────────────────────────────────────

  it("renders collatr-line-chart elements for default trend signals", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // Press defaults: line_speed, web_tension, dryer_temp_zone_1
    expect(html).toContain('metric="press.line_speed"');
    expect(html).toContain('metric="press.web_tension"');
    expect(html).toContain('metric="press.dryer_temp_zone_1"');
    // Laminator defaults: nip_temp, web_speed
    expect(html).toContain('metric="laminator.nip_temp"');
    expect(html).toContain('metric="laminator.web_speed"');
    // Slitter defaults: speed, web_tension
    expect(html).toContain('metric="slitter.speed"');
    expect(html).toContain('metric="slitter.web_tension"');
    // Environment defaults: ambient_temp, ambient_humidity
    expect(html).toContain('metric="env.ambient_temp"');
    expect(html).toContain('metric="env.ambient_humidity"');
    // Vibration defaults: main_drive_x
    expect(html).toContain('metric="vibration.main_drive_x"');
  });

  it("renders chart cards with unit in title", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain("Line Speed (m/min)");
    expect(html).toContain("Web Tension (N)");
    expect(html).toContain("Nip Temp (°C)");
  });

  it("renders chart elements with correct unit attribute", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // Check unit attributes on chart elements
    expect(html).toContain('unit="m/min"');
    expect(html).toContain('unit="N"');
    expect(html).toContain('unit="°C"');
  });

  it("renders chart elements with colour attributes", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('color="#');
  });

  it("renders chart elements with height 200px", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('height="200px"');
  });

  // ── Excluded signal types ──────────────────────────────────────────────

  it("excludes boolean signals from charts and picker", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // Boolean signals should not appear as chart metrics or picker options
    expect(html).not.toContain('metric="press.running"');
    expect(html).not.toContain('metric="press.fault_active"');
    expect(html).not.toContain('metric="laminator.running"');
    expect(html).not.toContain('metric="slitter.running"');
    expect(html).not.toContain('value="press.running"');
    expect(html).not.toContain('value="press.fault_active"');
  });

  it("excludes counter signals from charts and picker", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).not.toContain('metric="press.impression_count"');
    expect(html).not.toContain('metric="press.good_count"');
    expect(html).not.toContain('value="press.impression_count"');
    expect(html).not.toContain('value="press.good_count"');
  });

  it("excludes enum signals from charts and picker", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).not.toContain('metric="press.machine_state"');
    expect(html).not.toContain('value="press.machine_state"');
  });

  // ── Metric picker dropdown ─────────────────────────────────────────────

  it("renders metric picker dropdowns for equipment groups", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain("metric-picker");
    expect(html).toContain("+ Add metric");
    expect(html).toContain('data-picker-select="press"');
  });

  it("lists non-default numeric signals in the picker dropdown", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // These are numeric press signals NOT in the curated defaults
    expect(html).toContain('value="press.ink_viscosity"');
    expect(html).toContain('value="press.ink_temperature"');
    expect(html).toContain('value="press.main_drive_current"');
    // Picker option should show display name with unit
    expect(html).toContain("Ink Viscosity (s)");
    expect(html).toContain("Main Drive Current (A)");
  });

  it("does not list default signals in the picker dropdown", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // Default press signals should NOT be in the picker
    expect(html).not.toContain('value="press.line_speed"');
    expect(html).not.toContain('value="press.web_tension"');
    expect(html).not.toContain('value="press.dryer_temp_zone_1"');
  });

  it("renders picker options with data-unit and data-display-name", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('data-unit="s"'); // ink_viscosity unit
    expect(html).toContain('data-display-name="Ink Viscosity"');
  });

  it("does not render picker when all numeric signals are defaults", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // Environment has 2 signals and 2 defaults — no picker needed
    // Check the environment section doesn't have a picker
    const envSection = html.substring(
      html.indexOf('data-equipment="env"'),
      html.indexOf('data-equipment="vibration"'),
    );
    expect(envSection).not.toContain('data-picker-select="env"');
  });

  // ── Equipment ordering ─────────────────────────────────────────────────

  it("renders equipment sections in correct priority order", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    const pressIdx = html.indexOf('data-equipment="press"');
    const lamIdx = html.indexOf('data-equipment="laminator"');
    const slitterIdx = html.indexOf('data-equipment="slitter"');
    const envIdx = html.indexOf('data-equipment="env"');
    const vibIdx = html.indexOf('data-equipment="vibration"');

    expect(pressIdx).toBeGreaterThan(-1);
    expect(pressIdx).toBeLessThan(lamIdx);
    expect(lamIdx).toBeLessThan(slitterIdx);
    expect(slitterIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(vibIdx);
  });

  // ── Charts container ───────────────────────────────────────────────────

  it("renders charts containers with data-charts-for attribute", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('data-charts-for="press"');
    expect(html).toContain('data-charts-for="laminator"');
    expect(html).toContain('data-charts-for="slitter"');
    expect(html).toContain('data-charts-for="env"');
  });

  // ── Script tags ────────────────────────────────────────────────────────

  it("includes metric-picker.js script tag", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('src="/static/components/metric-picker.js"');
  });

  it("includes all required script tags", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain('src="/static/echarts.min.js"');
    expect(html).toContain('src="/static/components/line-chart.js"');
    expect(html).toContain('src="/static/datastar.js"');
  });

  // ── Empty state ────────────────────────────────────────────────────────

  it("shows placeholder when no metrics are available", () => {
    const adapter = mockAdapter({ metrics: new Map() });
    const html = TrendsPage({ adapter });

    expect(html).toContain("No metrics yet");
    expect(html).not.toContain("data-equipment=");
    expect(html).not.toContain("collatr-line-chart");
  });

  // ── Footer ─────────────────────────────────────────────────────────────

  it("includes footer with version and state", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    expect(html).toContain("v0.1.0");
    expect(html).toContain("running");
  });

  // ── Unknown equipment shows all numeric signals as defaults ────────────

  it("renders all numeric signals as defaults for unknown equipment", () => {
    const metrics = new Map<string, LiveMetricValue>();
    metrics.set("custom.sensor_a", liveMetric("custom.sensor_a", 42));
    metrics.set("custom.sensor_b", liveMetric("custom.sensor_b", 17));
    const adapter = mockAdapter({ metrics });
    const html = TrendsPage({ adapter });

    // Both should be default charts (not in picker)
    expect(html).toContain('metric="custom.sensor_a"');
    expect(html).toContain('metric="custom.sensor_b"');
    // No picker needed since all signals are defaults
    expect(html).not.toContain('data-picker-select="custom"');
  });

  // ── Vibration picker has remaining signals ─────────────────────────────

  it("renders vibration picker with non-default axes", () => {
    const adapter = mockAdapter();
    const html = TrendsPage({ adapter });

    // main_drive_x is default, y and z should be in picker
    expect(html).toContain('metric="vibration.main_drive_x"');
    expect(html).toContain('value="vibration.main_drive_y"');
    expect(html).toContain('value="vibration.main_drive_z"');
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

describe("GET /trends route", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  const adapter = mockAdapter();
  const app = createWebServer(config, adapter);
  let baseUrl: string;

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  it("returns 200 with Content-Type text/html", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");
  });

  it("response contains trends page HTML with chart elements", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    expect(html).toContain("CollatrEdge");
    expect(html).toContain("collatr-line-chart");
    expect(html).toContain("Flexographic Press");
    expect(html).toContain("time-range-btn");
  });

  it("response does not contain dashboard-specific elements", async () => {
    const resp = await fetch(`${baseUrl}/trends`);
    const html = await resp.text();

    expect(html).not.toContain("data-init=");
    expect(html).not.toContain("/api/dashboard/stream");
    expect(html).not.toContain("Data Export");
    expect(html).not.toContain("Pipeline Status");
  });
});
