// Spike 5: Static Asset Embedding in Compiled Binary
//
// Tests whether Bun --compile embeds static assets and serves them correctly.
// Two approaches: (A) import with { type: "file" } and (B) Bun.embeddedFiles

import { Elysia } from 'elysia'
import { html } from '@elysiajs/html'

// ── Approach A: Explicit file imports with { type: "file" } ──────────────────
// These return a path string: in dev it's the real path, in compiled it's $bunfs/...
import datastarPath from '../public/datastar.js' with { type: 'file' }
import echartsPath from '../public/echarts.min.js' with { type: 'file' }
import lineChartPath from '../public/components/line-chart.js' with { type: 'file' }

// ── Check: are we running inside a compiled binary? ──────────────────────────
const isCompiled = import.meta.dir.startsWith('/$bunfs')
console.log(`Mode: ${isCompiled ? 'COMPILED BINARY' : 'DEVELOPMENT'}`)
console.log(`import.meta.dir: ${import.meta.dir}`)
console.log(`Embedded paths:`)
console.log(`  datastar:   ${datastarPath}`)
console.log(`  echarts:    ${echartsPath}`)
console.log(`  line-chart: ${lineChartPath}`)

// ── Approach B: Bun.embeddedFiles enumeration ────────────────────────────────
console.log(`\nBun.embeddedFiles (${Bun.embeddedFiles.length} files):`)
for (const blob of Bun.embeddedFiles) {
  console.log(`  ${blob.name} — ${blob.size} bytes (${blob.type})`)
}

// ── Build asset lookup map ───────────────────────────────────────────────────
const assetMap: Record<string, string> = {
  'datastar.js': datastarPath,
  'echarts.min.js': echartsPath,
  'components/line-chart.js': lineChartPath,
}

// MIME type lookup
function mimeType(path: string): string {
  if (path.endsWith('.js')) return 'application/javascript'
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.html')) return 'text/html'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

const app = new Elysia()
  .use(html())

  .get('/', ({ html }) => html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Spike 5 — Static Asset Embedding</title>
        <style>{`
          body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; }
          h1 { font-size: 1.4rem; }
          .section { margin: 20px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
          .section h2 { margin-top: 0; font-size: 1.1rem; color: #555; }
          .pass { color: #22c55e; font-weight: bold; }
          .fail { color: #ef4444; font-weight: bold; }
          .info { color: #666; font-size: 0.9rem; }
          table { border-collapse: collapse; width: 100%; }
          td, th { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; }
          .counter { font-size: 2rem; font-weight: bold; margin: 12px 0; }
        `}</style>
      </head>
      <body>
        <h1>Spike 5: Static Asset Embedding ({isCompiled ? 'COMPILED' : 'DEV'})</h1>

        <div class="section">
          <h2>Asset Loading Test</h2>
          <table>
            <tr><th>Asset</th><th>Status</th><th>Size</th></tr>
            <tr>
              <td>datastar.js</td>
              <td id="ds-status">Loading...</td>
              <td id="ds-size">—</td>
            </tr>
            <tr>
              <td>echarts.min.js</td>
              <td id="ec-status">Loading...</td>
              <td id="ec-size">—</td>
            </tr>
            <tr>
              <td>components/line-chart.js</td>
              <td id="lc-status">Loading...</td>
              <td id="lc-size">—</td>
            </tr>
          </table>
        </div>

        <div class="section">
          <h2>Datastar Functional Test</h2>
          <div data-signals="{count: 0}">
            <div class="counter" data-text="$count">0</div>
            <button data-on:click="$count++">+1 (client signal)</button>
          </div>
        </div>

        <div class="section">
          <h2>ECharts Functional Test</h2>
          <collatr-line-chart id="test-chart" color="#3b82f6" unit="test" height="200px"></collatr-line-chart>
        </div>

        <div class="section">
          <h2>Environment Info</h2>
          <p class="info">import.meta.dir: {import.meta.dir}</p>
          <p class="info">Compiled: {isCompiled ? 'YES' : 'NO'}</p>
          <p class="info">Bun.embeddedFiles: {Bun.embeddedFiles.length} files</p>
        </div>

        <script src="/static/echarts.min.js"></script>
        <script type="module" src="/static/components/line-chart.js"></script>
        <script type="module" src="/static/datastar.js"></script>
        <script>{`
          // Test asset loading and report status
          async function checkAsset(url, statusId, sizeId) {
            try {
              const resp = await fetch(url);
              const text = await resp.text();
              document.getElementById(statusId).textContent = resp.ok ? 'PASS' : 'FAIL (' + resp.status + ')';
              document.getElementById(statusId).className = resp.ok ? 'pass' : 'fail';
              document.getElementById(sizeId).textContent = (text.length / 1024).toFixed(1) + ' KB';
            } catch (e) {
              document.getElementById(statusId).textContent = 'FAIL: ' + e.message;
              document.getElementById(statusId).className = 'fail';
            }
          }
          checkAsset('/static/datastar.js', 'ds-status', 'ds-size');
          checkAsset('/static/echarts.min.js', 'ec-status', 'ec-size');
          checkAsset('/static/components/line-chart.js', 'lc-status', 'lc-size');

          // Push a test data point to the chart after it loads
          setTimeout(() => {
            const chart = document.getElementById('test-chart');
            if (chart && chart.addPoint) {
              for (let i = 0; i < 20; i++) {
                chart.addPoint(Date.now() - (20 - i) * 1000, 10 + Math.sin(i * 0.5) * 5);
              }
            }
          }, 500);
        `}</script>
      </body>
    </html>
  ))

  // ── Static file serving from embedded assets ───────────────────────────────
  .get('/static/*', ({ params }) => {
    const requestedPath = params['*']
    const embeddedPath = assetMap[requestedPath]

    if (!embeddedPath) {
      return new Response('Not Found', { status: 404 })
    }

    const file = Bun.file(embeddedPath)
    return new Response(file, {
      headers: {
        'Content-Type': mimeType(requestedPath),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  })

  .listen(8081)

console.log(`\nSpike 5 running at http://localhost:${app.server!.port}`)
