# Spike: Web UI Stack — Elysia + Datastar + ECharts on Bun

**Purpose:** Prove the Bun + Elysia + `@elysia/html` + Datastar + ECharts stack works for CollatrEdge's local Web UI before committing to implementation.

**Estimated Duration:** Half a day (4-6 hours)

**Decision:** GO / NO-GO on this stack for Phase 9.

**Location:** `spike-web-ui/` in the collatr-edge repo root (gitignored after spike, or kept as reference).

---

## Context

CollatrEdge Phase 9 is the final MVP phase: a local Web UI served by the same Bun process as the pipeline. The UI shows pipeline status, live metric values via SSE, trend charts from the local store, and CSV export.

### Stack Decision

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Bun | Already committed — compiled binary, native SQLite, TS-first |
| HTTP Framework | Elysia | Bun-native performance, built-in validation (TypeBox), plugin scoping, generator SSE |
| JSX Rendering | `@elysia/html` (Kita) | Server-side JSX without React. Produces HTML strings with `data-*` attributes for Datastar |
| Reactivity | Datastar | Hypermedia/HATEOAS, SSE-first, server-owns-state, ~11KB client, no build step |
| Charts | ECharts | Full-featured, same library for Edge + Hub, web component support, ~800KB (compressed ~200KB with Brotli) |
| Server SDK | `@starfederation/datastar-sdk` | Official TypeScript SDK for formatting Datastar SSE events (patchElements, patchSignals) |

### Key Constraints

- **HTTP/1.1 only.** `Bun.serve()` does not have native HTTP/2 server support. The edge agent serves on a LAN — browsers connect over `http://192.168.x.x:8080`. No reverse proxy, no TLS for MVP. HTTP/1.1 chunked transfer encoding works perfectly for SSE in this context.
- **Self-contained binary.** All static assets (Datastar JS, ECharts, CSS) must be embedded in the compiled binary via `bun build --compile`. No CDN, no network fetch for client-side libraries.
- **Minimal dependencies.** Every npm package is a supply chain risk. The web UI should add the fewest possible dependencies to CollatrEdge.

---

## Spikes

### Spike 1: Elysia + `@elysia/html` JSX with Datastar Attributes

**Goal:** Verify Elysia renders JSX to HTML strings containing `data-*` attributes that Datastar consumes correctly.

**Steps:**

1. Create `spike-web-ui/` directory with its own `package.json` and `tsconfig.json`
2. `bun add elysia @elysia/html`
3. Configure `tsconfig.json` for Kita JSX:
   ```json
   {
     "compilerOptions": {
       "jsx": "react-jsx",
       "jsxImportSource": "@kitajs/html"
     }
   }
   ```
4. Create a minimal Elysia server that renders a page with Datastar attributes:
   ```tsx
   import { Elysia } from 'elysia'
   import { html } from '@elysia/html'

   const app = new Elysia()
     .use(html())
     .get('/', ({ html }) => html(
       <html>
         <body>
           <div data-signals-count="0">
             <span data-text="$count">0</span>
             <button data-on-click="$count++">+1 (client)</button>
             <button data-on-click="@get('/api/increment')">+1 (server)</button>
           </div>
           <script src="/static/datastar.js"></script>
         </body>
       </html>
     ))
   ```
5. Serve Datastar client JS from a local file (downloaded from npm/CDN into `spike-web-ui/static/`)
6. Verify in browser: Datastar initialises, client-side `$count++` works, server roundtrip works

**Pass/Fail Criteria:**
- ✅ JSX renders to valid HTML with `data-*` attributes intact
- ✅ Datastar hydrates the page and signals work
- ✅ No TypeScript errors with Kita JSX configuration
- ✅ `@get('/api/increment')` triggers Elysia route and Datastar processes the response
- ❌ FAIL if `@elysia/html` strips or mangles `data-*` attributes
- ❌ FAIL if Kita JSX doesn't support arbitrary `data-*` attribute names

**Watch for:**
- JSX attribute name restrictions (React bans some; Kita may be more permissive)
- Datastar uses `data-on:click` (colon syntax) — check if Kita JSX handles this or needs `data-on-click` (hyphen syntax). Datastar supports both.

