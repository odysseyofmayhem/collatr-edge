// CollatrEdge — Status panel SSE fragment
// Phase 9 Task 9.3: server-rendered JSX fragment for patchElements
// Phase 12 Task 12.9: pipeline operational counters (gathered/written/dropped/errors)
// Must have id="status-panel" to match the target div in dashboard.tsx

import type { WebUIAdapter, PluginHealth } from "../../adapter";

// ---------------------------------------------------------------------------
// Plugin health table (inline — shared with dashboard.tsx initial render)
// ---------------------------------------------------------------------------

function PluginHealthTable({ plugins }: { plugins: PluginHealth[] }): string {
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
// Status panel fragment
// ---------------------------------------------------------------------------

export function StatusPanelFragment({
  adapter,
}: {
  adapter: WebUIAdapter;
}): string {
  const mem = adapter.getMemoryUsage();
  const uptime = adapter.getUptime();
  const plugins = adapter.getPluginHealth();
  const stats = adapter.getStats();

  return (
    <div id="status-panel">
      <div class="status-stats">
        <div class="stat-card">
          <span class="stat-label">Uptime</span>
          <strong>{formatDuration(uptime)}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Heap</span>
          <strong>{Math.round(mem.heapUsed / 1024 / 1024)} MB</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">RSS</span>
          <strong>{Math.round(mem.rss / 1024 / 1024)} MB</strong>
        </div>
      </div>
      {stats
        ? (
            <div class="status-stats" style="margin-top:8px;">
              <div class="stat-card">
                <span class="stat-label">Gathered</span>
                <strong>{stats.metricsGathered.toLocaleString()}</strong>
              </div>
              <div class="stat-card">
                <span class="stat-label">Written</span>
                <strong>{stats.metricsWritten.toLocaleString()}</strong>
              </div>
              <div class="stat-card">
                <span class="stat-label">Dropped</span>
                <strong class={stats.metricsDropped > 0 ? "stat-warn" : ""}>{stats.metricsDropped.toLocaleString()}</strong>
              </div>
              <div class="stat-card">
                <span class="stat-label">Gather Errors</span>
                <strong class={stats.gatherErrors > 0 ? "stat-error" : ""}>{stats.gatherErrors.toLocaleString()}</strong>
              </div>
              <div class="stat-card">
                <span class="stat-label">Write Errors</span>
                <strong class={stats.writeErrors > 0 ? "stat-error" : ""}>{stats.writeErrors.toLocaleString()}</strong>
              </div>
            </div>
          ) as "safe"
        : ""}
      {PluginHealthTable({ plugins }) as "safe"}
    </div>
  ) as string;
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
