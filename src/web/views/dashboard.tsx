// CollatrEdge — Dashboard page component (config-driven)
// PRD refs: §17 Local Web UI (MVP Features, Design principle), §10 Network Policy
// Phase 12 Task 12.1: config-driven equipment cards replacing hardcoded 4-signal layout
//
// Architecture decisions applied:
// - AD-1: Equipment grouping by metric name prefix
// - AD-3: Landing page is live values, not charts
// - AD-6: Datastar signals are dynamic (derived from signal descriptors)
// - AD-7: Boolean signals rendered as indicators, not values

import type { WebUIAdapter, PluginHealth } from "../adapter";
import { buildSignalDescriptors, type EquipmentGroup } from "../signal-descriptors";
import { Layout } from "./layout";
import { EquipmentCard } from "./fragments/equipment-card";
import { toDatastarName } from "./fragments/signal-value";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardProps {
  adapter: WebUIAdapter;
}

// ---------------------------------------------------------------------------
// Network policy banner
// PRD §10: "persistent, prominent indicator on every page"
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
// Status badge
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
// Plugin health table
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
// Build Datastar signals initialisation object
// ---------------------------------------------------------------------------

function buildDatastarSignals(groups: EquipmentGroup[]): string {
  const signals: Record<string, string | number> = {};

  for (const group of groups) {
    for (const sig of group.signals) {
      const dsName = toDatastarName(sig.name);
      signals[dsName] = "\u2014"; // em-dash as initial value
    }
  }

  signals.chartTs = 0;
  return JSON.stringify(signals);
}

// ---------------------------------------------------------------------------
// Collect metric names from all available sources
// ---------------------------------------------------------------------------

function collectMetricNames(adapter: WebUIAdapter): string[] {
  const names = new Set<string>();

  // Live metrics (currently flowing through the pipeline)
  for (const key of adapter.getLiveMetrics().keys()) {
    names.add(key);
  }

  // Historical metric names from the local store
  const store = adapter.getLocalStore();
  if (store) {
    for (const name of store.listMetricNames()) {
      names.add(name);
    }
  }

  return Array.from(names);
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

  // Build config-driven equipment groups from available metric names
  const metricNames = collectMetricNames(adapter);
  const groups = buildSignalDescriptors(metricNames);
  const dataSignals = buildDatastarSignals(groups);

  return Layout({
    title: "CollatrEdge \u2014 Dashboard",
    children: (
      <>
        {/* 1. Header bar with navigation */}
        <div class="header">
          <h1>CollatrEdge</h1>
          <div style="display:flex;align-items:center;">
            <nav>
              <a href="/" class="nav-active">Dashboard</a>
              <a href="/trends">Trends</a>
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
            data-signals={dataSignals}
            data-init="@get('/api/dashboard/stream')"
          >
            {/* 3. Equipment cards — config-driven */}
            {groups.length > 0
              ? groups.map((g) => EquipmentCard({ group: g })).join("") as "safe"
              : (<div class="card card-full"><p style="color:#94a3b8;text-align:center;">No signals yet &mdash; waiting for data&hellip;</p></div>) as "safe"}

            {/* 4. Pipeline status — patched via SSE */}
            <div class="card card-full">
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

          {/* 5. CSV export form */}
          <div class="card card-full" style="margin-bottom:16px;">
            <h2>Data Export</h2>
            <form class="export-bar" action="/api/export" method="get">
              <label for="export-from">From:</label>
              <input type="datetime-local" id="export-from" name="from" />
              <label for="export-to">To:</label>
              <input type="datetime-local" id="export-to" name="to" />
              <input type="hidden" id="export-tz" name="tz" />
              <button type="submit">Export CSV</button>
            </form>
            <script>{"document.getElementById('export-tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone;"}</script>
          </div>

          {/* 6. Footer */}
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