---

### Spike 2: SSE Streaming — Elysia Generator → Datastar SDK → Browser

**Goal:** Verify Elysia's generator-based SSE streaming delivers events that Datastar's client-side library consumes correctly.

**Steps:**

1. `bun add @starfederation/datastar-sdk`
2. Create an SSE endpoint using Elysia's generator pattern:
   ```typescript
   import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web'

   app.get('/api/metrics/stream', function* () {
     let i = 0
     while (true) {
       // Simulate metric data
       const temp = 20 + Math.sin(i * 0.1) * 5
       const pressure = 1013 + Math.cos(i * 0.1) * 10

       // Format as Datastar SSE event
       yield `event: datastar-patch-signals\ndata: signals {temperature: ${temp.toFixed(1)}, pressure: ${pressure.toFixed(1)}}\n\n`

       i++
       // Wait 1 second between updates
       yield* sleep(1000)
     }
   })
   ```
3. If Elysia's generator SSE doesn't have a built-in sleep/delay, test alternatives:
   - Use Bun's `Bun.sleep()` with async generators
   - Use the Datastar SDK's `stream()` helper instead of raw generators
   - Fall back to `ReadableStream` if generators don't work
4. Create a page with Datastar signal bindings:
   ```html
   <div data-on-load="@get('/api/metrics/stream')">
     <span>Temperature: </span><span data-text="$temperature + '°C'">--</span>
     <span>Pressure: </span><span data-text="$pressure + ' hPa'">--</span>
   </div>
   ```
5. Verify in browser: values update live every second

**Also test the SDK's built-in stream helper as alternative:**
   ```typescript
   app.get('/api/metrics/stream', (ctx) => {
     return ServerSentEventGenerator.stream(ctx.request, ctx.set, (stream) => {
       stream.patchSignals(JSON.stringify({ temperature: 21.5, pressure: 1013.2 }))
     })
   })
   ```
   Note: The Datastar SDK `stream()` expects Node-style `req, res` or Web-standard `Request`. Test which import path (`/node` vs `/web`) works with Elysia/Bun.

**Pass/Fail Criteria:**
- ✅ SSE events stream continuously to the browser without buffering
- ✅ Datastar client parses `datastar-patch-signals` events and updates bound elements
- ✅ No `Transfer-Encoding: chunked` header issues on HTTP/1.1
- ✅ Connection stays open (no premature close)
- ✅ Browser reconnects automatically if connection drops (EventSource default behaviour)
- ❌ FAIL if Elysia buffers SSE events (no immediate flush)
- ❌ FAIL if Datastar SDK events are in wrong format for Datastar client

**Watch for:**
- Response headers: must include `Content-Type: text/event-stream`, `Cache-Control: no-cache`
- Elysia may set `Connection: keep-alive` — fine for HTTP/1.1
- Event format must match exactly: `event: datastar-patch-signals\ndata: signals {key: value}\n\n` (note: `data: signals ` prefix, not `data: `)
- Test with browser DevTools Network tab — SSE should show as "EventStream" type, events appearing in real-time

---

### Spike 3: HTML Fragment Streaming — `datastar-patch-elements`

**Goal:** Verify server-rendered JSX fragments can be streamed via SSE to morph DOM elements.

**Steps:**

1. Create an SSE endpoint that streams HTML fragments:
   ```typescript
   app.get('/api/status/stream', function* () {
     while (true) {
       const uptime = process.uptime()
       const mem = process.memoryUsage()

       // Render JSX to string, send as patch-elements
       const html = renderToString(
         <div id="status-panel">
           <p>Uptime: {formatDuration(uptime)}</p>
           <p>Memory: {(mem.heapUsed / 1024 / 1024).toFixed(1)} MB</p>
         </div>
       )

       yield `event: datastar-patch-elements\ndata: elements ${html}\n\n`
       yield* sleep(2000)
     }
   })
   ```
2. Render target on the page:
   ```html
   <div data-on-load="@get('/api/status/stream')">
     <div id="status-panel">Loading...</div>
   </div>
   ```
3. Verify: DOM morphs in place without flicker, preserving any local state on elements not being updated

