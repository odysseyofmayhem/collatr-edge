// CollatrEdge — Dashboard page component
// PRD refs: §17 Local Web UI (MVP Features, Design principle), §10 Network Policy
// Phase 9 Task 9.2: server-rendered JSX shell with Datastar attributes
//
// Spike findings applied:
// - RC.7 colon syntax: data-on:click, data-signals:name, data-init (NOT hyphen)
// - data-init for SSE entry point
// - data-effect for ECharts bridge (recommended pattern, Spike 4)
// - Kita JSX produces plain strings — no renderToString needed
// - Guard initial signal values in data-effect (timestamp < 1e12)

import type { WebUIAdapter, PluginHealth } from "../adapter";
import { Layout } from "./layout";

// ---------------------------------------------------------------------------
// Types for initial render
// ---------------------------------------------------------------------------

interface DashboardProps {
  adapter: WebUIAdapter;
}

// ---------------------------------------------------------------------------
// Network policy banner
// PRD §10: "persistent, prominent indicator on every page"
// Colour-coded: red standalone, amber local_network, green connected
// ---------------------------------------------------------------------------

function NetworkPolicyBanner({
  policy,
}: {
  policy: { mode: string; summary: string } | null;
}): string {
  if (!policy) return "" as string;

  const icons: Record<string, string> = {
    standalone: "\u{1F512}",
    local_network: "\u{1F3E0}",
    connected: "\u{1F310}",
  };

  const labels: Record<string, string> = {
    standalone: "STANDALONE",
    local_network: "LOCAL NETWORK",
    connected: "CONNECTED",
  };

  const icon = icons[policy.mode] ?? "\u{2139}\u{FE0F}";
  const label = labels[policy.mode] ?? policy.mode.toUpperCase();
  const showBanner = policy.mode !== "connected";

  return (
    <div
      class={`banner-${policy.mode}`}
      data-show={showBanner ? "true" : "false"}
    >
      <strong>
        {icon} {label}
      </strong>{" "}
      &mdash; {policy.summary}
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Status badge for pipeline state
// ---------------------------------------------------------------------------

function StatusBadge({ state }: { state: string }): string {
  const label =
    state === "running"
      ? "Pipeline Running"
      : state === "starting"
        ? "Pipeline Starting"
        : state === "stopping"
          ? "Pipeline Stopping"
          : "Pipeline Stopped";

  return (
    <span class={`badge badge-${state}`}>{label}</span>
  ) as string;
}

// ---------------------------------------------------------------------------
// Plugin health table — initial server-rendered, then patched via SSE
// ---------------------------------------------------------------------------

function PluginHealthTable({
  plugins,
}: {
  plugins: PluginHealth[];
}): string {
  return (
    <div id="plugin-table">
      <table>
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Type</th>
            <th>Status</th>
            <th style="text-align:right;">Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr>
              <td style="font-weight:500;">{p.alias}</td>
              <td style="color:#888;">{p.type}</td>
              <td>
                <span class={`status-dot dot-${p.status}`}></span>
                {p.status}
              </td>
              <td style="text-align:right;color:#888;">
                {p.lastActivity
                  ? `${Math.floor((Date.now() - p.lastActivity) / 1000)}s ago`
                  : "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export function DashboardPage({ adapter }: DashboardProps): string {
  const status = adapter.getStatus();
  const policy = adapter.getNetworkPolicy();
  const plugins = adapter.getPluginHealth();
  const mem = adapter.getMemoryUsage();
  const uptime = adapter.getUptime();

  return Layout({
    title: "CollatrEdge \u2014 Dashboard",
    children: (
      <>
        {/* 1. Header bar */}
        <div class="header">
          <h1>CollatrEdge</h1>
          <div style="display:flex;align-items:center;">
            <nav>
              <a href="/certificates">Certificates</a>
            </nav>
            {StatusBadge({ state: status.state }) as "safe"}
          </div>
        </div>

        {/* 2. Network policy banner */}
        {NetworkPolicyBanner({ policy }) as "safe"}

        <div class="container">
          {/* SSE data-init opens one stream for signals + element patches */}
          <div
            data-signals="{temperature: '0', pressure: '0', lineSpeed: '0', humidity: '0', chartTs: 0}"
            data-init="@get('/api/dashboard/stream')"
          >
            <div class="grid">
              {/* 3. Live metrics card */}
              <div class="card">
                <h2>Live Metrics</h2>
                <div class="metric-grid">
                  <div class="metric">
                    <span class="metric-label">Temperature</span>
                    <span class="metric-value">
                      <span data-text="$temperature">--</span>
                      <span class="metric-unit"> &deg;C</span>
                    </span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Pressure</span>
                    <span class="metric-value">
                      <span data-text="$pressure">--</span>
                      <span class="metric-unit"> hPa</span>
                    </span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Line Speed</span>
                    <span class="metric-value">
                      <span data-text="$lineSpeed">--</span>
                      <span class="metric-unit"> m/min</span>
                    </span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Humidity</span>
                    <span class="metric-value">
                      <span data-text="$humidity">--</span>
                      <span class="metric-unit"> %</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* 4. Plugin health table + status panel — patched via SSE */}
              <div class="card">
                <h2>Pipeline Status</h2>
                <div id="status-panel">
                  <div style="display:flex;gap:24px;margin-bottom:12px;">
                    <div>
                      <span style="color:#888;font-size:0.85rem;">Uptime</span>
                      <br />
                      <strong>{formatDuration(uptime)}</strong>
                    </div>
                    <div>
                      <span style="color:#888;font-size:0.85rem;">Heap</span>
                      <br />
                      <strong>
                        {Math.round(mem.heapUsed / 1024 / 1024)} MB
                      </strong>
                    </div>
                    <div>
                      <span style="color:#888;font-size:0.85rem;">RSS</span>
                      <br />
                      <strong>{Math.round(mem.rss / 1024 / 1024)} MB</strong>
                    </div>
                  </div>
                  {PluginHealthTable({ plugins }) as "safe"}
                </div>
              </div>
            </div>

            {/* 5. Trend charts — ECharts web components + data-effect bridge */}
            <div class="grid">
              <div class="card">
                <h2>Temperature Trend</h2>
                <collatr-line-chart
                  id="chart-temp"
                  color="#3b82f6"
                  unit="&deg;C"
                  height="220px"
                ></collatr-line-chart>
                <div data-effect="document.getElementById('chart-temp')?.addPoint($chartTs, parseFloat($temperature))"></div>
              </div>
              <div class="card">
                <h2>Pressure Trend</h2>
                <collatr-line-chart
                  id="chart-pressure"
                  color="#ef4444"
                  unit="hPa"
                  height="220px"
                ></collatr-line-chart>
                <div data-effect="document.getElementById('chart-pressure')?.addPoint($chartTs, parseFloat($pressure))"></div>
              </div>
            </div>
            <div class="grid">
              <div class="card">
                <h2>Line Speed Trend</h2>
                <collatr-line-chart
                  id="chart-speed"
                  color="#22c55e"
                  unit="m/min"
                  height="220px"
                ></collatr-line-chart>
                <div data-effect="document.getElementById('chart-speed')?.addPoint($chartTs, parseFloat($lineSpeed))"></div>
              </div>
              <div class="card">
                <h2>Humidity Trend</h2>
                <collatr-line-chart
                  id="chart-humidity"
                  color="#8b5cf6"
                  unit="%"
                  height="220px"
                ></collatr-line-chart>
                <div data-effect="document.getElementById('chart-humidity')?.addPoint($chartTs, parseFloat($humidity))"></div>
              </div>
            </div>
          </div>

          {/* 6. CSV export form */}
          <div class="card card-full" style="margin-bottom:16px;">
            <h2>Data Export</h2>
            <form class="export-bar" action="/api/export" method="get">
              <label for="export-from">From:</label>
              <input type="datetime-local" id="export-from" name="from" />
              <label for="export-to">To:</label>
              <input type="datetime-local" id="export-to" name="to" />
              <button type="submit">Export CSV</button>
            </form>
          </div>

          {/* 7. Footer */}
          <div class="footer">CollatrEdge v0.1.0 &mdash; {status.state}</div>
        </div>
      </>
    ) as string,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
