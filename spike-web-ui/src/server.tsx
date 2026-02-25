import { Elysia } from 'elysia'
import { html } from '@elysiajs/html'
import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web'

// ---------------------------------------------------------------------------
// Spikes 1–3: Elysia + Datastar RC.7 Web UI Stack Validation
//
// Client: Datastar RC.7 (downloaded bundle, not npm)
// Server: @starfederation/datastar-sdk RC.3 (npm)
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return '#22c55e'
    case 'error': return '#ef4444'
    case 'idle': return '#eab308'
    default: return '#9ca3af'
  }
}

// JSX component for the status panel (server-rendered, streamed as fragment)
function StatusPanel({ uptime, mem, plugins }: {
  uptime: number
  mem: { heapUsed: number; heapTotal: number }
  plugins: Array<{ alias: string; type: string; status: string; lastActivity: number }>
}) {
  return (
    <div id="status-panel">
      <p><strong>Uptime:</strong> {formatDuration(uptime)}</p>
      <p><strong>Memory:</strong> {(mem.heapUsed / 1024 / 1024).toFixed(1)} / {(mem.heapTotal / 1024 / 1024).toFixed(0)} MB</p>
      <table style="width:100%; border-collapse:collapse; margin-top:8px;">
        <thead>
          <tr style="border-bottom:2px solid #ddd; text-align:left;">
            <th style="padding:4px 8px;">Plugin</th>
            <th style="padding:4px 8px;">Type</th>
            <th style="padding:4px 8px;">Status</th>
            <th style="padding:4px 8px;">Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {plugins.map(p => (
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:4px 8px;">{p.alias}</td>
              <td style="padding:4px 8px; color:#888;">{p.type}</td>
              <td style="padding:4px 8px;">
                <span style={`color:${statusColor(p.status)};font-weight:bold;`}>{p.status}</span>
              </td>
              <td style="padding:4px 8px; color:#888;">{Math.floor((Date.now() - p.lastActivity) / 1000)}s ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) as string
}

const app = new Elysia()
  .use(html())

  // ── Page ──────────────────────────────────────────────────────────────────
  .get('/', ({ html }) => html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Spike 2 — SSE Streaming</title>
        <style>{`
          body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; }
          h1 { font-size: 1.4rem; }
          .section { margin: 20px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
          .section h2 { margin-top: 0; font-size: 1.1rem; color: #555; }
          .metric-row { display: flex; align-items: baseline; gap: 8px; margin: 8px 0; }
          .metric-label { color: #666; font-size: 0.9rem; min-width: 100px; }
          .metric-value { font-size: 1.8rem; font-weight: bold; font-variant-numeric: tabular-nums; }
          .tick { font-size: 0.85rem; color: #999; margin-top: 12px; }
          .approach { font-size: 0.8rem; color: #888; margin-bottom: 12px; }
        `}</style>
      </head>
      <body>
        <h1>Spike 2: SSE Streaming (Datastar RC.7)</h1>

        {/* Approach A: Datastar SDK stream() */}
        <div data-init="@get('/api/metrics/stream-sdk')">
          <div class="section">
            <h2>Live Metrics — SDK stream()</h2>
            <p class="approach">ServerSentEventGenerator.stream() from @starfederation/datastar-sdk/web</p>
            <div class="metric-row">
              <span class="metric-label">Temperature</span>
              <span class="metric-value" data-text="$temperature + '°C'">--</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Pressure</span>
              <span class="metric-value" data-text="$pressure + ' hPa'">--</span>
            </div>
            <p class="tick">Tick: <span data-text="$tick">--</span></p>
          </div>
        </div>

        {/* Approach B: Raw ReadableStream */}
        <div data-init="@get('/api/metrics/stream-raw')">
          <div class="section">
            <h2>Live Metrics — Raw ReadableStream</h2>
            <p class="approach">Manual SSE event formatting, no SDK</p>
            <div class="metric-row">
              <span class="metric-label">Humidity</span>
              <span class="metric-value" data-text="$humidity + '%'">--</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Line Speed</span>
              <span class="metric-value" data-text="$lineSpeed + ' m/min'">--</span>
            </div>
            <p class="tick">Tick: <span data-text="$rawTick">--</span></p>
          </div>
        </div>

        <script type="module" src="/static/datastar.js"></script>
      </body>
    </html>
  ))

  // ── Approach A: Datastar SDK stream() ─────────────────────────────────────
  .get('/api/metrics/stream-sdk', () => {
    return ServerSentEventGenerator.stream(async (stream) => {
      let i = 0
      try {
        while (true) {
          const temp = 20 + Math.sin(i * 0.1) * 5
          const pressure = 1013 + Math.cos(i * 0.1) * 10

          stream.patchSignals(JSON.stringify({
            temperature: temp.toFixed(1),
            pressure: pressure.toFixed(1),
            tick: i,
          }))

          i++
          await Bun.sleep(1000)
        }
      } catch {
        console.log(`[SDK stream] client disconnected after ${i} ticks`)
      }
    }, {
      keepalive: true,
      onAbort: () => console.log('[SDK stream] onAbort fired'),
      onError: (err) => console.error('[SDK stream] error:', err),
    })
  })

  // ── Approach B: Raw ReadableStream ────────────────────────────────────────
  .get('/api/metrics/stream-raw', () => {
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
      async start(controller) {
        let i = 0
        try {
          while (true) {
            const humidity = 45 + Math.sin(i * 0.15) * 15
            const lineSpeed = 12 + Math.cos(i * 0.08) * 3

            const signals = JSON.stringify({
              humidity: humidity.toFixed(1),
              lineSpeed: lineSpeed.toFixed(1),
              rawTick: i,
            })
            const event = `event: datastar-patch-signals\ndata: signals ${signals}\n\n`
            controller.enqueue(encoder.encode(event))

            i++
            await Bun.sleep(1000)
          }
        } catch {
          console.log(`[Raw stream] client disconnected after ${i} ticks`)
        }
      },
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  })

  // ── Spike 1 re-verification (updated for RC.7) ────────────────────────────
  .get('/spike1', ({ html }) => html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Spike 1 — RC.7 Re-verification</title>
        <style>{`
          body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
          h1 { font-size: 1.4rem; }
          .counter { font-size: 2rem; font-weight: bold; margin: 20px 0; }
          button { font-size: 1rem; padding: 8px 16px; margin: 4px; cursor: pointer; }
          .section { margin: 20px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
          .section h2 { margin-top: 0; font-size: 1.1rem; color: #555; }
          #server-response { margin-top: 12px; padding: 8px; background: #f0f0f0; border-radius: 4px; min-height: 24px; }
        `}</style>
      </head>
      <body>
        <h1>Spike 1: RC.7 Re-verification</h1>

        <div data-signals="{count: 0, serverMsg: ''}">
          <div class="section">
            <h2>Client-side signal</h2>
            <div class="counter" data-text="$count">0</div>
            <button data-on:click="$count++">+1 (client)</button>
            <button data-on:click="$count--">-1 (client)</button>
            <button data-on:click="$count = 0">Reset</button>
          </div>

          <div class="section">
            <h2>Server roundtrip</h2>
            <button data-on:click="@get('/api/increment')">+1 (server)</button>
            <button data-on:click="@get('/api/random')">Random (server)</button>
            <div id="server-response" data-text="$serverMsg">Waiting...</div>
          </div>
        </div>

        <script type="module" src="/static/datastar.js"></script>
      </body>
    </html>
  ))
  .get('/api/increment', ({ request }) => {
    const url = new URL(request.url)
    const raw = url.searchParams.get('datastar') ?? '{}'
    const signals = JSON.parse(raw)
    const count = (signals.count ?? 0) + 1

    return new Response(
      `event: datastar-patch-signals\ndata: signals ${JSON.stringify({ count, serverMsg: `Server set count to ${count}` })}\n\n`,
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      }
    )
  })
  .get('/api/random', () => {
    const value = Math.floor(Math.random() * 100)

    return new Response(
      `event: datastar-patch-signals\ndata: signals ${JSON.stringify({ count: value, serverMsg: `Server set random value: ${value}` })}\n\n`,
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      }
    )
  })

  // ── Spike 3: HTML Fragment Streaming — datastar-patch-elements ───────────
  .get('/spike3', ({ html }) => html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Spike 3 — HTML Fragment Streaming</title>
        <style>{`
          body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
          h1 { font-size: 1.4rem; }
          .section { margin: 20px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
          .section h2 { margin-top: 0; font-size: 1.1rem; color: #555; }
          .approach { font-size: 0.8rem; color: #888; margin-bottom: 12px; }
          .metric-value { font-size: 1.4rem; font-weight: bold; font-variant-numeric: tabular-nums; }
          .note { font-size: 0.8rem; color: #999; margin-top: 8px; }
          table { font-size: 0.9rem; }
        `}</style>
      </head>
      <body>
        <h1>Spike 3: HTML Fragment Streaming (Datastar RC.7)</h1>

        {/* Test A: SDK patchElements — status panel morphed every 2s */}
        <div class="section" data-init="@get('/api/status/stream-sdk')">
          <h2>Status Panel — SDK patchElements()</h2>
          <p class="approach">Server-rendered JSX fragment, streamed via SDK, morphed by Datastar</p>
          <div id="status-panel">Loading...</div>
          <p class="note">Updates every 2s. Plugin statuses cycle randomly. DOM morphs in place.</p>
        </div>

        {/* Test B: Raw patchElements — simple counter morphed every 1s */}
        <div class="section" data-init="@get('/api/status/stream-raw')">
          <h2>Timestamp — Raw patch-elements</h2>
          <p class="approach">Manual SSE formatting, no SDK</p>
          <div id="raw-timestamp">Loading...</div>
        </div>

        {/* Test C: Mixed stream — signals AND elements in the same SSE connection */}
        <div class="section" data-init="@get('/api/status/stream-mixed')">
          <h2>Mixed Stream — Signals + Elements</h2>
          <p class="approach">Both patch-signals and patch-elements in one SSE stream</p>
          <div>
            <span>Signal value: </span>
            <span class="metric-value" data-text="$mixedCounter">--</span>
          </div>
          <div id="mixed-fragment">Loading fragment...</div>
        </div>

        {/* Test D: Preserve local state — input field should NOT lose focus during morph */}
        <div class="section" data-init="@get('/api/status/stream-preserve')">
          <h2>State Preservation Test</h2>
          <p class="approach">Input field inside a morphing container — typing should not be interrupted</p>
          <div id="preserve-container">
            <p>Server time: loading...</p>
            <input type="text" id="user-input" placeholder="Type here while morphing..." style="width:100%;padding:8px;box-sizing:border-box;" />
          </div>
          <p class="note">If morphing works correctly, your typing should not be interrupted by DOM updates.</p>
        </div>

        <script type="module" src="/static/datastar.js"></script>
      </body>
    </html>
  ))

  // Spike 3A: SDK patchElements — complex JSX fragment
  .get('/api/status/stream-sdk', () => {
    const startTime = Date.now()
    const statuses = ['running', 'error', 'idle', 'running'] as const

    return ServerSentEventGenerator.stream(async (stream) => {
      let i = 0
      try {
        while (true) {
          const uptime = (Date.now() - startTime) / 1000
          const mem = {
            heapUsed: 45_000_000 + Math.sin(i * 0.2) * 10_000_000,
            heapTotal: 80_000_000,
          }
          const plugins = [
            { alias: 'packaging_plc', type: 'modbus', status: statuses[i % 4], lastActivity: Date.now() - (i % 5) * 1000 },
            { alias: 'historian', type: 'opcua', status: statuses[(i + 1) % 4], lastActivity: Date.now() - (i % 3) * 2000 },
            { alias: 'line_mqtt', type: 'mqtt', status: statuses[(i + 2) % 4], lastActivity: Date.now() - (i % 7) * 500 },
            { alias: 'local_store', type: 'output', status: 'running', lastActivity: Date.now() },
          ]

          const fragment = StatusPanel({ uptime, mem, plugins })
          stream.patchElements(fragment)

          i++
          await Bun.sleep(2000)
        }
      } catch {
        console.log(`[Spike3 SDK] client disconnected after ${i} ticks`)
      }
    }, { keepalive: true })
  })

  // Spike 3B: Raw patchElements — simple fragment
  .get('/api/status/stream-raw', () => {
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
      async start(controller) {
        let i = 0
        try {
          while (true) {
            const now = new Date().toISOString()
            const html = `<div id="raw-timestamp"><p><strong>Server time:</strong> ${now}</p><p>Tick: ${i}</p></div>`
            const event = `event: datastar-patch-elements\ndata: elements ${html}\n\n`
            controller.enqueue(encoder.encode(event))

            i++
            await Bun.sleep(1000)
          }
        } catch {
          console.log(`[Spike3 raw] client disconnected after ${i} ticks`)
        }
      },
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  })

  // Spike 3C: Mixed stream — signals + elements in one SSE connection
  .get('/api/status/stream-mixed', () => {
    return ServerSentEventGenerator.stream(async (stream) => {
      let i = 0
      try {
        while (true) {
          // Send a signal update
          stream.patchSignals(JSON.stringify({ mixedCounter: i }))

          // Send a fragment update
          const fragment = `<div id="mixed-fragment"><p>Fragment updated at tick <strong>${i}</strong> — ${new Date().toLocaleTimeString()}</p></div>`
          stream.patchElements(fragment)

          i++
          await Bun.sleep(1500)
        }
      } catch {
        console.log(`[Spike3 mixed] client disconnected after ${i} ticks`)
      }
    }, { keepalive: true })
  })

  // Spike 3D: State preservation — morph should not disturb input focus
  .get('/api/status/stream-preserve', () => {
    return ServerSentEventGenerator.stream(async (stream) => {
      let i = 0
      try {
        while (true) {
          // Only update the <p> inside the container — the <input> should be preserved by morphing
          const fragment = (
            <div id="preserve-container">
              <p>Server time: {new Date().toLocaleTimeString()} (tick {i})</p>
              <input type="text" id="user-input" placeholder="Type here while morphing..." style="width:100%;padding:8px;box-sizing:border-box;" />
            </div>
          ) as string
          stream.patchElements(fragment)

          i++
          await Bun.sleep(1000)
        }
      } catch {
        console.log(`[Spike3 preserve] client disconnected after ${i} ticks`)
      }
    }, { keepalive: true })
  })

  // ── Static files ──────────────────────────────────────────────────────────
  .get('/static/*', ({ params }) => {
    const file = Bun.file(`${import.meta.dir}/../public/${params['*']}`)
    return new Response(file)
  })

  .listen(8080)

console.log(`Spikes running at http://localhost:${app.server!.port}`)
console.log(`  Spike 1: http://localhost:${app.server!.port}/spike1`)
console.log(`  Spike 2: http://localhost:${app.server!.port}/`)
console.log(`  Spike 3: http://localhost:${app.server!.port}/spike3`)
