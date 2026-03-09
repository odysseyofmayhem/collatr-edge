import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { DashboardPage } from "../../../../src/web/views/dashboard";
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

/** Build a LiveMetricValue for testing. */
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

/** Standard packaging-profile metric set for testing. */
function packagingMetrics(): Map<string, LiveMetricValue> {
  const m = new Map<string, LiveMetricValue>();
  // Press signals
  m.set("press.line_speed", liveMetric("press.line_speed", 198.4));
  m.set("press.web_tension", liveMetric("press.web_tension", 245.2));
  m.set("press.ink_viscosity", liveMetric("press.ink_viscosity", 28.3));
  m.set("press.ink_temperature", liveMetric("press.ink_temperature", 24.1));
  m.set("press.dryer_temp_zone_1", liveMetric("press.dryer_temp_zone_1", 78.2));
  m.set("press.dryer_setpoint_zone_1", liveMetric("press.dryer_setpoint_zone_1", 80));
  m.set("press.dryer_temp_zone_2", liveMetric("press.dryer_temp_zone_2", 85.1));
  m.set("press.dryer_setpoint_zone_2", liveMetric("press.dryer_setpoint_zone_2", 85));
  m.set("press.impression_count", liveMetric("press.impression_count", 124502));
  m.set("press.good_count", liveMetric("press.good_count", 123115));
  m.set("press.waste_count", liveMetric("press.waste_count", 1387));
  m.set("press.machine_state", liveMetric("press.machine_state", 2));
  m.set("press.running", liveMetric("press.running", true));
  m.set("press.fault_active", liveMetric("press.fault_active", false));
  m.set("press.emergency_stop", liveMetric("press.emergency_stop", false));
  m.set("press.main_drive_current", liveMetric("press.main_drive_current", 45.2));
  // Laminator signals
  m.set("laminator.nip_temp", liveMetric("laminator.nip_temp", 55.2));
  m.set("laminator.tunnel_temp", liveMetric("laminator.tunnel_temp", 65.1));
  m.set("laminator.web_speed", liveMetric("laminator.web_speed", 197.8));
  m.set("laminator.nip_pressure", liveMetric("laminator.nip_pressure", 4.2));
  m.set("laminator.running", liveMetric("laminator.running", true));
  // Slitter signals
  m.set("slitter.speed", liveMetric("slitter.speed", 0));
  m.set("slitter.web_tension", liveMetric("slitter.web_tension", 0));
  m.set("slitter.reel_count", liveMetric("slitter.reel_count", 47));
  m.set("slitter.running", liveMetric("slitter.running", false));
  // Coder
  m.set("coder.ink_level", liveMetric("coder.ink_level", 72));
  m.set("coder.state", liveMetric("coder.state", 2));
  // Environment
  m.set("env.ambient_temp", liveMetric("env.ambient_temp", 22.5));
  m.set("env.ambient_humidity", liveMetric("env.ambient_humidity", 48.3));
  return m;
}

function mockAdapter(overrides?: {
  state?: PipelineState;
  policy?: { mode: string; summary: string } | null;
  plugins?: PluginHealth[];
  metrics?: Map<string, LiveMetricValue>;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const policy = overrides?.policy !== undefined ? overrides.policy : null;
  const plugins = overrides?.plugins ?? [
    { alias: "packaging_plc", type: "input", status: "ok", lastActivity: Date.now() },
    { alias: "rename_tags", type: "processor", status: "ok", lastActivity: null },
    { alias: "basic_stats", type: "aggregator", status: "ok", lastActivity: null },
    { alias: "local_store", type: "output", status: "ok", lastActivity: Date.now() },
  ];
  const metrics = overrides?.metrics ?? packagingMetrics();

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => plugins,
    getLiveMetrics: () => metrics,
    getNetworkPolicy: () => policy,
    getUptime: () => 60000,
    getMemoryUsage: () => ({ heapUsed: 45_000_000, heapTotal: 80_000_000, rss: 120_000_000 }),
    handleMetric: () => {},
    getLocalStore: () => null,
    getCertificateInfo: () => ({ clientCert: null, inputs: [] }),
    getTrustStore: () => null,
  };
}

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// JSX rendering tests
// ---------------------------------------------------------------------------

