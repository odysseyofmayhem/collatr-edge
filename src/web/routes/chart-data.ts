// CollatrEdge — Chart data endpoints for historical queries and metric discovery
// PRD refs: §17 Local Web UI (Trend Charts), §11 Local Data Store
// Phase 9 Task 9.4: ECharts trend charts — historical data load + live append via SSE

import type { WebUIAdapter } from "../adapter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NS_PER_MS = 1_000_000n;
const MS_PER_HOUR = 3_600_000;
const DEFAULT_LOOKBACK_MS = 24 * MS_PER_HOUR; // PRD §17: last 24h trend
const MAX_POINTS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChartDataPoint {
  timestamp: number; // epoch milliseconds
  value: number;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/chart/history?metric=<name>&from=<iso>&to=<iso>
 *
 * Query LocalStoreOutput for the time range, filter by metric name,
 * return JSON array of {timestamp, value} points.
 * Default 'from' to 24 hours ago, 'to' to now.
 * First numeric field value is returned per data point.
 * Capped at MAX_POINTS — downsamples by taking every Nth point.
 */
export function handleChartHistory(
  adapter: WebUIAdapter,
  query: { metric?: string; from?: string; to?: string },
): Response {
  const metricName = query.metric;
  if (!metricName) {
    return new Response(
      JSON.stringify({ error: "metric parameter is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const now = Date.now();
  const toMs = query.to ? new Date(query.to).getTime() : now;
  const fromMs = query.from
    ? new Date(query.from).getTime()
    : toMs - DEFAULT_LOOKBACK_MS;

  if (isNaN(fromMs) || isNaN(toMs)) {
    return new Response(
      JSON.stringify({ error: "invalid from/to timestamp" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const store = adapter.getLocalStore();
  if (!store) {
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const fromNs = BigInt(fromMs) * NS_PER_MS;
  const toNs = BigInt(toMs) * NS_PER_MS;

  const rows = store.query(fromNs, toNs);

  // Filter to requested metric name and extract first numeric field value
  const points: ChartDataPoint[] = [];
  for (const row of rows) {
    if (row.name !== metricName) continue;

    const numericValue = firstNumericField(row.fields);
    if (numericValue === null) continue;

    points.push({
      timestamp: Number(row.timestamp / NS_PER_MS),
      value: numericValue,
    });
  }

  // Downsample if exceeding MAX_POINTS — take every Nth point
  const result = downsample(points, MAX_POINTS);

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/chart/metrics
 *
 * Return list of available metric names from the local store.
 */
export function handleChartMetrics(adapter: WebUIAdapter): Response {
  const store = adapter.getLocalStore();
  if (!store) {
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const names = store.listMetricNames();
  return new Response(JSON.stringify(names), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first numeric field value from a field record. */
function firstNumericField(
  fields: Record<string, unknown>,
): number | null {
  for (const value of Object.values(fields)) {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
  }
  return null;
}

/**
 * Downsample an array of points to fit within maxPoints.
 * Takes every Nth point to preserve the full time range.
 */
export function downsample(
  points: ChartDataPoint[],
  maxPoints: number,
): ChartDataPoint[] {
  if (points.length <= maxPoints) return points;

  const step = points.length / maxPoints;
  const result: ChartDataPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.floor(i * step);
    result.push(points[idx]!);
  }

  // Always include the last point for accurate time range
  if (result.length > 0 && result[result.length - 1] !== points[points.length - 1]) {
    result[result.length - 1] = points[points.length - 1]!;
  }

  return result;
}
