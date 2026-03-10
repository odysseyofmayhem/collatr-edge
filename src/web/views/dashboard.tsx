// CollatrEdge — Dashboard page component (config-driven)
// PRD refs: §17 Local Web UI (MVP Features, Design principle), §10 Network Policy
// Phase 12 Task 12.1: config-driven equipment cards replacing hardcoded 4-signal layout
//
// Architecture decisions applied:
// - AD-1: Equipment grouping by metric name prefix
// - AD-3: Landing page is live values, not charts
// - AD-6: Datastar signals are dynamic (derived from signal descriptors)
// - AD-7: Boolean signals rendered as indicators, not values

import type { WebUIAdapter } from "../adapter";
import { collectMetricNames } from "../adapter-helpers";
import { buildSignalDescriptors, type EquipmentGroup } from "../signal-descriptors";
import { Layout } from "./layout";
import { EquipmentCard } from "./fragments/equipment-card";
import { StatusPanelFragment } from "./fragments/status-panel";
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
// Dashboard page
// ---------------------------------------------------------------------------

export function DashboardPage({ adapter }: DashboardProps): string {
  const status = adapter.getStatus();
  const policy = adapter.getNetworkPolicy();

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
              {StatusPanelFragment({ adapter }) as "safe"}
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