describe("DashboardPage JSX rendering", () => {
  it("renders to a valid HTML string containing expected elements", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(typeof html).toBe("string");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("CollatrEdge");
    expect(html).toContain("</html>");
  });

  it("contains header with CollatrEdge title", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("CollatrEdge");
    expect(html).toContain("Pipeline Running");
  });

  it("renders pipeline status badge matching state", () => {
    const stoppedAdapter = mockAdapter({ state: "stopped" });
    const stoppedHtml = DashboardPage({ adapter: stoppedAdapter });
    expect(stoppedHtml).toContain("Pipeline Stopped");
    expect(stoppedHtml).toContain("badge-stopped");

    const startingAdapter = mockAdapter({ state: "starting" });
    const startingHtml = DashboardPage({ adapter: startingAdapter });
    expect(startingHtml).toContain("Pipeline Starting");
    expect(startingHtml).toContain("badge-starting");
  });

  // ── Network policy banner ─────────────────────────────────────────────

  it("shows network policy banner when mode is local_network", () => {
    const adapter = mockAdapter({
      policy: { mode: "local_network", summary: "LAN only — 2 allowed hosts" },
    });
    const html = DashboardPage({ adapter });

    expect(html).toContain("banner-local_network");
    expect(html).toContain("LOCAL NETWORK");
    expect(html).toContain("LAN only");
  });

  it("shows network policy banner when mode is standalone", () => {
    const adapter = mockAdapter({
      policy: { mode: "standalone", summary: "No external data transmission" },
    });
    const html = DashboardPage({ adapter });

    expect(html).toContain("banner-standalone");
    expect(html).toContain("STANDALONE");
    expect(html).toContain("No external data transmission");
  });

  it("hides network policy banner when mode is connected (data-show=false)", () => {
    const adapter = mockAdapter({
      policy: { mode: "connected", summary: "Full connectivity" },
    });
    const html = DashboardPage({ adapter });

    expect(html).toContain('data-show="false"');
    expect(html).toContain("banner-connected");
  });

  it("does not render network policy banner when policy is null", () => {
    const adapter = mockAdapter({ policy: null });
    const html = DashboardPage({ adapter });

    const bodyContent = html.split("</style>")[1] ?? "";
    expect(bodyContent).not.toContain("STANDALONE");
    expect(bodyContent).not.toContain("LOCAL NETWORK");
    expect(bodyContent).not.toContain("CONNECTED");
  });

  // ── Equipment cards ─────────────────────────────────────────────────

  it("renders equipment cards for each equipment group", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('data-equipment="press"');
    expect(html).toContain('data-equipment="laminator"');
    expect(html).toContain('data-equipment="slitter"');
    expect(html).toContain('data-equipment="coder"');
    expect(html).toContain('data-equipment="env"');
  });

  it("renders equipment display names", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("Flexographic Press");
    expect(html).toContain("Laminator");
    expect(html).toContain("Slitter");
    expect(html).toContain("Coder");
    expect(html).toContain("Environment");
  });

  it("renders numeric signal labels from descriptors", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("Line Speed");
    expect(html).toContain("Web Tension");
    expect(html).toContain("Ink Viscosity");
    expect(html).toContain("Nip Temp");
  });

  it("renders signal units from descriptor metadata", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("m/min");
    expect(html).toContain("bar");
    expect(html).toContain("°C");
  });

  it("renders data-text bindings for numeric signals using sanitised names", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('data-text="$press_line_speed"');
    expect(html).toContain('data-text="$press_web_tension"');
    expect(html).toContain('data-text="$laminator_nip_temp"');
    expect(html).toContain('data-text="$slitter_speed"');
  });

  it("renders boolean indicators with data-class bindings", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    // Boolean signals should have bool-dot elements with data-class
    expect(html).toContain("bool-dot");
    expect(html).toContain("press_running");
    expect(html).toContain("press_fault_active");
    expect(html).toContain("bool-on");   // normal boolean (running)
    expect(html).toContain("bool-alarm"); // alarm boolean (fault_active)
  });

  it("renders counter signals with locale formatting expression", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("Impression Count");
    expect(html).toContain("Good Count");
    expect(html).toContain("Waste Count");
    expect(html).toContain("toLocaleString");
  });

  it("renders enum signals with label lookup expression", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    // Machine state enum should have label lookup in data-text
    expect(html).toContain("press_machine_state");
    expect(html).toContain("enum-badge");
    // Label lookup should contain state names
    expect(html).toContain("Running");
    expect(html).toContain("Fault");
    expect(html).toContain("Setup");
  });

  it("renders dryer temp/setpoint pairs when both signals exist", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    // Paired signals should show both temp and setpoint data-text bindings
    expect(html).toContain('data-text="$press_dryer_temp_zone_1"');
    expect(html).toContain('data-text="$press_dryer_setpoint_zone_1"');
    // Should have the paired class
    expect(html).toContain("signal-paired");
  });

  // ── Dynamic Datastar signals ──────────────────────────────────────────

  it("contains data-init attribute pointing to SSE endpoint", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("data-init=\"@get('/api/dashboard/stream')\"");
  });

  it("contains dynamic data-signals initialisation from descriptors", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("data-signals=");
    // Should contain sanitised signal names, not hardcoded old ones
    expect(html).toContain("press_line_speed");
    expect(html).toContain("laminator_nip_temp");
    expect(html).toContain("chartTs");
    // Should NOT contain old hardcoded signal names as top-level signals
    expect(html).not.toContain('"temperature"');
    expect(html).not.toContain('"pressure"');
    expect(html).not.toContain('"lineSpeed"');
    expect(html).not.toContain('"humidity"');
  });

  // ── No hardcoded charts ───────────────────────────────────────────────

  it("does not contain hardcoded trend charts on dashboard", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    // Old hardcoded chart IDs should be gone
    expect(html).not.toContain('id="chart-temp"');
    expect(html).not.toContain('id="chart-pressure"');
    expect(html).not.toContain('id="chart-speed"');
    expect(html).not.toContain('id="chart-humidity"');
    // No collatr-line-chart elements on the dashboard (moved to /trends)
    expect(html).not.toContain("collatr-line-chart");
  });

  // ── Navigation ────────────────────────────────────────────────────────

  it("includes navigation links for Dashboard, Trends, and Certificates", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
    expect(html).toContain('href="/trends"');
    expect(html).toContain("Trends");
    expect(html).toContain('href="/certificates"');
    expect(html).toContain("Certificates");
  });

  it("marks Dashboard link as active", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('class="nav-active"');
    // The active class should be on the Dashboard link
    expect(html).toMatch(/href="\/"\s+class="nav-active"/);
  });

  // ── CSV export form ───────────────────────────────────────────────────

  it("contains CSV export form with action pointing to /api/export", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('action="/api/export"');
    expect(html).toContain('method="get"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Export CSV");
  });

  // ── Plugin health table ───────────────────────────────────────────────

  it("contains plugin health table with plugin aliases", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("packaging_plc");
    expect(html).toContain("rename_tags");
    expect(html).toContain("basic_stats");
    expect(html).toContain("local_store");
  });

  it("contains status panel with uptime and memory", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('id="status-panel"');
    expect(html).toContain("Uptime");
    expect(html).toContain("Heap");
    expect(html).toContain("RSS");
  });

  // ── Datastar syntax validation ────────────────────────────────────────

  it("uses correct Datastar RC.7 attribute syntax", () => {
    const adapter = mockAdapter({
      policy: { mode: "local_network", summary: "LAN" },
    });
    const html = DashboardPage({ adapter });

    // Verify NO hyphen-style keyed attributes
    expect(html).not.toContain("data-on-load");
    expect(html).not.toContain("data-on-click");
    expect(html).not.toContain("data-signals-");

    // Verify correct RC.7 attributes are present
    expect(html).toContain("data-init=");
    expect(html).toContain("data-signals=");
    expect(html).toContain("data-text=");
    expect(html).toContain("data-show=");
    expect(html).toContain("data-class=");
  });

  // ── Script tags ───────────────────────────────────────────────────────

  it("includes all required script tags", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('src="/static/echarts.min.js"');
    expect(html).toContain('src="/static/components/line-chart.js"');
    expect(html).toContain('src="/static/datastar.js"');
    expect(html).toContain('type="module" src="/static/datastar.js"');
  });

  // ── Footer ────────────────────────────────────────────────────────────

  it("includes footer with version and mode", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("v0.1.0");
    expect(html).toContain("running");
  });

  // ── Empty state ───────────────────────────────────────────────────────

  it("shows placeholder when no metrics are available", () => {
    const adapter = mockAdapter({ metrics: new Map() });
    const html = DashboardPage({ adapter });

    expect(html).toContain("No signals yet");
    // Should not contain any equipment cards
    expect(html).not.toContain("data-equipment=");
  });

  // ── Equipment ordering ────────────────────────────────────────────────

  it("renders equipment cards in correct priority order", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    const pressIdx = html.indexOf('data-equipment="press"');
    const lamIdx = html.indexOf('data-equipment="laminator"');
    const slitterIdx = html.indexOf('data-equipment="slitter"');
    const coderIdx = html.indexOf('data-equipment="coder"');
    const envIdx = html.indexOf('data-equipment="env"');

    expect(pressIdx).toBeLessThan(lamIdx);
    expect(lamIdx).toBeLessThan(slitterIdx);
    expect(slitterIdx).toBeLessThan(coderIdx);
    expect(coderIdx).toBeLessThan(envIdx);
  });

  // ── Equipment status indicator ────────────────────────────────────────

  it("renders equipment status indicators from running/state signals", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    // Press has machine_state enum — should use parseInt-based status
    expect(html).toContain("equipment-status");
    expect(html).toContain("status-running");
    expect(html).toContain("status-dot-inline");
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

describe("GET / dashboard route", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  const adapter = mockAdapter({
    policy: { mode: "local_network", summary: "LAN only" },
  });
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
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("text/html");
  });

  it("response contains config-driven dashboard HTML", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain("CollatrEdge");
    expect(html).toContain("data-init");
    expect(html).toContain("/api/dashboard/stream");
    // Should contain equipment cards, not old chart IDs
    expect(html).toContain("Flexographic Press");
    expect(html).not.toContain('id="chart-temp"');
  });

  it("response contains network policy banner", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain("LOCAL NETWORK");
    expect(html).toContain("LAN only");
  });
});
