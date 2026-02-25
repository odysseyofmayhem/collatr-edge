// CollatrEdge — Status panel SSE fragment
// Phase 9 Task 9.3: server-rendered JSX fragment for patchElements
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

  return (
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
          <strong>{Math.round(mem.heapUsed / 1024 / 1024)} MB</strong>
        </div>
        <div>
          <span style="color:#888;font-size:0.85rem;">RSS</span>
          <br />
          <strong>{Math.round(mem.rss / 1024 / 1024)} MB</strong>
        </div>
      </div>
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
