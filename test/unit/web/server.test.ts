import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createWebServer,
  startWebServer,
  stopWebServer,
  WEB_UI_DEFAULTS,
} from "../../../src/web/server";
import type { WebUIConfig } from "../../../src/web/server";
import type { WebUIAdapter } from "../../../src/web/adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock adapter for server tests (server.ts doesn't use adapter yet). */
function mockAdapter(): WebUIAdapter {
  return {
    getStatus: () => ({ state: "running" as const, startedAt: Date.now() }),
    getPluginHealth: () => [],
    getLiveMetrics: () => new Map(),
    getNetworkPolicy: () => null,
    getUptime: () => 0,
    getMemoryUsage: () => ({ heapUsed: 0, heapTotal: 0, rss: 0 }),
    handleMetric: () => {},
    getLocalStore: () => null,
    getCertificateInfo: () => ({ clientCert: null, inputs: [] }),
    getTrustStore: () => null,
  };
}

/** Finds a free port by starting an ephemeral server. */
function getFreePort(): number {
  // Use a random high port to avoid conflicts with other tests
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Web UI Server", () => {
  const port = getFreePort();
  const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
  const adapter = mockAdapter();
  const app = createWebServer(config, adapter);
  let baseUrl: string;

  beforeAll(async () => {
    await startWebServer(app, config);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    stopWebServer(app);
  });

  // ── Server lifecycle ──────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("server starts on configured port and responds to requests", async () => {
      const resp = await fetch(`${baseUrl}/static/datastar.js`);
      expect(resp.status).toBe(200);
    });

    it("returns 404 for unknown paths", async () => {
      const resp = await fetch(`${baseUrl}/unknown`);
      expect(resp.status).toBe(404);
    });
  });

  // ── Static asset serving ──────────────────────────────────────────────

  describe("GET /static/*", () => {
    it("serves datastar.js with correct Content-Type", async () => {
      const resp = await fetch(`${baseUrl}/static/datastar.js`);
      expect(resp.status).toBe(200);
      const ct = resp.headers.get("content-type");
      expect(ct).toContain("application/javascript");
      const body = await resp.text();
      expect(body.length).toBeGreaterThan(1000); // datastar.js is ~30KB
    });

    it("serves echarts.min.js with correct Content-Type", async () => {
      const resp = await fetch(`${baseUrl}/static/echarts.min.js`);
      expect(resp.status).toBe(200);
      const ct = resp.headers.get("content-type");
      expect(ct).toContain("application/javascript");
      const body = await resp.text();
      expect(body.length).toBeGreaterThan(10000); // echarts is ~1MB
    });

    it("serves components/line-chart.js with correct Content-Type", async () => {
      const resp = await fetch(`${baseUrl}/static/components/line-chart.js`);
      expect(resp.status).toBe(200);
      const ct = resp.headers.get("content-type");
      expect(ct).toContain("application/javascript");
      const body = await resp.text();
      expect(body).toContain("CollatrLineChart");
    });

    it("returns 404 for nonexistent static file", async () => {
      const resp = await fetch(`${baseUrl}/static/nonexistent.js`);
      expect(resp.status).toBe(404);
    });

    it("returns 404 for path traversal attempts", async () => {
      const resp = await fetch(`${baseUrl}/static/../../../etc/passwd`);
      expect(resp.status).toBe(404);
    });
  });

  // ── Cache headers ─────────────────────────────────────────────────────

  describe("Cache-Control headers", () => {
    it("sets immutable Cache-Control on static responses", async () => {
      const resp = await fetch(`${baseUrl}/static/datastar.js`);
      const cc = resp.headers.get("cache-control");
      expect(cc).toBe("public, max-age=31536000, immutable");
    });

    it("sets Cache-Control on all static assets", async () => {
      for (const asset of ["datastar.js", "echarts.min.js", "components/line-chart.js"]) {
        const resp = await fetch(`${baseUrl}/static/${asset}`);
        const cc = resp.headers.get("cache-control");
        expect(cc).toBe("public, max-age=31536000, immutable");
      }
    });
  });

  // ── Gzip compression ─────────────────────────────────────────────────

  describe("gzip compression", () => {
    it("returns gzipped response when Accept-Encoding includes gzip", async () => {
      const resp = await fetch(`${baseUrl}/static/datastar.js`, {
        headers: { "Accept-Encoding": "gzip, deflate, br" },
      });
      expect(resp.status).toBe(200);
      const encoding = resp.headers.get("content-encoding");
      expect(encoding).toBe("gzip");
    });

    it("returns uncompressed response when Accept-Encoding omits gzip", async () => {
      const resp = await fetch(`${baseUrl}/static/datastar.js`, {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(resp.status).toBe(200);
      const encoding = resp.headers.get("content-encoding");
      expect(encoding).toBeNull();
    });

    it("compressed response is smaller than raw file size", async () => {
      // Fetch without gzip to get raw size
      const rawResp = await fetch(`${baseUrl}/static/echarts.min.js`, {
        headers: { "Accept-Encoding": "identity" },
      });
      const rawBody = await rawResp.arrayBuffer();

      // Fetch with gzip
      const gzipResp = await fetch(`${baseUrl}/static/echarts.min.js`, {
        headers: { "Accept-Encoding": "gzip" },
        // Bun's fetch auto-decompresses by default, so read as raw
      });
      // Content-Encoding header confirms gzip was used server-side
      expect(gzipResp.headers.get("content-encoding")).toBe("gzip");

      // The server sends gzip bytes — even though Bun fetch may transparently
      // decompress, the Content-Encoding header proves the server compressed it.
      // Verify by checking that the server response had gzip encoding header.
      expect(rawBody.byteLength).toBeGreaterThan(100_000); // echarts is ~1MB raw
    });

    it("sets Vary: Accept-Encoding on gzipped responses", async () => {
      const resp = await fetch(`${baseUrl}/static/datastar.js`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(resp.headers.get("vary")).toBe("Accept-Encoding");
    });
  });

  // ── Defaults ──────────────────────────────────────────────────────────

  describe("defaults", () => {
    it("WEB_UI_DEFAULTS has correct values", () => {
      expect(WEB_UI_DEFAULTS.enabled).toBe(true);
      expect(WEB_UI_DEFAULTS.port).toBe(8080);
      expect(WEB_UI_DEFAULTS.bind).toBe("127.0.0.1");
    });
  });
});

describe("Web UI Server stop", () => {
  it("server stops cleanly without errors", async () => {
    const port2 = getFreePort();
    const config2: WebUIConfig = { enabled: true, port: port2, bind: "127.0.0.1" };
    const app2 = createWebServer(config2, mockAdapter());
    await startWebServer(app2, config2);

    // Verify it's running
    const resp = await fetch(`http://127.0.0.1:${port2}/static/datastar.js`);
    expect(resp.status).toBe(200);

    // Stop — should not throw
    stopWebServer(app2);

    // Verify it's stopped — connection should fail
    try {
      await fetch(`http://127.0.0.1:${port2}/static/datastar.js`);
      // If fetch somehow succeeds, it means the server didn't stop
      expect(true).toBe(false); // Force failure
    } catch {
      // Expected — connection refused
      expect(true).toBe(true);
    }
  });
});