**Pass/Fail Criteria:**
- ✅ JSX rendered to string on server, delivered as SSE event, morphed into DOM by Datastar
- ✅ Multi-line HTML fragments work (Datastar spec supports multiple `data: elements` lines)
- ✅ IDs on elements are matched correctly for morphing
- ❌ FAIL if JSX `renderToString` output contains characters that break SSE framing
- ❌ FAIL if Datastar fails to morph complex fragments

**Watch for:**
- Newlines in HTML must be handled correctly. Each line of multi-line elements needs `data: elements ` prefix. The Datastar SDK should handle this, but verify.
- JSX `renderToString` — with Kita, this might just be the tagged template literal output. Verify what `@elysia/html` gives you.

---

### Spike 4: ECharts Web Component with Live Data

**Goal:** Verify ECharts renders time-series data in a web component, updated via Datastar SSE signals.

**Steps:**

1. Download ECharts from npm: `bun add echarts`
2. Create a simple web component wrapper:
   ```typescript
   // static/components/line-chart.js
   class CollatrLineChart extends HTMLElement {
     constructor() { super(); this.chart = null; }

     connectedCallback() {
       this.chart = echarts.init(this)
       this.style.display = 'block'
       this.style.width = '100%'
       this.style.height = '400px'

       this.chart.setOption({
         xAxis: { type: 'time' },
         yAxis: { type: 'value' },
         series: [{ type: 'line', data: [] }],
         animation: false,
       })

       // Observe resize
       new ResizeObserver(() => this.chart?.resize()).observe(this)
     }

     // Called from Datastar signal update
     updateData(newPoint) {
       const option = this.chart.getOption()
       const data = option.series[0].data
       data.push([newPoint.timestamp, newPoint.value])
       // Keep last 1000 points
       if (data.length > 1000) data.shift()
       this.chart.setOption({ series: [{ data }] })
     }

     disconnectedCallback() {
       this.chart?.dispose()
     }
   }
   customElements.define('collatr-line-chart', CollatrLineChart)
   ```
3. Bridge Datastar signals to the web component:
   ```html
   <div data-on-load="@get('/api/metrics/stream')">
     <collatr-line-chart id="temp-chart"></collatr-line-chart>
     <script>
       // Use Datastar's signal system to push data to chart
       // This is the key integration question — how do we bridge
       // Datastar signal updates to web component method calls?
     </script>
   </div>
   ```
4. Test the Datastar → web component bridge. Options:
   - **Option A:** Use `data-on-signals-change` to detect signal updates and call chart methods
   - **Option B:** Use `datastar-patch-elements` to re-render a `<collatr-line-chart data-attr-points="...">` attribute
   - **Option C:** Use `data-attr-*` to set an attribute that the web component observes via `attributeChangedCallback`
5. Determine which option works best and has cleanest DX

**Pass/Fail Criteria:**
- ✅ ECharts renders a line chart in a web component
- ✅ Live data from SSE updates the chart in real-time
- ✅ Chart is responsive (resizes with container)
- ✅ A clear bridge pattern exists between Datastar signals and web component updates
- ❌ FAIL if no clean way to bridge Datastar signals to web component methods
- ❌ FAIL if ECharts doesn't work inside a custom element

**Watch for:**
- ECharts needs a container with explicit dimensions. Web component must set `display: block` and dimensions.
- The Datastar → web component bridge is the riskiest part of this spike. If signals can't drive web component updates cleanly, we may need a different charting approach (e.g., Datastar re-renders an `<img>` tag pointing at a server-rendered chart PNG, or we use `data-on-signals-change` with vanilla JS).
- Test with 1000+ data points to verify ECharts performance is acceptable.

---

### Spike 5: Static Asset Embedding in Compiled Binary

**Goal:** Verify all client-side assets (Datastar JS, ECharts, CSS, web components) can be embedded in a `bun build --compile` binary and served without external network access.

**Steps:**

1. Create a `public/` directory with all static assets:
   ```
   spike-web-ui/
   ├── public/
   │   ├── datastar.js        (~11KB — from @starfederation/datastar npm)
   │   ├── echarts.min.js     (~800KB — from echarts npm, ESM build)
   │   ├── components/
   │   │   └── line-chart.js   (our web component)
   │   └── styles.css          (basic dashboard styles)
   └── src/
       └── server.ts
   ```
