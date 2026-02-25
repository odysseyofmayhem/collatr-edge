import { Elysia } from 'elysia'
import { html } from '@elysiajs/html'
import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web'

// ---------------------------------------------------------------------------
// Spike 2: SSE Streaming — Elysia → Datastar → Browser
//
// Client: Datastar RC.7 (downloaded bundle, not npm)
// Server: @starfederation/datastar-sdk RC.3 (npm)
//
// Tests two approaches:
//   A) SDK ServerSentEventGenerator.stream() — returns Response directly
//   B) Raw ReadableStream with manual SSE formatting — no SDK dependency
// ---------------------------------------------------------------------------

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

  // ── Static files ──────────────────────────────────────────────────────────
  .get('/static/*', ({ params }) => {
    const file = Bun.file(`${import.meta.dir}/../public/${params['*']}`)
    return new Response(file)
  })

  .listen(8080)

console.log(`Spikes running at http://localhost:${app.server!.port}`)
console.log(`  Spike 1: http://localhost:${app.server!.port}/spike1`)
console.log(`  Spike 2: http://localhost:${app.server!.port}/`)
