import { Elysia } from 'elysia'
import { html } from '@elysiajs/html'

const app = new Elysia()
  .use(html())
  .get('/', ({ html }) => html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Spike 1 — Elysia + Kita JSX + Datastar</title>
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
        <h1>Spike 1: Elysia + Kita JSX + Datastar</h1>

        <div data-signals-count="0" data-signals-server-msg="''">
          <div class="section">
            <h2>Client-side signal</h2>
            <div class="counter" data-text="$count">0</div>
            <button data-on-click="$count++">+1 (client)</button>
            <button data-on-click="$count--">-1 (client)</button>
            <button data-on-click="$count = 0">Reset</button>
          </div>

          <div class="section">
            <h2>Server roundtrip</h2>
            <button data-on-click="@get('/api/increment')">+1 (server)</button>
            <button data-on-click="@get('/api/random')">Random (server)</button>
            <div id="server-response" data-text="$serverMsg">Waiting...</div>
          </div>
        </div>

        <script src="/static/datastar.js"></script>
      </body>
    </html>
  ))
  .get('/api/increment', ({ request }) => {
    // Datastar sends signals as JSON in ?datastar= query param
    const url = new URL(request.url)
    const raw = url.searchParams.get('datastar') ?? '{}'
    const signals = JSON.parse(raw)
    const count = (signals.count ?? 0) + 1

    return new Response(
      `event: datastar-merge-signals\ndata: signals {count: ${count}, serverMsg: 'Server set count to ${count}'}\n\n`,
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
      `event: datastar-merge-signals\ndata: signals {count: ${value}, serverMsg: 'Server set random value: ${value}'}\n\n`,
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      }
    )
  })
  .get('/static/*', ({ params }) => {
    const file = Bun.file(`${import.meta.dir}/../public/${params['*']}`)
    return new Response(file)
  })
  .listen(8080)

console.log(`Spike 1 running at http://localhost:${app.server!.port}`)