2. In Elysia, serve static files using `@elysiajs/static` or manual route:
   ```typescript
   // Option A: @elysiajs/static plugin
   import { staticPlugin } from '@elysiajs/static'
   app.use(staticPlugin({ assets: 'public', prefix: '/static' }))

   // Option B: Manual with Bun.file() — no extra dependency
   app.get('/static/*', ({ params }) => {
     return new Response(Bun.file(`./public/${params['*']}`))
   })
   ```
3. Test pre-compression:
   ```bash
   # Pre-compress assets with Brotli
   bun -e "
     const echarts = Bun.file('public/echarts.min.js');
     const compressed = Bun.gzipSync(await echarts.arrayBuffer());
     // Note: Bun has gzipSync but check for Brotli support
     console.log('Original:', echarts.size, 'Compressed:', compressed.byteLength);
   "
   ```
   If Bun doesn't have native Brotli, test with gzip. Alternatively, pre-compress at build time with a script.
4. Serve pre-compressed assets with `Content-Encoding: br` (or `gzip`) header:
   ```typescript
   app.get('/static/echarts.min.js', () => {
     return new Response(Bun.file('public/echarts.min.js.br'), {
       headers: {
         'Content-Type': 'application/javascript',
         'Content-Encoding': 'br',
         'Cache-Control': 'public, max-age=31536000, immutable',
       }
     })
   })
   ```
5. Compile to binary:
   ```bash
   bun build --compile --minify src/server.ts --outfile spike-web-ui
   ```
6. Verify the compiled binary serves all assets without the source `public/` directory present
7. Check binary size — baseline (no web UI) is ~100MB. How much does ECharts + Datastar add?

**Pass/Fail Criteria:**
- ✅ Compiled binary serves all static assets from embedded files
- ✅ Assets load correctly in browser (no 404s, no CORS issues)
- ✅ Pre-compression works (gzip at minimum, Brotli if available)
- ✅ Binary size increase is acceptable (< 5MB additional for all assets)
- ✅ `Cache-Control: immutable` works — browser caches aggressively
- ❌ FAIL if `bun build --compile` can't embed static files
- ❌ FAIL if Bun.file() paths break after compilation (need to use import or embed)

**Watch for:**
- `bun build --compile` may not automatically embed files referenced by `Bun.file()` at runtime. You may need to `import` them as strings/buffers at build time, or use Bun's `embed` feature.
- Test both approaches: runtime `Bun.file()` and build-time `import`.
- The `@elysiajs/static` plugin may not work with compiled binaries if it reads from the filesystem at runtime.

---

### Spike 6: Integration — Full Stack Serving a Dashboard Page

**Goal:** Combine all spikes into a single working dashboard page that demonstrates the complete stack.

**Steps:**

1. Create a single-page dashboard with:
   - Network policy banner (static HTML, server-rendered)
   - Pipeline status section (patched via `datastar-patch-elements` every 2s)
   - Live values section (updated via `datastar-patch-signals` every 1s)
   - Trend chart (ECharts web component, data from signals)
   - CSV export button (plain form POST to `/api/export`)

2. Create mock data sources:
   ```typescript
   // Simulates what PipelineRuntime would expose via WebUIAdapter
   const mockPipeline = {
     status: 'running',
     inputs: [
       { alias: 'packaging_plc', type: 'modbus', status: 'collecting', lastGather: Date.now() },
       { alias: 'historian', type: 'opcua', status: 'collecting', lastGather: Date.now() },
     ],
     outputs: [
       { alias: 'local', type: 'local_store', status: 'writing', lastWrite: Date.now() },
     ],
     networkPolicy: { mode: 'local_network', summary: 'LOCAL NETWORK — egress: 2 allowed hosts' },
   }
   ```

3. SSE endpoint serves both signal updates (for live values) and element patches (for status):
   ```typescript
   app.get('/api/dashboard/stream', function* () {
     while (true) {
       // Signal update — live metric values
       yield formatPatchSignals({
         temperature: mockMetric(),
         pressure: mockMetric(),
         line_speed: mockMetric(),
       })

       // Element patch — status panel with fresh uptime, plugin health
       yield formatPatchElements(
         renderToString(<StatusPanel pipeline={mockPipeline} />)
       )

       yield* sleep(1000)
     }
   })
   ```

