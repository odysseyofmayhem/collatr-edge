// CollatrEdge — Plugin health table SSE fragment
// Phase 9 Task 9.3: standalone plugin table fragment for patchElements
// Must have id="plugin-table" to match the target div in dashboard.tsx

import type { PluginHealth } from "../../adapter";

export function PluginTableFragment({
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
