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

function mockAdapter(overrides?: {
  state?: PipelineState;
  policy?: { mode: string; summary: string } | null;
  plugins?: PluginHealth[];
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const policy = overrides?.policy !== undefined ? overrides.policy : null;
  const plugins = overrides?.plugins ?? [
    { alias: "packaging_plc", type: "input", status: "ok", lastActivity: Date.now() },
    { alias: "rename_tags", type: "processor", status: "ok", lastActivity: null },
    { alias: "basic_stats", type: "aggregator", status: "ok", lastActivity: null },
    { alias: "local_store", type: "output", status: "ok", lastActivity: Date.now() },
  ];

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => plugins,
    getLiveMetrics: () => new Map<string, LiveMetricValue>(),
    getNetworkPolicy: () => policy,
    getUptime: () => 60000,
    getMemoryUsage: () => ({ heapUsed: 45_000_000, heapTotal: 80_000_000, rss: 120_000_000 }),
    handleMetric: () => {},
    getLocalStore: () => null,
  };
}

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// JSX rendering tests (no server needed — DashboardPage returns a string)
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

    // The banner is rendered but with data-show="false"
    expect(html).toContain('data-show="false"');
    expect(html).toContain("banner-connected");
  });

  it("does not render network policy banner when policy is null", () => {
    const adapter = mockAdapter({ policy: null });
    const html = DashboardPage({ adapter });

    // The CSS style block contains banner class definitions, so check for
    // actual banner element content (STANDALONE/LOCAL NETWORK/CONNECTED labels)
    // outside the style block
    const bodyContent = html.split("</style>")[1] ?? "";
    expect(bodyContent).not.toContain("STANDALONE");
    expect(bodyContent).not.toContain("LOCAL NETWORK");
    expect(bodyContent).not.toContain("CONNECTED");
  });

  // ── Live metrics SSE ──────────────────────────────────────────────────

  it("contains data-init attribute pointing to SSE endpoint", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("data-init=\"@get('/api/dashboard/stream')\"");
  });

  it("contains data-signals for live metric values", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("data-signals=");
    expect(html).toContain("temperature");
    expect(html).toContain("pressure");
    expect(html).toContain("lineSpeed");
    expect(html).toContain("humidity");
    expect(html).toContain("chartTs");
  });

  it("contains data-text bindings for metric display", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('data-text="$temperature"');
    expect(html).toContain('data-text="$pressure"');
    expect(html).toContain('data-text="$lineSpeed"');
    expect(html).toContain('data-text="$humidity"');
  });

  // ── Chart web components ──────────────────────────────────────────────

  it("contains chart web components with data-effect attributes", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    // 4 chart web components
    expect(html).toContain('id="chart-temp"');
    expect(html).toContain('id="chart-pressure"');
    expect(html).toContain('id="chart-speed"');
    expect(html).toContain('id="chart-humidity"');

    // data-effect bridge pattern (spike 4 recommended)
    expect(html).toContain("data-effect=\"document.getElementById('chart-temp')?.addPoint");
    expect(html).toContain("data-effect=\"document.getElementById('chart-pressure')?.addPoint");
    expect(html).toContain("data-effect=\"document.getElementById('chart-speed')?.addPoint");
    expect(html).toContain("data-effect=\"document.getElementById('chart-humidity')?.addPoint");
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

  it("uses colon syntax for all Datastar attributes (no hyphen syntax)", () => {
    const adapter = mockAdapter({
      policy: { mode: "local_network", summary: "LAN" },
    });
    const html = DashboardPage({ adapter });

    // These are the correct RC.7 colon syntax attributes used in the page:
    // data-init, data-signals, data-text, data-effect, data-show
    // None of these need colon syntax because they're not keyed attributes.
    // Keyed attributes like data-on:click or data-signals:name use colons.

    // Verify NO hyphen-style keyed attributes are present
    // data-on-click, data-on-load, data-signals-name are all WRONG
    const hyphenKeyed = html.match(/data-on-[a-z]/g);
    // data-on:click would be correct — but we don't have click handlers in the dashboard yet
    // The main risk is data-on-load (beta.11) vs data-init (RC.7)
    expect(html).not.toContain("data-on-load");
    expect(html).not.toContain("data-on-click"); // no click handlers expected
    expect(html).not.toContain("data-signals-"); // should use data-signals= (object form)

    // Verify we DO have the correct RC.7 attributes
    expect(html).toContain("data-init=");
    expect(html).toContain("data-signals=");
    expect(html).toContain("data-text=");
    expect(html).toContain("data-effect=");
    expect(html).toContain("data-show=");
  });

  // ── Script tags ───────────────────────────────────────────────────────

  it("includes all required script tags", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('src="/static/echarts.min.js"');
    expect(html).toContain('src="/static/components/line-chart.js"');
    expect(html).toContain('src="/static/datastar.js"');
    // Datastar must be loaded as module
    expect(html).toContain('type="module" src="/static/datastar.js"');
  });

  // ── Navigation ────────────────────────────────────────────────────────

  it("includes navigation link to certificates page", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain('href="/certificates"');
    expect(html).toContain("Certificates");
  });

  // ── Footer ────────────────────────────────────────────────────────────

  it("includes footer with version and mode", () => {
    const adapter = mockAdapter();
    const html = DashboardPage({ adapter });

    expect(html).toContain("v0.1.0");
    expect(html).toContain("running");
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests (server running)
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

  it("response contains full dashboard HTML", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain("CollatrEdge");
    expect(html).toContain("data-init");
    expect(html).toContain("/api/dashboard/stream");
    expect(html).toContain("chart-temp");
  });

  it("response contains network policy banner", async () => {
    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain("LOCAL NETWORK");
    expect(html).toContain("LAN only");
  });
});