4. CSV export endpoint:
   ```typescript
   app.get('/api/export', ({ query }) => {
     const from = query.from || new Date(Date.now() - 86400000).toISOString()
     const to = query.to || new Date().toISOString()
     // Mock CSV data
     const csv = generateMockCSV(from, to)
     return new Response(csv, {
       headers: {
         'Content-Type': 'text/csv',
         'Content-Disposition': `attachment; filename="collatr-edge-export-${Date.now()}.csv"`,
       }
     })
   })
   ```

5. Test the full flow:
   - Open browser → page loads (server-rendered HTML with Datastar attributes)
   - Datastar initialises → SSE connection opens → live values start updating
   - ECharts renders and receives data points via signals
   - Click "Export CSV" → file downloads
   - Disconnect network → SSE reconnects automatically when restored

6. Compile to binary and test again:
   ```bash
   bun build --compile --minify src/server.ts --outfile collatr-edge-spike
   ./collatr-edge-spike
   ```

**Pass/Fail Criteria:**
- ✅ Complete dashboard renders and functions end-to-end
- ✅ SSE streaming works continuously without memory leaks (run for 5+ minutes, check heap)
- ✅ ECharts updates smoothly with incoming data
- ✅ CSV download works
- ✅ Compiled binary serves everything correctly
- ✅ Page is usable by a non-technical person (clear labels, traffic-light colours)
- ❌ FAIL if any component of the stack doesn't integrate cleanly

---

## Dependencies to Add (Spike Only)

| Package | Purpose | Size |
|---------|---------|------|
| `elysia` | HTTP framework | ~50KB |
| `@elysia/html` | JSX rendering (Kita) | ~10KB |
| `@starfederation/datastar-sdk` | Server-side SSE event formatting | ~5KB |
| `echarts` | Charting library (client-side, served as static) | ~800KB |

**Client-side (embedded in binary):**
| Asset | Purpose | Size (raw) | Size (Brotli est.) |
|-------|---------|-----------|-------------------|
| `@starfederation/datastar` | Client-side reactivity | ~11KB | ~4KB |
| `echarts.min.js` | Charts | ~800KB | ~200KB |
| `styles.css` | Dashboard styles | ~5KB | ~1KB |
| Web components JS | Chart wrapper etc. | ~5KB | ~1KB |

**Total client-side payload:** ~820KB raw, ~206KB compressed. One-time load, aggressively cached.

---

## Go/No-Go Criteria

### GO if:
- All 6 spikes pass
- Elysia + Kita JSX handles `data-*` attributes without issues
- SSE streaming works reliably over HTTP/1.1
- Datastar signals and element patching both work
- ECharts integrates cleanly with Datastar (bridge pattern identified)
- Compiled binary serves everything self-contained
- No showstopper dependency issues

### NO-GO if:
- `@elysia/html` / Kita doesn't support arbitrary `data-*` attributes
- SSE buffering in Elysia prevents real-time streaming
- No clean bridge between Datastar signals and ECharts web component
- Binary compilation breaks static asset serving
- Unacceptable dependency count or size

### Fallback if NO-GO:
- **Elysia JSX fails:** Try Hono (built-in JSX) + Datastar — the original researched stack
- **Datastar SSE fails:** Raw `EventSource` + vanilla JS (no framework)
- **ECharts too heavy:** uPlot (~35KB) as lightweight alternative
- **Binary embedding fails:** Serve from filesystem alongside binary (less ideal but functional)

---

## Notes

- This spike is separate from the main codebase. The `spike-web-ui/` directory has its own `package.json`.
- Do NOT add web UI dependencies to the main `package.json` until the spike passes.
- The spike does NOT need to connect to a real pipeline. Mock data throughout.
- After spike passes, the findings inform the PRD §17 rewrite and Phase 9 task plan.
- Key question from spike: what's the best Datastar → web component bridge pattern? This will shape Phase 9 architecture.
