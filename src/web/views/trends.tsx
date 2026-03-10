// CollatrEdge — Trends page component (config-driven historical charts)
// PRD refs: §17 Local Web UI (Trend Charts), §11 Local Data Store
// Phase 12 Task 12.3: hybrid curated defaults + metric picker
//
// Architecture decisions applied:
// - AD-4: Hybrid trend charts — curated defaults + metric picker
// - AD-1: Equipment grouping by metric name prefix

import type { WebUIAdapter } from "../adapter";
import { collectMetricNames } from "../adapter-helpers";
import { buildSignalDescriptors, type EquipmentGroup, type SignalDescriptor } from "../signal-descriptors";
import { Layout } from "./layout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrendsProps {
  adapter: WebUIAdapter;
}

// ---------------------------------------------------------------------------
// Chart colour palette per equipment group (cycling)
// ---------------------------------------------------------------------------

const CHART_COLOURS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#10b981", // green
  "#f59e0b", // amber
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
];

function chartColour(index: number): string {
  return CHART_COLOURS[index % CHART_COLOURS.length]!;
}

// ---------------------------------------------------------------------------
// Time range options
// ---------------------------------------------------------------------------

interface TimeRange {
  label: string;
  hours: number;
}

const TIME_RANGES: TimeRange[] = [
  { label: "Last Hour", hours: 1 },
  { label: "Last Shift", hours: 8 },
  { label: "Last 24h", hours: 24 },
  { label: "Last Week", hours: 168 },
];

// ---------------------------------------------------------------------------
// Chart card for a single signal
// ---------------------------------------------------------------------------

function ChartCard({
  descriptor,
  colour,
  removable,
}: {
  descriptor: SignalDescriptor;
  colour: string;
  removable: boolean;
}): string {
  const title = descriptor.unit
    ? `${descriptor.displayName} (${descriptor.unit})`
    : descriptor.displayName;

  return (
    <div class="chart-card" data-metric={descriptor.name}>
      <div class="chart-card-header">
        <span class="chart-card-title">{title}</span>
        {removable
          ? (<button class="chart-remove-btn" data-remove-metric={descriptor.name} title="Remove chart">&times;</button>)
          : ""}
      </div>
      <collatr-line-chart
        metric={descriptor.name}
        color={colour}
        unit={descriptor.unit}
        height="200px"
      ></collatr-line-chart>
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Equipment section with default charts and metric picker
// ---------------------------------------------------------------------------

function EquipmentSection({
  group,
  colourOffset,
}: {
  group: EquipmentGroup;
  colourOffset: number;
}): string {
  // Only include numeric signals (no booleans, counters, enums in charts)
  const numericSignals = group.signals.filter((s) => s.type === "numeric");

  if (numericSignals.length === 0) return "" as string;

  // Default charts (curated or all-numeric for unknown equipment)
  const defaultSignalNames = new Set(group.defaultTrendSignals);
  const defaultSignals = numericSignals.filter((s) => defaultSignalNames.has(s.name));
  const pickerSignals = numericSignals.filter((s) => !defaultSignalNames.has(s.name));

  return (
    <div class="trends-section" data-equipment={group.id}>
      <h2 class="trends-section-title">{group.displayName}</h2>

      {/* Default charts */}
      <div class="trends-charts" data-charts-for={group.id}>
        {defaultSignals.map((s, i) =>
          ChartCard({
            descriptor: s,
            colour: chartColour(colourOffset + i),
            removable: false,
          }),
        ).join("") as "safe"}
      </div>

      {/* Metric picker dropdown (only if there are non-default signals to add) */}
      {pickerSignals.length > 0
        ? (
            <div class="metric-picker" data-picker-for={group.id}>
              <select class="metric-picker-select" data-picker-select={group.id}>
                <option value="">+ Add metric</option>
                {pickerSignals.map((s) => {
                  const label = s.unit
                    ? `${s.displayName} (${s.unit})`
                    : s.displayName;
                  return (<option value={s.name} data-unit={s.unit} data-display-name={s.displayName}>{label}</option>) as string;
                }).join("") as "safe"}
              </select>
            </div>
          )
        : ""}
    </div>
  ) as string;
}

// ---------------------------------------------------------------------------
// Trends page
// ---------------------------------------------------------------------------

export function TrendsPage({ adapter }: TrendsProps): string {
  const status = adapter.getStatus();
  const metricNames = collectMetricNames(adapter);
  const groups = buildSignalDescriptors(metricNames);

  // Track colour offset across sections for visual variety
  let colourOffset = 0;

  return Layout({
    title: "CollatrEdge \u2014 Trends",
    children: (
      <>
        {/* 1. Header bar with navigation */}
        <div class="header">
          <h1>CollatrEdge</h1>
          <div style="display:flex;align-items:center;">
            <nav>
              <a href="/">Dashboard</a>
              <a href="/trends" class="nav-active">Trends</a>
              <a href="/certificates">Certificates</a>
            </nav>
            <span class={`badge badge-${status.state}`}>
              {status.state === "running"
                ? "Pipeline Running"
                : status.state === "starting"
                  ? "Pipeline Starting"
                  : status.state === "stopping"
                    ? "Pipeline Stopping"
                    : "Pipeline Stopped"}
            </span>
          </div>
        </div>

        <div class="container">
          {/* 2. Time range selector */}
          <div class="time-range-bar">
            <span class="time-range-label">Time Range:</span>
            {TIME_RANGES.map((tr, i) => (
              <button
                class={`time-range-btn${i === 0 ? " time-range-active" : ""}`}
                data-time-range={String(tr.hours)}
              >
                {tr.label}
              </button>
            )).join("") as "safe"}
          </div>

          {/* 3. Equipment sections with charts */}
          {groups.length > 0
            ? groups.map((g) => {
                const html = EquipmentSection({ group: g, colourOffset });
                // Advance colour offset by number of default trend signals
                colourOffset += g.defaultTrendSignals.length;
                return html;
              }).join("") as "safe"
            : (<div class="card card-full"><p style="color:#94a3b8;text-align:center;">No metrics yet &mdash; waiting for data&hellip;</p></div>) as "safe"}

          {/* 4. Footer */}
          <div class="footer">CollatrEdge v0.1.0 &mdash; {status.state}</div>
        </div>

        {/* 5. Client-side metric picker + time range JS */}
        <script type="module" src="/static/components/metric-picker.js"></script>
      </>
    ) as string,
  });
}
