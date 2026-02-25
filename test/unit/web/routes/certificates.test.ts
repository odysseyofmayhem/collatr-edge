// Unit tests: OPC-UA certificate helper page — routes and page rendering
// Phase 9 Task 9.6: OPC-UA certificate helper page
// PRD refs: Appendix D §D.3-D.4, §17 Local Web UI
// Phase 9 review fixes: MF-1 (SQLite trust store), MF-2 (auth on trust endpoint)

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  handleCertificateClient,
  handleCertificateDownload,
  handleCertificateStatus,
  handleCertificateTrust,
  handleCertificatesPage,
} from "../../../../src/web/routes/certificates";
import {
  createWebServer,
  startWebServer,
  stopWebServer,
} from "../../../../src/web/server";
import type { WebUIConfig } from "../../../../src/web/server";
import type {
  WebUIAdapter,
  PluginHealth,
  LiveMetricValue,
  CertificateInfo,
} from "../../../../src/web/adapter";
import type { PipelineState } from "../../../../src/pipeline/runtime";
import { TrustStore } from "../../../../src/web/trust-store";

// ---------------------------------------------------------------------------
// Test certificate generation
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-cert-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Generate a self-signed test certificate using openssl. */
function generateTestCert(
  dir: string,
  cn = "collatr-edge-test",
): { certPath: string; keyPath: string } {
  const certPath = join(dir, "test-cert.pem");
  const keyPath = join(dir, "test-key.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=${cn}" 2>/dev/null`,
  );
  return { certPath, keyPath };
}

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function mockAdapter(overrides?: {
  state?: PipelineState;
  plugins?: PluginHealth[];
  metrics?: Map<string, LiveMetricValue>;
  certInfo?: CertificateInfo;
  trustStore?: TrustStore | null;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const certInfo = overrides?.certInfo ?? { clientCert: null, inputs: [] };
  const trustStore = overrides?.trustStore ?? null;

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => overrides?.plugins ?? [],
    getLiveMetrics: () =>
      overrides?.metrics ?? new Map<string, LiveMetricValue>(),
    getNetworkPolicy: () => null,
    getUptime: () => 60000,
    getMemoryUsage: () => ({
      heapUsed: 45_000_000,
      heapTotal: 80_000_000,
      rss: 120_000_000,
    }),
    handleMetric: () => {},
    getLocalStore: () => null,
    getCertificateInfo: () => certInfo,
    getTrustStore: () => trustStore,
  };
}

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// GET /api/certificates/client
// ---------------------------------------------------------------------------

describe("handleCertificateClient", () => {
  it("returns configured=false message when no cert configured", async () => {
    const adapter = mockAdapter();
    const resp = handleCertificateClient(adapter);
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.message).toContain("No OPC-UA");
  });

  it("returns cert info when client cert exists", async () => {
    const { certPath } = generateTestCert(tempDir);
    const adapter = mockAdapter({
      certInfo: {
        clientCert: {
          path: certPath,
          exists: true,
          thumbprint: "AB:CD:EF:12:34",
          subject: "CN=collatr-edge-test",
          validFrom: "2024-01-01",
          validTo: "2025-01-01",
        },
        inputs: [],
      },
    });

    const resp = handleCertificateClient(adapter);
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.exists).toBe(true);
    expect(body.thumbprint).toBe("AB:CD:EF:12:34");
    expect(body.subject).toBe("CN=collatr-edge-test");
    expect(body.path).toBe(certPath);
  });

  it("returns exists=false when cert file is missing", async () => {
    const adapter = mockAdapter({
      certInfo: {
        clientCert: {
          path: "/nonexistent/cert.pem",
          exists: false,
        },
        inputs: [],
      },
    });

    const resp = handleCertificateClient(adapter);
    const body = await resp.json();

    expect(body.configured).toBe(true);
    expect(body.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/certificates/client/download
// ---------------------------------------------------------------------------

describe("handleCertificateDownload", () => {
  it("returns 404 when no cert exists", () => {
    const adapter = mockAdapter();
    const resp = handleCertificateDownload(adapter, { format: "pem" });
    expect(resp.status).toBe(404);
  });

  it("returns 400 for invalid format", () => {
    const adapter = mockAdapter({
      certInfo: {
        clientCert: { path: "/some/path", exists: true },
        inputs: [],
      },
    });
    const resp = handleCertificateDownload(adapter, { format: "xml" });
    expect(resp.status).toBe(400);
  });

  it("downloads PEM with correct Content-Type and filename", async () => {
    const { certPath } = generateTestCert(tempDir);
    const adapter = mockAdapter({
      certInfo: {
        clientCert: { path: certPath, exists: true },
        inputs: [],
      },
    });

    const resp = handleCertificateDownload(adapter, { format: "pem" });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/x-pem-file");
    expect(resp.headers.get("Content-Disposition")).toContain(
      "collatr-edge-client.pem",
    );

    const body = await resp.text();
    expect(body).toContain("BEGIN CERTIFICATE");
    expect(body).toContain("END CERTIFICATE");
  });

  it("downloads DER with correct Content-Type and filename", async () => {
    const { certPath } = generateTestCert(tempDir);
    const adapter = mockAdapter({
      certInfo: {
        clientCert: { path: certPath, exists: true },
        inputs: [],
      },
    });

    const resp = handleCertificateDownload(adapter, { format: "der" });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe(
      "application/x-x509-ca-cert",
    );
    expect(resp.headers.get("Content-Disposition")).toContain(
      "collatr-edge-client.der",
    );

    const body = await resp.arrayBuffer();
    // DER files start with 0x30 (ASN.1 SEQUENCE tag)
    expect(new Uint8Array(body)[0]).toBe(0x30);
  });

  it("defaults to PEM format when format not specified", async () => {
    const { certPath } = generateTestCert(tempDir);
    const adapter = mockAdapter({
      certInfo: {
        clientCert: { path: certPath, exists: true },
        inputs: [],
      },
    });

    const resp = handleCertificateDownload(adapter, {});

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/x-pem-file");
  });
});

// ---------------------------------------------------------------------------
// GET /api/certificates/status
// ---------------------------------------------------------------------------

describe("handleCertificateStatus", () => {
  it("returns empty inputs array when no OPC-UA configured", async () => {
    const adapter = mockAdapter();
    const resp = handleCertificateStatus(adapter);
    const body = await resp.json();

    expect(resp.status).toBe(200);
    expect(body.inputs).toEqual([]);
  });

  it("returns per-input connection status", async () => {
    const adapter = mockAdapter({
      certInfo: {
        clientCert: null,
        inputs: [
          {
            alias: "siemens_line3",
            endpoint: "opc.tcp://192.168.10.50:4840",
            connectionState: "connected",
          },
          {
            alias: "kepware_cell1",
            endpoint: "opc.tcp://192.168.10.51:4840",
            connectionState: "unknown",
          },
        ],
      },
    });

    const resp = handleCertificateStatus(adapter);
    const body = await resp.json();

    expect(body.inputs).toHaveLength(2);
    expect(body.inputs[0].alias).toBe("siemens_line3");
    expect(body.inputs[0].connectionState).toBe("connected");
    expect(body.inputs[1].alias).toBe("kepware_cell1");
    expect(body.inputs[1].connectionState).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// POST /api/certificates/trust — SQLite trust store (MF-1) + auth (MF-2)
// ---------------------------------------------------------------------------

describe("handleCertificateTrust", () => {
  let trustStore: TrustStore;

  beforeEach(() => {
    trustStore = new TrustStore(join(tempDir, "trust-store.db"));
  });

  afterEach(() => {
    try { trustStore.close(); } catch { /* already closed */ }
  });

  it("returns 400 when endpoint is missing", () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(adapter, { thumbprint: "AB:CD" });
    expect(resp.status).toBe(400);
  });

  it("returns 400 when thumbprint is missing", () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host:4840",
    });
    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid thumbprint format", () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host:4840",
      thumbprint: "not-a-thumbprint",
    });
    expect(resp.status).toBe(400);
  });

  it("returns 404 when no trust store configured", () => {
    const adapter = mockAdapter({ trustStore: null });
    const resp = handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host:4840",
      thumbprint: "AB:CD:EF:12:34:56:78:90",
    });
    expect(resp.status).toBe(404);
  });

  it("creates trust entry in SQLite store", async () => {
    const adapter = mockAdapter({ trustStore });

    const resp = handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://192.168.10.50:4840",
      thumbprint: "AB:CD:EF:12:34:56:78:90",
    });

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);

    // Verify entry in SQLite
    const entry = trustStore.get("opc.tcp://192.168.10.50:4840");
    expect(entry).not.toBeNull();
    expect(entry!.endpoint).toBe("opc.tcp://192.168.10.50:4840");
    expect(entry!.thumbprint).toBe("AB:CD:EF:12:34:56:78:90");
  });

  it("updates existing trust entry for same endpoint", () => {
    const adapter = mockAdapter({ trustStore });

    // Trust first server
    handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host:4840",
      thumbprint: "AA:BB:CC:DD",
    });

    // Trust same endpoint with different thumbprint
    handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host:4840",
      thumbprint: "11:22:33:44",
    });

    const entries = trustStore.list();
    expect(entries).toHaveLength(1); // Updated, not appended
    expect(entries[0].thumbprint).toBe("11:22:33:44");
  });

  it("appends new endpoint to existing trust store", () => {
    const adapter = mockAdapter({ trustStore });

    handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host1:4840",
      thumbprint: "AA:BB:CC:DD",
    });

    handleCertificateTrust(adapter, {
      endpoint: "opc.tcp://host2:4840",
      thumbprint: "11:22:33:44",
    });

    const entries = trustStore.list();
    expect(entries).toHaveLength(2);
  });

  // MF-2: Authentication tests
  it("returns 401 when admin_token is set but no auth header provided", () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(
      adapter,
      { endpoint: "opc.tcp://host:4840", thumbprint: "AB:CD" },
      "secret-token",
      null,
    );
    expect(resp.status).toBe(401);
  });

  it("returns 401 when auth header has wrong token", () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(
      adapter,
      { endpoint: "opc.tcp://host:4840", thumbprint: "AB:CD" },
      "secret-token",
      "Bearer wrong-token",
    );
    expect(resp.status).toBe(401);
  });

  it("succeeds when auth header has correct token", async () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(
      adapter,
      { endpoint: "opc.tcp://host:4840", thumbprint: "AB:CD:EF:12" },
      "secret-token",
      "Bearer secret-token",
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });

  it("skips auth check when no admin_token configured", async () => {
    const adapter = mockAdapter({ trustStore });
    const resp = handleCertificateTrust(
      adapter,
      { endpoint: "opc.tcp://host:4840", thumbprint: "AB:CD:EF:12" },
      undefined, // no token configured
      null,      // no auth header
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Certificate page rendering
// ---------------------------------------------------------------------------

describe("certificates page rendering", () => {
  it("renders with OPC-UA inputs listed", () => {
    const adapter = mockAdapter({
      certInfo: {
        clientCert: {
          path: "/etc/collatr-edge/certs/client.pem",
          exists: true,
          thumbprint: "AB:CD:EF",
          subject: "CN=collatr-edge",
          validFrom: "2024-01-01",
          validTo: "2025-01-01",
        },
        inputs: [
          {
            alias: "siemens_line3",
            endpoint: "opc.tcp://192.168.10.50:4840",
            connectionState: "connected",
          },
        ],
      },
    });

    const resp = handleCertificatesPage(adapter);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
  });

  it("page HTML contains client cert thumbprint", async () => {
    const adapter = mockAdapter({
      certInfo: {
        clientCert: {
          path: "/path/to/cert.pem",
          exists: true,
          thumbprint: "AB:CD:EF:12:34",
          subject: "CN=test",
          validFrom: "2024-01-01",
          validTo: "2025-01-01",
        },
        inputs: [],
      },
    });

    const resp = handleCertificatesPage(adapter);
    const html = await resp.text();

    expect(html).toContain("AB:CD:EF:12:34");
    expect(html).toContain("CN=test");
    expect(html).toContain("Download .pem");
    expect(html).toContain("Download .der");
  });

  it("page HTML contains OPC-UA input endpoints", async () => {
    const adapter = mockAdapter({
      certInfo: {
        clientCert: null,
        inputs: [
          {
            alias: "siemens_line3",
            endpoint: "opc.tcp://192.168.10.50:4840",
            connectionState: "connected",
          },
        ],
      },
    });

    const resp = handleCertificatesPage(adapter);
    const html = await resp.text();

    expect(html).toContain("siemens_line3");
    expect(html).toContain("opc.tcp://192.168.10.50:4840");
    expect(html).toContain("Connected");
  });

  it("renders gracefully with zero OPC-UA inputs", async () => {
    const adapter = mockAdapter({
      certInfo: { clientCert: null, inputs: [] },
    });

    const resp = handleCertificatesPage(adapter);
    const html = await resp.text();

    expect(html).toContain("No OPC-UA inputs are configured");
    expect(html).not.toContain("Connection Status");
  });

  it("page contains navigation link back to dashboard", async () => {
    const adapter = mockAdapter();
    const resp = handleCertificatesPage(adapter);
    const html = await resp.text();

    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests (via Elysia server)
// ---------------------------------------------------------------------------

describe("certificate HTTP endpoints via Elysia", () => {
  let port: number;
  let app: ReturnType<typeof createWebServer>;

  beforeEach(() => {
    port = getFreePort();
  });

  afterEach(() => {
    try {
      stopWebServer(app);
    } catch {
      /* already stopped */
    }
  });

  it("GET /certificates returns HTML page", async () => {
    const adapter = mockAdapter();
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(`http://127.0.0.1:${port}/certificates`);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
  });

  it("GET /api/certificates/client returns JSON", async () => {
    const adapter = mockAdapter();
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `http://127.0.0.1:${port}/api/certificates/client`,
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.configured).toBe(false);
  });

  it("GET /api/certificates/status returns JSON", async () => {
    const adapter = mockAdapter();
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `http://127.0.0.1:${port}/api/certificates/status`,
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.inputs).toEqual([]);
  });

  it("GET /api/certificates/client/download?format=pem returns cert file", async () => {
    const { certPath } = generateTestCert(tempDir);
    const adapter = mockAdapter({
      certInfo: {
        clientCert: { path: certPath, exists: true },
        inputs: [],
      },
    });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `http://127.0.0.1:${port}/api/certificates/client/download?format=pem`,
    );

    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("BEGIN CERTIFICATE");
  });

  it("POST /api/certificates/trust succeeds without auth when no token configured", async () => {
    const store = new TrustStore(join(tempDir, "trust-store.db"));
    const adapter = mockAdapter({ trustStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `http://127.0.0.1:${port}/api/certificates/trust`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "opc.tcp://host:4840",
          thumbprint: "AB:CD:EF:12",
        }),
      },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    store.close();
  });

  it("POST /api/certificates/trust requires auth when admin_token is configured", async () => {
    const store = new TrustStore(join(tempDir, "trust-store-auth.db"));
    const adapter = mockAdapter({ trustStore: store });
    const config: WebUIConfig = {
      enabled: true,
      port,
      bind: "127.0.0.1",
      admin_token: "test-secret",
    };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    // Without token — expect 401
    const resp1 = await fetch(
      `http://127.0.0.1:${port}/api/certificates/trust`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "opc.tcp://host:4840",
          thumbprint: "AB:CD:EF:12",
        }),
      },
    );
    expect(resp1.status).toBe(401);

    // With correct token — expect 200
    const resp2 = await fetch(
      `http://127.0.0.1:${port}/api/certificates/trust`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({
          endpoint: "opc.tcp://host:4840",
          thumbprint: "AB:CD:EF:12",
        }),
      },
    );
    expect(resp2.status).toBe(200);
    store.close();
  });
});
