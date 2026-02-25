// CollatrEdge — Web UI HTTP Server
// PRD refs: §17 Local Web UI (Technology), §16 Security (port 8080, bind localhost)
// Phase 9 Task 9.1: Elysia HTTP server with static asset embedding and gzip compression

import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import type { WebUIAdapter } from "./adapter.ts";

// ---------------------------------------------------------------------------
// Static asset embedding (spike 5: import with { type: 'file' })
// In dev: returns real filesystem path. In compiled binary: returns $bunfs/ path.
// Both work transparently with Bun.file().
// ---------------------------------------------------------------------------

// @ts-expect-error — Bun file imports return string paths; TypeScript doesn't have types for this
import datastarPath from "./public/datastar.js" with { type: "file" };
import echartsPath from "./public/echarts.min.js" with { type: "file" };
import lineChartPath from "./public/components/line-chart.js" with { type: "file" };

const ASSET_MAP: Record<string, string> = {
  "datastar.js": datastarPath as string,
  "echarts.min.js": echartsPath as string,
  "components/line-chart.js": lineChartPath as string,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebUIConfig {
  enabled: boolean;
  port: number;
  bind: string;
}

export const WEB_UI_DEFAULTS: WebUIConfig = {
  enabled: true,
  port: 8080,
  bind: "127.0.0.1",
};

/** The Elysia app type after plugin registration. Used by lifecycle functions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebApp = Elysia<any>;

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

function mimeType(path: string): string {
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Gzip compression cache
// Spike finding: Bun.gzipSync() is fast (17ms for 1MB ECharts).
// Strategy: gzip on first request, cache in memory. Assets have
// Cache-Control: immutable so browser caches forever.
// ---------------------------------------------------------------------------

const gzipCache = new Map<string, Uint8Array>();

async function getGzipped(assetKey: string, filePath: string): Promise<Uint8Array> {
  const cached = gzipCache.get(assetKey);
  if (cached) return cached;

  const file = Bun.file(filePath);
  const raw = new Uint8Array(await file.arrayBuffer());
  const compressed = Bun.gzipSync(raw);
  gzipCache.set(assetKey, compressed);
  return compressed;
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export function createWebServer(
  config: WebUIConfig,
  _adapter: WebUIAdapter,
): WebApp {
  const app = new Elysia()
    .use(html())

    // ── Static asset serving ────────────────────────────────────────────
    .get("/static/*", async ({ params, request }) => {
      const requestedPath = params["*"];
      const embeddedPath = ASSET_MAP[requestedPath];

      if (!embeddedPath) {
        return new Response("Not Found", { status: 404 });
      }

      const contentType = mimeType(requestedPath);
      const acceptEncoding = request.headers.get("accept-encoding") ?? "";
      const supportsGzip = acceptEncoding.includes("gzip");

      if (supportsGzip) {
        const compressed = await getGzipped(requestedPath, embeddedPath);
        return new Response(compressed, {
          headers: {
            "Content-Type": contentType,
            "Content-Encoding": "gzip",
            "Cache-Control": "public, max-age=31536000, immutable",
            "Vary": "Accept-Encoding",
          },
        });
      }

      return new Response(Bun.file(embeddedPath), {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    });

  return app as unknown as WebApp;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startWebServer(
  app: WebApp,
  config: WebUIConfig,
): Promise<void> {
  app.listen({ port: config.port, hostname: config.bind });
}

export function stopWebServer(app: WebApp): void {
  app.stop();
  gzipCache.clear();
}
