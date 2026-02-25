// Spike 6: Integration — Full Stack Dashboard Page
//
// Combines all spikes into a single working dashboard that demonstrates:
// - Server-rendered JSX with Datastar attributes (Spike 1)
// - SSE streaming with SDK patchSignals (Spike 2)
// - HTML fragment streaming with patchElements (Spike 3)
// - ECharts web component with data-effect bridge (Spike 4)
// - Static asset embedding for compiled binary (Spike 5)
// - CSV export

import { Elysia } from 'elysia'
import { html } from '@elysiajs/html'
import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web'

// ── Static asset embedding (Spike 5) ─────────────────────────────────────────
import datastarPath from '../public/datastar.js' with { type: 'file' }
import echartsPath from '../public/echarts.min.js' with { type: 'file' }
import lineChartPath from '../public/components/line-chart.js' with { type: 'file' }

const isCompiled = import.meta.dir.startsWith('/$bunfs')

const assetMap: Record<string, string> = {
  'datastar.js': datastarPath,
  'echarts.min.js': echartsPath,
  'components/line-chart.js': lineChartPath,
}

function mimeType(path: string): string {
  if (path.endsWith('.js')) return 'application/javascript'
  if (path.endsWith('.css')) return 'text/css'
  return 'application/octet-stream'
}

// ── Mock pipeline data ───────────────────────────────────────────────────────
const startTime = Date.now()

type PluginStatus = 'running' | 'error' | 'idle' | 'stopped'

interface PluginInfo {
  alias: string
  type: string
  stage: string
  status: PluginStatus
  lastActivity: number
  metricsCount: number
}

function mockPlugins(tick: number): PluginInfo[] {
  const statuses: PluginStatus[] = ['running', 'error', 'idle', 'running']
  return [
    { alias: 'packaging_plc', type: 'modbus', stage: 'input', status: statuses[tick % 4], lastActivity: Date.now() - (tick % 5) * 1000, metricsCount: 1240 + tick * 3 },
    { alias: 'historian', type: 'opcua', stage: 'input', status: statuses[(tick + 1) % 4], lastActivity: Date.now() - (tick % 3) * 2000, metricsCount: 890 + tick * 2 },
    { alias: 'line_mqtt', type: 'mqtt', stage: 'input', status: 'running', lastActivity: Date.now() - (tick % 2) * 500, metricsCount: 3400 + tick * 5 },
    { alias: 'rename_tags', type: 'rename', stage: 'processor', status: 'running', lastActivity: Date.now(), metricsCount: 5530 + tick * 10 },
    { alias: 'basic_stats', type: 'basicstats', stage: 'aggregator', status: 'running', lastActivity: Date.now() - 1000, metricsCount: 220 + tick },
    { alias: 'local_store', type: 'local_store', stage: 'output', status: 'running', lastActivity: Date.now(), metricsCount: 5530 + tick * 10 },
  ]
}

function mockMetrics(tick: number) {
  return {
    temperature: (20 + Math.sin(tick * 0.1) * 5 + (Math.random() - 0.5) * 0.5).toFixed(1),
    pressure: (1013 + Math.cos(tick * 0.08) * 10 + (Math.random() - 0.5) * 2).toFixed(1),
    lineSpeed: (12 + Math.sin(tick * 0.12) * 3 + (Math.random() - 0.5) * 0.3).toFixed(1),
    humidity: (45 + Math.sin(tick * 0.15) * 15 + (Math.random() - 0.5) * 1).toFixed(1),
  }
}

// ── JSX Components ───────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

function statusDot(status: PluginStatus): string {
  const colors: Record<PluginStatus, string> = {
    running: '#22c55e',
    error: '#ef4444',
    idle: '#eab308',
    stopped: '#9ca3af',
  }
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colors[status]};margin-right:6px;"></span>`
}

