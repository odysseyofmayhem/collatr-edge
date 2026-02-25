// Unit tests: CSV export endpoint with UTC and local timezone columns
// Phase 9 Task 9.5: CSV export with dual timestamps
// PRD refs: §17 Local Web UI, §11 Local Data Store, §22 Acceptance Criteria (Scenario 4)

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleExport, addFormattedTimestamps } from "../../../../src/web/routes/export";
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
} from "../../../../src/web/adapter";
import type { PipelineState } from "../../../../src/pipeline/runtime";
import {
  LocalStoreOutput,
  LocalStoreConfigSchema,
  type LocalStoreConfig,
} from "../../../../src/plugins/outputs/local-store";
import { createMetric, type FieldValue } from "../../../../src/core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-export-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeStoreConfig(overrides: Partial<Record<string, unknown>> = {}): LocalStoreConfig {
  return LocalStoreConfigSchema.parse({
    path: tempDir,
    retention_days: 9999,
    retention_max_gb: 100,
    ...overrides,
  });
}

// Fixed timestamp: 2024-01-15 12:00:00 UTC in nanoseconds
const BASE_TS_NS = 1705320000000000000n;
const NS_PER_SEC = 1_000_000_000n;
const NS_PER_MS = 1_000_000n;

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
  tags?: Record<string, string>;
  timestamp?: bigint;
} = {}) {
  return createMetric({
    name: overrides.name ?? "temperature",
    fields: overrides.fields ?? { value: 23.5 },
    tags: overrides.tags,
    timestamp: overrides.timestamp ?? BASE_TS_NS,
  });
}

function mockAdapter(overrides?: {
  state?: PipelineState;
  plugins?: PluginHealth[];
  metrics?: Map<string, LiveMetricValue>;
  localStore?: LocalStoreOutput | null;
}): WebUIAdapter {
  const state = overrides?.state ?? "running";
  const localStore = overrides?.localStore ?? null;

  return {
    getStatus: () => ({ state, startedAt: Date.now() - 60000 }),
    getPluginHealth: () => overrides?.plugins ?? [],
    getLiveMetrics: () => overrides?.metrics ?? new Map<string, LiveMetricValue>(),
    getNetworkPolicy: () => null,
    getUptime: () => 60000,
    getMemoryUsage: () => ({
      heapUsed: 45_000_000,
      heapTotal: 80_000_000,
      rss: 120_000_000,
    }),
    handleMetric: () => {},
    getLocalStore: () => localStore,
    getCertificateInfo: () => ({ clientCert: null, inputs: [] }),
    getTrustStore: () => null,
  };
}

function getFreePort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

// ---------------------------------------------------------------------------
// Unit tests — addFormattedTimestamps
// ---------------------------------------------------------------------------

