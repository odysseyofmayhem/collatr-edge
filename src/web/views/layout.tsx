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

  .header { background: #0f172a; color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
  .header .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 500; }
  .header nav a { color: #94a3b8; text-decoration: none; font-size: 0.85rem; margin-left: 16px; }
  .header nav a:hover { color: white; }
  .badge-running { background: #166534; color: #bbf7d0; }
  .badge-starting { background: #854d0e; color: #fef08a; }
  .badge-stopped { background: #991b1b; color: #fecaca; }
  .badge-stopping { background: #854d0e; color: #fef08a; }

  .banner-standalone { background: #fecaca; border-bottom: 1px solid #f87171; padding: 8px 24px; font-size: 0.85rem; color: #991b1b; display: flex; align-items: center; gap: 8px; }
  .banner-local_network { background: #fef3c7; border-bottom: 1px solid #fcd34d; padding: 8px 24px; font-size: 0.85rem; color: #92400e; display: flex; align-items: center; gap: 8px; }
  .banner-connected { background: #dcfce7; border-bottom: 1px solid #86efac; padding: 8px 24px; font-size: 0.85rem; color: #166534; display: flex; align-items: center; gap: 8px; }

  .container { max-width: 1100px; margin: 0 auto; padding: 20px 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 0.9rem; color: #64748b; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .card-full { grid-column: 1 / -1; }

  .metric { display: flex; flex-direction: column; gap: 2px; }
  .metric-label { font-size: 0.8rem; color: #94a3b8; }
  .metric-value { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .metric-unit { font-size: 0.9rem; font-weight: 400; color: #94a3b8; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }

  .signal-value { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 4px 0; }
  .signal-label { color: #64748b; font-size: 0.85rem; white-space: nowrap; }
  .signal-reading { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .signal-unit { font-weight: 400; color: #94a3b8; font-size: 0.85rem; }
  .signal-reading-counter { font-family: 'SF Mono', 'Menlo', monospace; }
  .signal-paired .signal-reading { font-size: 0.95rem; }

  .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .dot-ok { background: #22c55e; }
  .dot-error { background: #ef4444; }
  .dot-stopped { background: #9ca3af; }

  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  table thead tr { border-bottom: 2px solid #e5e7eb; text-align: left; }
  table th, table td { padding: 6px 8px; }
  table tbody tr { border-bottom: 1px solid #f3f4f6; }

  .export-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .export-bar input { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; }
  .export-bar label { font-size: 0.85rem; color: #64748b; }
  .export-bar button { padding: 6px 16px; background: #0f172a; color: white; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer; }
  .export-bar button:hover { background: #1e293b; }

  .footer { text-align: center; padding: 16px; font-size: 0.75rem; color: #94a3b8; }

  /* Staleness detection — Phase 12 Task 12.4 */
  .signal-fresh { transition: border-color 0.3s, opacity 0.3s; }
  .signal-stale { border-left: 3px solid #f59e0b; padding-left: 8px; }
  .signal-stale .signal-reading, .signal-stale .enum-badge, .signal-stale .bool-dot { opacity: 0.7; }
  .signal-dead { border-left: 3px solid #ef4444; padding-left: 8px; }
  .signal-dead .signal-reading, .signal-dead .enum-badge, .signal-dead .bool-dot { opacity: 0.5; }
  .signal-dead::after { content: 'No data'; font-size: 0.7rem; color: #ef4444; margin-left: 8px; }
`;
