// CollatrEdge — WebUIAdapter helper functions (shared across views)
// Phase 12 Task 12.7: extracted from dashboard.tsx and trends.tsx (review finding F-02)

import type { WebUIAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// Collect metric names from all available sources
// ---------------------------------------------------------------------------

export function collectMetricNames(adapter: WebUIAdapter): string[] {
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