function StatusPanel({ uptime, mem, plugins }: {
  uptime: number
  mem: { heapUsed: number; rss: number }
  plugins: PluginInfo[]
}) {
  const runningCount = plugins.filter(p => p.status === 'running').length
  const errorCount = plugins.filter(p => p.status === 'error').length

  return (
    <div id="status-panel">
      <div style="display:flex;gap:24px;margin-bottom:12px;">
        <div>
          <span style="color:#888;font-size:0.85rem;">Uptime</span><br />
          <strong>{formatDuration(uptime)}</strong>
        </div>
        <div>
          <span style="color:#888;font-size:0.85rem;">Heap</span><br />
          <strong>{(mem.heapUsed / 1024 / 1024).toFixed(0)} MB</strong>
        </div>
        <div>
          <span style="color:#888;font-size:0.85rem;">RSS</span><br />
          <strong>{(mem.rss / 1024 / 1024).toFixed(0)} MB</strong>
        </div>
        <div>
          <span style="color:#888;font-size:0.85rem;">Plugins</span><br />
          <strong style={`color:${errorCount > 0 ? '#ef4444' : '#22c55e'}`}>{runningCount}/{plugins.length} running</strong>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <thead>
          <tr style="border-bottom:2px solid #e5e7eb;text-align:left;">
            <th style="padding:6px 8px;">Plugin</th>
            <th style="padding:6px 8px;">Type</th>
            <th style="padding:6px 8px;">Stage</th>
            <th style="padding:6px 8px;">Status</th>
            <th style="padding:6px 8px;text-align:right;">Metrics</th>
            <th style="padding:6px 8px;text-align:right;">Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {plugins.map(p => (
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:6px 8px;font-weight:500;">{p.alias}</td>
              <td style="padding:6px 8px;color:#888;">{p.type}</td>
              <td style="padding:6px 8px;color:#888;">{p.stage}</td>
              <td style="padding:6px 8px;">{statusDot(p.status) as 'safe'}{p.status}</td>
              <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">{p.metricsCount.toLocaleString()}</td>
              <td style="padding:6px 8px;text-align:right;color:#888;">{Math.floor((Date.now() - p.lastActivity) / 1000)}s ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) as string
}

// ── Dashboard page ───────────────────────────────────────────────────────────

function DashboardPage() {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>CollatrEdge — Dashboard</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }

          .header { background: #0f172a; color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
          .header h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
          .header .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 500; }
          .badge-running { background: #166534; color: #bbf7d0; }

          .network-banner { background: #fef3c7; border-bottom: 1px solid #fcd34d; padding: 8px 24px; font-size: 0.85rem; color: #92400e; display: flex; align-items: center; gap: 8px; }

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

          .export-bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
          .export-bar input { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.85rem; }
          .export-bar button { padding: 6px 16px; background: #0f172a; color: white; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer; }
          .export-bar button:hover { background: #1e293b; }

          .footer { text-align: center; padding: 16px; font-size: 0.75rem; color: #94a3b8; }
        `}</style>
      </head>
      <body>
        {/* Header */}
        <div class="header">
          <h1>CollatrEdge</h1>
          <span class="badge badge-running">Pipeline Running</span>
        </div>

        {/* Network policy banner */}
        <div class="network-banner">
          <strong>NETWORK POLICY:</strong> LOCAL NETWORK — egress allowed to 2 hosts (hub.factory.local, ntp.factory.local)
        </div>

        <div class="container">
          {/* Live metrics — signals via SSE (Spike 2) */}
          <div data-signals="{temperature: '0', pressure: '0', lineSpeed: '0', humidity: '0', chartTs: 0}" data-init="@get('/api/dashboard/stream')">

            <div class="grid">
              <div class="card">
                <h2>Live Metrics</h2>
                <div class="metric-grid">
                  <div class="metric">
                    <span class="metric-label">Temperature</span>
                    <span class="metric-value" data-text="$temperature"><span class="metric-unit">°C</span></span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Pressure</span>
                    <span class="metric-value" data-text="$pressure"><span class="metric-unit">hPa</span></span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Line Speed</span>
                    <span class="metric-value" data-text="$lineSpeed"><span class="metric-unit">m/min</span></span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Humidity</span>
                    <span class="metric-value" data-text="$humidity"><span class="metric-unit">%</span></span>
                  </div>
                </div>
              </div>

              {/* Pipeline status — element patches via SSE (Spike 3) */}
              <div class="card">
                <h2>Pipeline Status</h2>
                <div id="status-panel">Loading...</div>
              </div>
            </div>

            {/* Trend charts — ECharts web component + data-effect bridge (Spike 4) */}
            <div class="grid">
              <div class="card">
                <h2>Temperature Trend</h2>
                <collatr-line-chart id="chart-temp" color="#3b82f6" unit="°C" height="220px"></collatr-line-chart>
                <div data-effect="document.getElementById('chart-temp')?.addPoint($chartTs, parseFloat($temperature))"></div>
              </div>
              <div class="card">
                <h2>Pressure Trend</h2>
                <collatr-line-chart id="chart-pressure" color="#ef4444" unit="hPa" height="220px"></collatr-line-chart>
                <div data-effect="document.getElementById('chart-pressure')?.addPoint($chartTs, parseFloat($pressure))"></div>
              </div>
            </div>
            <div class="grid">
              <div class="card">
                <h2>Line Speed Trend</h2>
                <collatr-line-chart id="chart-speed" color="#22c55e" unit="m/min" height="220px"></collatr-line-chart>
                <div data-effect="document.getElementById('chart-speed')?.addPoint($chartTs, parseFloat($lineSpeed))"></div>
              </div>
              <div class="card">
                <h2>Humidity Trend</h2>
                <collatr-line-chart id="chart-humidity" color="#8b5cf6" unit="%" height="220px"></collatr-line-chart>
                <div data-effect="document.getElementById('chart-humidity')?.addPoint($chartTs, parseFloat($humidity))"></div>
              </div>
            </div>

          </div>

          {/* CSV export */}
          <div class="card card-full">
            <h2>Data Export</h2>
            <form class="export-bar" action="/api/export" method="get">
              <label for="from" style="font-size:0.85rem;color:#64748b;">From:</label>
              <input type="datetime-local" id="from" name="from" />
              <label for="to" style="font-size:0.85rem;color:#64748b;">To:</label>
              <input type="datetime-local" id="to" name="to" />
              <button type="submit">Export CSV</button>
            </form>
          </div>

          <div class="footer">
            CollatrEdge v0.0.0 — {isCompiled ? 'Compiled Binary' : 'Development Mode'} — Spike 6 Integration Test
          </div>
        </div>

        <script src="/static/echarts.min.js"></script>
        <script type="module" src="/static/components/line-chart.js"></script>
        <script type="module" src="/static/datastar.js"></script>
      </body>
    </html>
  ) as string
}

// ── CSV export mock ──────────────────────────────────────────────────────────

function generateMockCSV(from: string, to: string): string {
  const lines = ['timestamp,measurement,temperature,pressure,line_speed,humidity']
  const fromTs = from ? new Date(from).getTime() : Date.now() - 86400000
  const toTs = to ? new Date(to).getTime() : Date.now()
  const step = Math.max(60000, (toTs - fromTs) / 100) // ~100 rows

  for (let ts = fromTs; ts <= toTs; ts += step) {
    const i = (ts - fromTs) / 1000
    const temp = (20 + Math.sin(i * 0.001) * 5).toFixed(2)
    const pressure = (1013 + Math.cos(i * 0.0008) * 10).toFixed(2)
    const speed = (12 + Math.sin(i * 0.0012) * 3).toFixed(2)
    const humidity = (45 + Math.sin(i * 0.0015) * 15).toFixed(2)
    lines.push(`${new Date(ts).toISOString()},process_metrics,${temp},${pressure},${speed},${humidity}`)
  }

  return lines.join('\n') + '\n'
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = new Elysia()
  .use(html())

  .get('/', ({ html }) => html(DashboardPage()))

  // Mixed SSE stream — signals for live values, elements for status panel
  .get('/api/dashboard/stream', () => {
    return ServerSentEventGenerator.stream(async (stream) => {
      let tick = 0
      try {
        while (true) {
          const metrics = mockMetrics(tick)

          // Signal update — live metric values + chart timestamp
          stream.patchSignals(JSON.stringify({
            ...metrics,
            chartTs: Date.now(),
          }))

          // Element patch — status panel (every 2s)
          if (tick % 2 === 0) {
            const uptime = Date.now() - startTime
            const mem = {
              heapUsed: 45_000_000 + Math.sin(tick * 0.2) * 10_000_000,
              rss: 120_000_000 + Math.sin(tick * 0.1) * 15_000_000,
            }
            const fragment = StatusPanel({ uptime, mem, plugins: mockPlugins(tick) })
            stream.patchElements(fragment)
          }

          tick++
          await Bun.sleep(1000)
        }
      } catch {
        console.log(`[dashboard] client disconnected after ${tick}s`)
      }
    }, { keepalive: true })
  })

  // CSV export
  .get('/api/export', ({ query }) => {
    const from = (query.from as string) || ''
    const to = (query.to as string) || ''
    const csv = generateMockCSV(from, to)

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="collatr-edge-export-${Date.now()}.csv"`,
      },
    })
  })

  // Static files — works in both dev and compiled binary (Spike 5)
  .get('/static/*', ({ params }) => {
    const requestedPath = params['*']
    const embeddedPath = assetMap[requestedPath]
    if (!embeddedPath) return new Response('Not Found', { status: 404 })

    return new Response(Bun.file(embeddedPath), {
      headers: {
        'Content-Type': mimeType(requestedPath),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  })

  .listen(8080)

console.log(`CollatrEdge Dashboard (${isCompiled ? 'COMPILED' : 'DEV'}) at http://localhost:${app.server!.port}`)
