// CollatrEdge — Base HTML layout for all Web UI pages
// PRD refs: §17 Local Web UI (Technology, Design principle)
// Phase 9 Task 9.2: server-rendered JSX shell

// ---------------------------------------------------------------------------
// Layout component
// Renders the full HTML document with embedded script tags for Datastar,
// ECharts, and the line-chart web component. All assets are served from
// /static/* and embedded in the compiled binary (spike 5 pattern).
// ---------------------------------------------------------------------------

export function Layout({
  title,
  children,
}: {
  title: string;
  children: string;
}): string {
  const markup = (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <style>{CSS}</style>
      </head>
      <body>
        {children as "safe"}
        <script src="/static/echarts.min.js"></script>
        <script type="module" src="/static/components/line-chart.js"></script>
        <script type="module" src="/static/components/staleness.js"></script>
        <script type="module" src="/static/datastar.js"></script>
      </body>
    </html>
  ) as string;
  return `<!DOCTYPE html>${markup}`;
}

// ---------------------------------------------------------------------------
// CSS — inline styles for the dashboard
// PRD §17: "legible to non-technical people", "clear labels",
// "traffic-light status indicators"
// ---------------------------------------------------------------------------

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }

  /* Header & navigation */
  .header { background: #0f172a; color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
  .header .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 500; margin-left: 12px; }
  .header nav { display: flex; align-items: center; }
  .header nav a { color: #94a3b8; text-decoration: none; font-size: 0.85rem; margin-left: 16px; padding: 4px 8px; border-radius: 4px; transition: color 0.15s, background 0.15s; }
  .header nav a:hover { color: white; background: rgba(255,255,255,0.08); }
  .header nav a.nav-active { color: white; background: rgba(255,255,255,0.12); font-weight: 500; }
  .badge-running { background: #166534; color: #bbf7d0; }
  .badge-starting { background: #854d0e; color: #fef08a; }
  .badge-stopped { background: #991b1b; color: #fecaca; }
  .badge-stopping { background: #854d0e; color: #fef08a; }

  /* Network policy banners */
  .banner-standalone { background: #fecaca; border-bottom: 1px solid #f87171; padding: 8px 24px; font-size: 0.85rem; color: #991b1b; display: flex; align-items: center; gap: 8px; }
  .banner-local_network { background: #fef3c7; border-bottom: 1px solid #fcd34d; padding: 8px 24px; font-size: 0.85rem; color: #92400e; display: flex; align-items: center; gap: 8px; }
  .banner-connected { background: #dcfce7; border-bottom: 1px solid #86efac; padding: 8px 24px; font-size: 0.85rem; color: #166534; display: flex; align-items: center; gap: 8px; }

  /* Layout */
  .container { max-width: 1100px; margin: 0 auto; padding: 20px 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  /* Cards */
  .card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 0.9rem; color: #64748b; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .card-full { grid-column: 1 / -1; }

  /* Equipment cards — full-width, structured sections */
  .card-equipment { padding: 20px; }
  .card-equipment .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; }
  .card-equipment .card-header h2 { margin-bottom: 0; }

  /* Equipment status indicator */
  .equipment-status { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; }
  .status-dot-inline { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #9ca3af; }
  .status-running .status-dot-inline { background: #22c55e; }
  .status-fault .status-dot-inline { background: #ef4444; }
  .status-stopped .status-dot-inline { background: #9ca3af; }

  /* Signal grid — responsive 3-4 columns within equipment cards */
  .signal-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px 16px; margin-bottom: 12px; }
  @media (max-width: 1024px) { .signal-grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 768px) { .signal-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 480px) { .signal-grid { grid-template-columns: 1fr; } }

  /* Signal values — shared layout */
  .signal-value { display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: 6px; background: #f8fafc; }
  .signal-label { color: #64748b; font-size: 0.78rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .signal-reading { font-weight: 600; font-size: 1.1rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .signal-unit { font-weight: 400; color: #94a3b8; font-size: 0.8rem; }
  .signal-paired .signal-reading { font-size: 0.95rem; }

  /* Counter signals — monospace */
  .signal-reading-counter { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }

  /* Boolean indicators — coloured dots with labels */
  .signal-booleans { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; padding-top: 12px; border-top: 1px solid #f1f5f9; }
  .signal-bool { flex-direction: row; align-items: center; gap: 6px; background: transparent; padding: 4px 8px; }
  .bool-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #9ca3af; flex-shrink: 0; }
  .bool-label { font-size: 0.82rem; color: #475569; }
  .bool-on { background: #22c55e; }
  .bool-ok { background: #22c55e; }
  .bool-off { background: #9ca3af; }
  .bool-alarm { background: #ef4444; }

  /* Enum badges — coloured pill badges */
  .enum-badge { display: inline-block; padding: 2px 10px; border-radius: 9999px; font-size: 0.8rem; font-weight: 500; background: #e2e8f0; color: #475569; }
  .enum-grey { background: #e2e8f0; color: #475569; }
  .enum-amber { background: #fef3c7; color: #92400e; }
  .enum-green { background: #dcfce7; color: #166534; }
  .enum-blue { background: #dbeafe; color: #1e40af; }
  .enum-red { background: #fee2e2; color: #991b1b; }

  /* Legacy metric styles (pipeline status panel) */
  .metric { display: flex; flex-direction: column; gap: 2px; }
  .metric-label { font-size: 0.8rem; color: #94a3b8; }
  .metric-value { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .metric-unit { font-size: 0.9rem; font-weight: 400; color: #94a3b8; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }

  /* Plugin health table */
  .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .dot-ok { background: #22c55e; }
  .dot-error { background: #ef4444; }
  .dot-stopped { background: #9ca3af; }

  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  table thead tr { border-bottom: 2px solid #e5e7eb; text-align: left; }
  table th, table td { padding: 6px 8px; }
  table tbody tr { border-bottom: 1px solid #f3f4f6; }

  /* Export form */
  .export-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .export-bar input { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; }
  .export-bar label { font-size: 0.85rem; color: #64748b; }
  .export-bar button { padding: 6px 16px; background: #0f172a; color: white; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer; }
  .export-bar button:hover { background: #1e293b; }

  .footer { text-align: center; padding: 16px; font-size: 0.75rem; color: #94a3b8; }

  /* Trends page — time range bar */
  .time-range-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
  .time-range-label { font-size: 0.85rem; color: #64748b; font-weight: 500; margin-right: 4px; }
  .time-range-btn { padding: 6px 14px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; font-size: 0.82rem; color: #475569; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
  .time-range-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }
  .time-range-active { background: #0f172a; color: white; border-color: #0f172a; }
  .time-range-active:hover { background: #1e293b; border-color: #1e293b; }

  /* Trends page — equipment sections */
  .trends-section { margin-bottom: 32px; }
  .trends-section-title { font-size: 0.95rem; color: #334155; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; margin-bottom: 16px; }
  .trends-charts { display: flex; flex-direction: column; gap: 16px; }

  /* Trends page — chart cards */
  .chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .chart-card-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid #f1f5f9; }
  .chart-card-title { font-size: 0.85rem; font-weight: 500; color: #334155; }
  .chart-remove-btn { background: none; border: none; color: #94a3b8; font-size: 1.2rem; cursor: pointer; padding: 0 4px; line-height: 1; }
  .chart-remove-btn:hover { color: #ef4444; }

  /* Trends page — metric picker */
  .metric-picker { margin-top: 12px; margin-bottom: 8px; }
  .metric-picker-select { padding: 6px 12px; border: 1px dashed #cbd5e1; border-radius: 6px; background: white; font-size: 0.82rem; color: #64748b; cursor: pointer; min-width: 180px; }
  .metric-picker-select:hover { border-color: #94a3b8; }

  /* Staleness detection — Phase 12 Task 12.4 */
  .signal-fresh { transition: border-color 0.3s, opacity 0.3s; }
  .signal-stale { border-left: 3px solid #f59e0b; padding-left: 8px; }
  .signal-stale .signal-reading, .signal-stale .enum-badge, .signal-stale .bool-dot { opacity: 0.7; }
  .signal-dead { border-left: 3px solid #ef4444; padding-left: 8px; }
  .signal-dead .signal-reading, .signal-dead .enum-badge, .signal-dead .bool-dot { opacity: 0.5; }
  .signal-dead::after { content: 'No data'; font-size: 0.7rem; color: #ef4444; margin-left: 8px; }

  /* Print styles — PRD §17: printable summaries for BRC audits */
  @media print {
    body { background: white; }
    .header { background: #333; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .header nav { display: none; }
    .banner-standalone, .banner-local_network, .banner-connected { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .export-bar, .time-range-bar, .metric-picker, .chart-remove-btn { display: none; }
    .card, .card-equipment, .chart-card { break-inside: avoid; border: 1px solid #ccc; box-shadow: none; }
    .signal-grid { grid-template-columns: repeat(3, 1fr); }
    .footer { font-size: 0.7rem; }
  }
`;
