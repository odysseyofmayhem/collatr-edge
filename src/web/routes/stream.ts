// CollatrEdge — SSE streaming endpoint for dashboard live updates
// PRD refs: §17 Local Web UI, §15 Observability
// Phase 9 Task 9.3: live metrics + status panel updates via SSE
//
// Spike findings applied:
// - SDK `stream()` returns Response directly — Elysia passes it through
// - patchSignals takes JSON string (not object)
// - patchElements takes HTML string (Kita JSX = plain string)
// - Mixed signals + elements in one SSE stream: verified working
// - keepalive: true keeps stream open after first await
// - Event names: datastar-patch-signals, datastar-patch-elements (RC.7)

import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { WebUIAdapter, LiveMetricValue } from "../adapter";
import { StatusPanelFragment } from "../views/fragments/status-panel";
import type { FieldValue } from "../../core/metric";

// ---------------------------------------------------------------------------
// Signal flattening
// ---------------------------------------------------------------------------

/**
 * Flatten adapter metrics into a signal object for Datastar patchSignals.
 * Format: { metricName_fieldName: value, ... , chartTs: epochMs }
 *
 * Signal names are sanitised to valid JS identifiers (alphanumeric + underscore).
 * Field values are converted to display-friendly strings/numbers.
 */
export function flattenMetrics(
  metrics: Map<string, LiveMetricValue>,
): Record<string, string | number> {
  const signals: Record<string, string | number> = {};
  let latestTs = 0;

  for (const [name, metric] of metrics) {
    for (const [field, value] of Object.entries(metric.fields)) {
      const key = sanitiseSignalName(`${name}_${field}`);
      signals[key] = formatFieldValue(value);
    }
    // Track latest timestamp for chart bridge (nanoseconds → milliseconds)
    const tsMs = Number(metric.timestamp) / 1e6;
    if (tsMs > latestTs) {
      latestTs = tsMs;
    }
  }

  signals.chartTs = latestTs;
  return signals;
}

/** Sanitise a metric/field name to a valid Datastar signal name. */
function sanitiseSignalName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Convert a FieldValue to a display-friendly string or number. */
function formatFieldValue(value: FieldValue): string | number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

// ---------------------------------------------------------------------------
// SSE stream handler
// ---------------------------------------------------------------------------

/** Intervals for SSE updates */
const SIGNAL_INTERVAL_MS = 1000;
const ELEMENT_INTERVAL_MS = 2000;

/**
 * Create the SSE dashboard stream route handler.
 * Returns a Response with Content-Type: text/event-stream.
 *
 * Sends:
 * - patchSignals every ~1s with flattened live metric values
 * - patchElements every ~2s with status panel + plugin table HTML
 */
export function createDashboardStream(adapter: WebUIAdapter): Response {
  return ServerSentEventGenerator.stream(
    async (stream) => {
      let tick = 0;
      try {
        while (true) {
          // ── Signal update (every tick = every 1s) ─────────────────
          const metrics = adapter.getLiveMetrics();
          const signals = flattenMetrics(metrics);
          stream.patchSignals(JSON.stringify(signals));

          // ── Element patch (every 2nd tick = every 2s) ─────────────
          if (tick % (ELEMENT_INTERVAL_MS / SIGNAL_INTERVAL_MS) === 0) {
            const statusHtml = StatusPanelFragment({ adapter });
            stream.patchElements(statusHtml);
          }

          tick++;
          await Bun.sleep(SIGNAL_INTERVAL_MS);
        }
      } catch (err) {
        // Client disconnect is expected — only log unexpected errors
        if (
          err instanceof Error &&
          !err.message.includes("abort") &&
          !err.message.includes("cancel") &&
          !err.message.includes("closed")
        ) {
          console.error("[web] SSE stream error:", err.message);
        }
      }
    },
    { keepalive: true },
  );
}