describe("addFormattedTimestamps", () => {
  it("adds timestamp_utc, timestamp_local, and timestamp_ns columns to header", () => {
    const csv = "timestamp,name,quality,value\n1705320000000000000,temperature,0,23.5\n";
    const result = addFormattedTimestamps(csv, "UTC");
    const header = result.split("\n")[0]!;

    expect(header).toContain("timestamp_utc");
    expect(header).toContain("timestamp_local");
    expect(header).toContain("timestamp_ns");
    expect(header).not.toMatch(/^timestamp,/); // original "timestamp" replaced
  });

  it("timestamp_utc is valid ISO 8601 UTC (Z suffix)", () => {
    const csv = "timestamp,name,quality,value\n1705320000000000000,temperature,0,23.5\n";
    const result = addFormattedTimestamps(csv, "UTC");
    const dataRow = result.split("\n")[1]!;
    const utcCol = dataRow.split(",")[0]!;

    expect(utcCol).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Verify it's the correct date: 2024-01-15T12:00:00.000Z
    expect(utcCol).toBe("2024-01-15T12:00:00.000Z");
  });

  it("timestamp_local includes timezone offset", () => {
    const csv = "timestamp,name,quality,value\n1705320000000000000,temperature,0,23.5\n";
    const result = addFormattedTimestamps(csv, "Europe/London");
    const dataRow = result.split("\n")[1]!;
    const localCol = dataRow.split(",")[1]!;

    // Should have +00:00 or +01:00 depending on DST (January = no DST = +00:00)
    expect(localCol).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/);
    expect(localCol).toContain("+00:00"); // London in January = UTC
  });

  it("timestamp_local shows offset for non-UTC timezone", () => {
    const csv = "timestamp,name,quality,value\n1705320000000000000,temperature,0,23.5\n";
    const result = addFormattedTimestamps(csv, "America/New_York");
    const dataRow = result.split("\n")[1]!;
    const localCol = dataRow.split(",")[1]!;

    // New York in January = EST = -05:00
    expect(localCol).toContain("-05:00");
    // Time should be adjusted: 12:00 UTC = 07:00 EST
    expect(localCol).toContain("07:00:00");
  });

  it("preserves original nanosecond timestamp as timestamp_ns", () => {
    const csv = "timestamp,name,quality,value\n1705320000000000000,temperature,0,23.5\n";
    const result = addFormattedTimestamps(csv, "UTC");
    const dataRow = result.split("\n")[1]!;
    const nsCol = dataRow.split(",")[2]!;

    expect(nsCol).toBe("1705320000000000000");
  });

  it("preserves remaining columns unchanged", () => {
    const csv = "timestamp,name,quality,value\n1705320000000000000,temperature,0,23.5\n";
    const result = addFormattedTimestamps(csv, "UTC");
    const dataRow = result.split("\n")[1]!;
    const parts = dataRow.split(",");

    // Columns: timestamp_utc, timestamp_local, timestamp_ns, name, quality, value
    expect(parts[3]).toBe("temperature");
    expect(parts[4]).toBe("0");
    expect(parts[5]).toBe("23.5");
  });

  it("handles multiple data rows", () => {
    const csv = [
      "timestamp,name,quality,value",
      "1705320000000000000,temperature,0,23.5",
      "1705320001000000000,temperature,0,24.0",
      "1705320002000000000,temperature,0,24.5",
      "",
    ].join("\n");

    const result = addFormattedTimestamps(csv, "UTC");
    const lines = result.split("\n").filter((l) => l.length > 0);

    expect(lines.length).toBe(4); // header + 3 data rows
    // All rows should have the 3 timestamp columns
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toContain("T");
      expect(lines[i]).toContain("Z");
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests — handleExport
// ---------------------------------------------------------------------------

describe("handleExport", () => {
  it("returns 400 when from/to parameters are missing", () => {
    const adapter = mockAdapter();
    const resp = handleExport(adapter, {});
    expect(resp.status).toBe(400);
  });

  it("returns 400 when only from is provided", () => {
    const adapter = mockAdapter();
    const resp = handleExport(adapter, { from: "2024-01-15T00:00:00Z" });
    expect(resp.status).toBe(400);
  });

  it("returns 400 when only to is provided", () => {
    const adapter = mockAdapter();
    const resp = handleExport(adapter, { to: "2024-01-16T00:00:00Z" });
    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid from/to format", () => {
    const adapter = mockAdapter();
    const resp = handleExport(adapter, { from: "not-a-date", to: "also-not-a-date" });
    expect(resp.status).toBe(400);
  });

  it("returns 400 when from is after to", () => {
    const adapter = mockAdapter();
    const resp = handleExport(adapter, {
      from: "2024-01-16T00:00:00Z",
      to: "2024-01-15T00:00:00Z",
    });
    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid timezone", () => {
    const adapter = mockAdapter();
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "Invalid/Timezone",
    });
    expect(resp.status).toBe(400);
  });

  it("returns 503 when no local store is configured", () => {
    const adapter = mockAdapter({ localStore: null });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
    });
    expect(resp.status).toBe(503);
  });

  it("returns 204 when no data in time range", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
    });

    expect(resp.status).toBe(204);

    await store.close();
  });

  it("returns CSV with correct Content-Type", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/csv");

    await store.close();
  });

  it("Content-Disposition header triggers download with timestamped filename", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
    });

    const disposition = resp.headers.get("Content-Disposition");
    expect(disposition).toBeTruthy();
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("collatr-edge-export-");
    expect(disposition).toContain(".csv");

    await store.close();
  });

  it("CSV contains timestamp_utc and timestamp_local columns", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "UTC",
    });

    const csv = await resp.text();
    const header = csv.split("\n")[0]!;

    expect(header).toContain("timestamp_utc");
    expect(header).toContain("timestamp_local");
    expect(header).toContain("timestamp_ns");

    await store.close();
  });

  it("timestamp_utc values are valid ISO 8601 UTC", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "UTC",
    });

    const csv = await resp.text();
    const dataRow = csv.split("\n")[1]!;
    const utcCol = dataRow.split(",")[0]!;

    // Must end with Z (UTC)
    expect(utcCol).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await store.close();
  });

  it("timestamp_local includes timezone offset", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "America/New_York",
    });

    const csv = await resp.text();
    const dataRow = csv.split("\n")[1]!;
    const localCol = dataRow.split(",")[1]!;

    // Must include timezone offset like -05:00
    expect(localCol).toMatch(/[+-]\d{2}:\d{2}$/);

    await store.close();
  });

  it("defaults timezone to system when tz is not provided", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
    });

    const csv = await resp.text();
    const dataRow = csv.split("\n")[1]!;
    const localCol = dataRow.split(",")[1]!;

    // Should have some timezone offset
    expect(localCol).toMatch(/[+-]\d{2}:\d{2}$/);

    await store.close();
  });

  it("accepts valid IANA timezone names", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });

    // Europe/Berlin in January = CET = +01:00
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "Europe/Berlin",
    });

    expect(resp.status).toBe(200);
    const csv = await resp.text();
    const dataRow = csv.split("\n")[1]!;
    const localCol = dataRow.split(",")[1]!;

    expect(localCol).toContain("+01:00");

    await store.close();
  });

  it("exports multiple metrics correctly", async () => {
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    await store.write([
      makeMetric({ name: "temperature", fields: { value: 23.5 }, timestamp: BASE_TS_NS }),
      makeMetric({ name: "pressure", fields: { value: 1013.2 }, timestamp: BASE_TS_NS + NS_PER_SEC }),
      makeMetric({ name: "temperature", fields: { value: 24.0 }, timestamp: BASE_TS_NS + NS_PER_SEC * 2n }),
    ]);

    const adapter = mockAdapter({ localStore: store });
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "UTC",
    });

    const csv = await resp.text();
    const lines = csv.split("\n").filter((l) => l.length > 0);

    // Header + 3 data rows
    expect(lines.length).toBe(4);

    await store.close();
  });

  it("export completes quickly for reasonable data volume", async () => {
    // Acceptance criteria: 1-hour export in <5 seconds
    const store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();

    // Write 360 metrics (1 per 10 seconds for 1 hour — reasonable volume)
    const batch = [];
    for (let i = 0; i < 360; i++) {
      batch.push(
        makeMetric({
          fields: { value: 20 + Math.random() * 10 },
          timestamp: BASE_TS_NS + BigInt(i) * NS_PER_SEC * 10n,
        }),
      );
    }
    await store.write(batch);

    const adapter = mockAdapter({ localStore: store });

    const start = performance.now();
    const resp = handleExport(adapter, {
      from: "2024-01-15T00:00:00Z",
      to: "2024-01-16T00:00:00Z",
      tz: "UTC",
    });
    const elapsed = performance.now() - start;

    expect(resp.status).toBe(200);
    const csv = await resp.text();
    expect(csv.split("\n").filter((l) => l.length > 0).length).toBe(361); // header + 360 rows

    // Must complete in <5 seconds (acceptance criteria Scenario 4)
    expect(elapsed).toBeLessThan(5000);

    await store.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests (via Elysia server)
// ---------------------------------------------------------------------------

describe("GET /api/export HTTP endpoint", () => {
  let store: LocalStoreOutput;
  let port: number;
  let app: ReturnType<typeof createWebServer>;

  beforeEach(async () => {
    store = new LocalStoreOutput(makeStoreConfig());
    await store.connect();
    port = getFreePort();
  });

  afterEach(async () => {
    try {
      stopWebServer(app);
    } catch { /* already stopped */ }
    await store.close();
  });

  it("returns CSV via HTTP with correct headers", async () => {
    await store.write([makeMetric()]);

    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `http://127.0.0.1:${port}/api/export?from=2024-01-15T00:00:00Z&to=2024-01-16T00:00:00Z&tz=UTC`,
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/csv");
    expect(resp.headers.get("Content-Disposition")).toContain("attachment");

    const csv = await resp.text();
    expect(csv).toContain("timestamp_utc");
    expect(csv).toContain("timestamp_local");
  });

  it("returns 204 for empty time range via HTTP", async () => {
    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(
      `http://127.0.0.1:${port}/api/export?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
    );

    expect(resp.status).toBe(204);
  });

  it("returns 400 for missing parameters via HTTP", async () => {
    const adapter = mockAdapter({ localStore: store });
    const config: WebUIConfig = { enabled: true, port, bind: "127.0.0.1" };
    app = createWebServer(config, adapter);
    await startWebServer(app, config);

    const resp = await fetch(`http://127.0.0.1:${port}/api/export`);
    expect(resp.status).toBe(400);
  });
});
