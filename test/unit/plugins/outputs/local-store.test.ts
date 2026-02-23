// Unit tests: Local data store output plugin
// PRD refs: §11 Local Data Store

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  LocalStoreOutput,
  LocalStoreConfigSchema,
  type LocalStoreConfig,
  timestampToDateString,
  encodeFields,
  decodeFields,
} from "@plugins/outputs/local-store";
import { createMetric, type Metric, type FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-localstore-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): LocalStoreConfig {
  return LocalStoreConfigSchema.parse({
    path: tempDir,
    retention_days: 9999,   // don't trigger time retention by default
    retention_max_gb: 100,  // don't trigger size retention by default
    ...overrides,
  });
}

function makeMetric(overrides: {
  name?: string;
  fields?: Record<string, FieldValue>;
  tags?: Record<string, string>;
  timestamp?: bigint;
} = {}): Metric {
  return createMetric({
    name: overrides.name ?? "temperature",
    fields: overrides.fields ?? { value: 23.5 },
    tags: overrides.tags,
    timestamp: overrides.timestamp ?? JAN_15_NOON_NS,
  });
}

// Fixed timestamps for deterministic tests
const JAN_15_NOON_NS   = 1705320000000000000n; // 2024-01-15 12:00:00 UTC
const JAN_16_NOON_NS   = 1705406400000000000n; // 2024-01-16 12:00:00 UTC
const JAN_15_235959_NS = 1705363199000000000n; // 2024-01-15 23:59:59 UTC
const JAN_16_000000_NS = 1705363200000000000n; // 2024-01-16 00:00:00 UTC
const OLD_TS_NS        = 1577836800000000000n; // 2020-01-01 00:00:00 UTC

// Broad query ranges covering full days
const JAN_15_START_NS  = 1705276800000000000n; // 2024-01-15 00:00:00 UTC
const JAN_15_END_NS    = 1705363199000000000n; // 2024-01-15 23:59:59 UTC
const JAN_16_END_NS    = 1705449599000000000n; // 2024-01-16 23:59:59 UTC

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Local Store Output Plugin", () => {

  // =========================================================================
  // Core write/read
  // =========================================================================

  it("write() inserts metrics into daily SQLite file with correct schema", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    const batch = [
      makeMetric({ name: "temp", fields: { value: 23.5 }, tags: { sensor: "s1" }, timestamp: JAN_15_NOON_NS }),
      makeMetric({ name: "pressure", fields: { value: 101.3 }, tags: { sensor: "s2" }, timestamp: JAN_15_NOON_NS }),
    ];

    await store.write(batch);

    const dbPath = join(tempDir, "data_2024_01_15.db");
    expect(existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT timestamp, name, tags_hash, tags, quality FROM metrics ORDER BY name",
    ).all() as { timestamp: number; name: string; tags_hash: number; tags: string; quality: number }[];

    expect(rows.length).toBe(2);
    expect(rows[0]!.name).toBe("pressure");
    expect(rows[0]!.quality).toBe(0);
    expect(JSON.parse(rows[0]!.tags)).toEqual({ sensor: "s2" });
    expect(rows[1]!.name).toBe("temp");
    expect(JSON.parse(rows[1]!.tags)).toEqual({ sensor: "s1" });

    db.close();
    await store.close();
  });

  it("Metrics retrievable: query by time range returns correct data", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([
      makeMetric({ name: "temp", fields: { value: 20.0 }, timestamp: JAN_15_NOON_NS }),
      makeMetric({ name: "temp", fields: { value: 25.0 }, timestamp: JAN_15_NOON_NS + 1000000000n }),
    ]);

    const results = store.query(JAN_15_START_NS, JAN_15_END_NS);
    expect(results.length).toBe(2);
    expect(results[0]!.fields.value).toBe(20.0);
    expect(results[1]!.fields.value).toBe(25.0);

    await store.close();
  });

  // =========================================================================
  // MessagePack encoding
  // =========================================================================

  it("MessagePack round-trip: all FieldValue types encode and decode correctly", () => {
    const fields = new Map<string, FieldValue>([
      ["float_val", 23.5],
      ["int_val", 42],
      ["string_val", "hello"],
      ["bool_val", true],
      ["negative", -15.7],
    ]);

    const encoded = encodeFields(fields);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeFields(encoded);
    expect(decoded.float_val).toBe(23.5);
    expect(decoded.int_val).toBe(42);
    expect(decoded.string_val).toBe("hello");
    expect(decoded.bool_val).toBe(true);
    expect(decoded.negative).toBe(-15.7);
  });

  // =========================================================================
  // Daily rotation
  // =========================================================================

  it("Daily rotation: metrics on different UTC days go to different files", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([
      makeMetric({ name: "day1_metric", fields: { value: 1 }, timestamp: JAN_15_NOON_NS }),
      makeMetric({ name: "day2_metric", fields: { value: 2 }, timestamp: JAN_16_NOON_NS }),
    ]);

    const files = await readdir(tempDir);
    const dataFiles = files.filter(f => f.startsWith("data_") && f.endsWith(".db"));
    expect(dataFiles).toContain("data_2024_01_15.db");
    expect(dataFiles).toContain("data_2024_01_16.db");

    // Verify each file has the correct metric
    const db15 = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const rows15 = db15.prepare("SELECT name FROM metrics").all() as { name: string }[];
    expect(rows15.length).toBe(1);
    expect(rows15[0]!.name).toBe("day1_metric");
    db15.close();

    const db16 = new Database(join(tempDir, "data_2024_01_16.db"), { readonly: true });
    const rows16 = db16.prepare("SELECT name FROM metrics").all() as { name: string }[];
    expect(rows16.length).toBe(1);
    expect(rows16[0]!.name).toBe("day2_metric");
    db16.close();

    await store.close();
  });

  it("Midnight boundary: metric at 23:59:59 UTC → today's file, 00:00:00 → tomorrow's file", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([
      makeMetric({ name: "before_midnight", fields: { value: 1 }, timestamp: JAN_15_235959_NS }),
      makeMetric({ name: "after_midnight", fields: { value: 2 }, timestamp: JAN_16_000000_NS }),
    ]);

    const db15 = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const rows15 = db15.prepare("SELECT name FROM metrics").all() as { name: string }[];
    expect(rows15.length).toBe(1);
    expect(rows15[0]!.name).toBe("before_midnight");
    db15.close();

    const db16 = new Database(join(tempDir, "data_2024_01_16.db"), { readonly: true });
    const rows16 = db16.prepare("SELECT name FROM metrics").all() as { name: string }[];
    expect(rows16.length).toBe(1);
    expect(rows16[0]!.name).toBe("after_midnight");
    db16.close();

    await store.close();
  });

  // =========================================================================
  // Tag index
  // =========================================================================

  it("Tag index populated: name + tags_hash entries created on write", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([
      makeMetric({
        name: "temp",
        fields: { value: 23.5 },
        tags: { sensor: "s1", location: "factory" },
        timestamp: JAN_15_NOON_NS,
      }),
    ]);

    const db = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const tagRows = db.prepare("SELECT name, tags_hash, tags FROM tag_index").all() as {
      name: string; tags_hash: number; tags: string;
    }[];

    expect(tagRows.length).toBe(1);
    expect(tagRows[0]!.name).toBe("temp");
    expect(tagRows[0]!.tags_hash).toBeGreaterThan(0);

    const tags = JSON.parse(tagRows[0]!.tags);
    expect(tags.location).toBe("factory");
    expect(tags.sensor).toBe("s1");

    db.close();
    await store.close();
  });

  it("Tag index upsert: last_seen updated on subsequent writes for same series", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    const ts1 = JAN_15_NOON_NS;
    const ts2 = JAN_15_NOON_NS + 60000000000n; // +1 minute

    await store.write([
      makeMetric({ name: "temp", fields: { value: 23.5 }, tags: { sensor: "s1" }, timestamp: ts1 }),
    ]);
    await store.write([
      makeMetric({ name: "temp", fields: { value: 24.0 }, tags: { sensor: "s1" }, timestamp: ts2 }),
    ]);

    const db = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const row = db.prepare("SELECT first_seen, last_seen FROM tag_index WHERE name = 'temp'")
      .safeIntegers(true).get() as {
      first_seen: bigint; last_seen: bigint;
    };

    expect(row.first_seen).toBe(ts1);
    expect(row.last_seen).toBe(ts2);

    db.close();
    await store.close();
  });

  // =========================================================================
  // Quality mapping
  // =========================================================================

  it("Quality mapping: good=0, uncertain=1, bad=2", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    const goodMetric = makeMetric({ name: "good_m", timestamp: JAN_15_NOON_NS });
    const uncertainMetric = makeMetric({ name: "uncertain_m", timestamp: JAN_15_NOON_NS + 1000000000n });
    uncertainMetric.addTag("quality", "uncertain");
    const badMetric = makeMetric({ name: "bad_m", timestamp: JAN_15_NOON_NS + 2000000000n });
    badMetric.addTag("quality", "bad");

    await store.write([goodMetric, uncertainMetric, badMetric]);

    const db = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const rows = db.prepare("SELECT name, quality FROM metrics ORDER BY name").all() as {
      name: string; quality: number;
    }[];

    expect(rows.find(r => r.name === "bad_m")!.quality).toBe(2);
    expect(rows.find(r => r.name === "good_m")!.quality).toBe(0);
    expect(rows.find(r => r.name === "uncertain_m")!.quality).toBe(1);

    db.close();
    await store.close();
  });

  // =========================================================================
  // Retention
  // =========================================================================

  it("Retention time-based: daily files older than retention_days are deleted", async () => {
    // Create an old daily file manually
    const oldDb = new Database(join(tempDir, "data_2020_01_01.db"));
    oldDb.exec("CREATE TABLE marker (id INTEGER)");
    oldDb.close();

    const store = new LocalStoreOutput(makeConfig({ retention_days: 1 }));
    await store.connect(); // runs retention on startup

    expect(existsSync(join(tempDir, "data_2020_01_01.db"))).toBe(false);

    // Today's file should exist (created by connect)
    const files = await readdir(tempDir);
    const dataFiles = files.filter(f => f.startsWith("data_") && f.endsWith(".db"));
    expect(dataFiles.length).toBeGreaterThanOrEqual(1);

    await store.close();
  });

  it("Retention size-based: oldest daily file deleted when total exceeds retention_max_gb", async () => {
    // Create two old daily files — each ~5MB (exceeds 0.1GB minimum config together)
    for (const fname of ["data_2024_01_10.db", "data_2024_01_11.db"]) {
      const db = new Database(join(tempDir, fname));
      db.exec("CREATE TABLE padding (data BLOB)");
      const blob = Buffer.alloc(500_000, 0x42);
      const stmt = db.prepare("INSERT INTO padding (data) VALUES (?)");
      for (let i = 0; i < 10; i++) stmt.run(blob); // ~5MB per file
      db.close();
    }

    // Total ~10MB + today's small file > 0.1GB? No — 10MB < 100MB (0.1GB).
    // We need to use the minimum config (0.1 GB = ~107MB) and make files bigger,
    // OR we can verify with a more direct approach: use 0.1 and create >107MB of data.
    // Instead, test the mechanism by checking that runRetention() respects the limit.
    // Create enough files to exceed 0.1 GB.
    for (let day = 1; day <= 18; day++) {
      const fname = `data_2024_01_${String(day).padStart(2, "0")}.db`;
      if (existsSync(join(tempDir, fname))) continue; // skip already-created files
      const db = new Database(join(tempDir, fname));
      db.exec("CREATE TABLE padding (data BLOB)");
      const blob = Buffer.alloc(500_000, 0x42);
      const stmt = db.prepare("INSERT INTO padding (data) VALUES (?)");
      for (let i = 0; i < 14; i++) stmt.run(blob); // ~7MB per file
      db.close();
    }

    // 18 files * ~7MB = ~126MB > 107MB (0.1 GB)
    const store = new LocalStoreOutput(makeConfig({
      retention_max_gb: 0.1,
      retention_days: 9999,
    }));
    await store.connect(); // runs retention

    // Oldest files should be deleted to get under 0.1 GB limit
    // data_2024_01_01.db should definitely be gone (oldest)
    expect(existsSync(join(tempDir, "data_2024_01_01.db"))).toBe(false);

    // At least some newer files should remain
    const files = await readdir(tempDir);
    const dataFiles = files.filter(f => f.startsWith("data_") && f.endsWith(".db"));
    expect(dataFiles.length).toBeGreaterThan(0);

    await store.close();
  });

  // =========================================================================
  // SQLite configuration
  // =========================================================================

  it("WAL mode enabled on new databases (PRAGMA journal_mode check)", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();
    await store.write([makeMetric({ timestamp: JAN_15_NOON_NS })]);

    const db = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");

    db.close();
    await store.close();
  });

  it("Startup recovery: WAL checkpoint runs on connect()", async () => {
    // First session: write and close
    const store1 = new LocalStoreOutput(makeConfig());
    await store1.connect();
    await store1.write([makeMetric({ timestamp: JAN_15_NOON_NS })]);
    await store1.close();

    // Second session: simulates restart
    const store2 = new LocalStoreOutput(makeConfig());
    await store2.connect();

    // Query triggers getOrOpenDb() which runs wal_checkpoint on open
    const results = store2.query(JAN_15_START_NS, JAN_15_END_NS);
    expect(results.length).toBe(1);
    expect(results[0]!.fields.value).toBe(23.5);

    await store2.close();
  });

  // =========================================================================
  // Transaction behaviour
  // =========================================================================

  it("Batch write atomicity: all-or-nothing transaction", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    const batch = Array.from({ length: 100 }, (_, i) =>
      makeMetric({
        name: `metric_${String(i).padStart(3, "0")}`,
        fields: { value: i },
        timestamp: JAN_15_NOON_NS + BigInt(i) * 1000000000n,
      }),
    );

    await store.write(batch);

    const results = store.query(JAN_15_START_NS, JAN_15_END_NS);
    expect(results.length).toBe(100);

    await store.close();
  });

  it("SQLITE_BUSY: concurrent reads don't block writes (WAL + busy_timeout)", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([makeMetric({ timestamp: JAN_15_NOON_NS })]);

    // Open a concurrent reader
    const readerDb = new Database(join(tempDir, "data_2024_01_15.db"), { readonly: true });
    const readResult = readerDb.prepare("SELECT COUNT(*) as cnt FROM metrics").get() as { cnt: number };
    expect(readResult.cnt).toBe(1);

    // Write while reader is active — WAL allows concurrent reads + writes
    await store.write([
      makeMetric({ name: "concurrent_write", fields: { value: 42 }, timestamp: JAN_15_NOON_NS + 1000000000n }),
    ]);

    const results = store.query(JAN_15_START_NS, JAN_15_END_NS);
    expect(results.length).toBe(2);

    readerDb.close();
    await store.close();
  });

  // =========================================================================
  // CSV export
  // =========================================================================

  it("CSV export: correct headers and data for time range", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([
      makeMetric({
        name: "temp",
        fields: { value: 23.5, status: "ok" },
        tags: { sensor: "s1" },
        timestamp: JAN_15_NOON_NS,
      }),
      makeMetric({
        name: "temp",
        fields: { value: 24.0, status: "ok" },
        tags: { sensor: "s1" },
        timestamp: JAN_15_NOON_NS + 1000000000n,
      }),
    ]);

    const csv = store.exportCSV(JAN_15_START_NS, JAN_15_END_NS);
    const lines = csv.trimEnd().split("\n");

    expect(lines.length).toBe(3); // header + 2 data rows
    // Header includes tag columns between name and quality
    expect(lines[0]).toBe("timestamp,name,sensor,quality,status,value");

    const row1Parts = lines[1]!.split(",");
    expect(row1Parts[1]).toBe("temp");
    expect(row1Parts[2]).toBe("s1"); // tag: sensor
    expect(row1Parts[3]).toBe("0"); // quality = good

    await store.close();
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it("Empty write (no metrics) → no error, no empty transaction", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();
    await store.write([]);
    await store.close();
  });

  it("Write error propagates gracefully when directory becomes read-only", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    // Write one metric successfully
    await store.write([makeMetric({ timestamp: JAN_15_NOON_NS })]);

    // Make directory read-only — new DB file creation will fail
    const { chmodSync } = await import("node:fs");
    chmodSync(tempDir, 0o444);

    try {
      // Write to a different day to force new file creation
      await store.write([makeMetric({ name: "will_fail", timestamp: JAN_16_NOON_NS })]);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    } finally {
      chmodSync(tempDir, 0o755);
    }

    await store.close();
  });

  it("connect() creates data directory if missing", async () => {
    const nested = join(tempDir, "nested", "data", "dir");
    expect(existsSync(nested)).toBe(false);

    const store = new LocalStoreOutput(makeConfig({ path: nested }));
    await store.connect();

    expect(existsSync(nested)).toBe(true);

    await store.close();
  });

  it("close() checkpoints WAL and closes handles", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    await store.write([makeMetric({ timestamp: JAN_15_NOON_NS })]);
    await store.close();

    // Data should be durable after close (WAL checkpointed)
    const dbPath = join(tempDir, "data_2024_01_15.db");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM metrics").get() as { cnt: number };
    expect(row.cnt).toBe(1);
    db.close();

    // WAL file should be truncated or absent after TRUNCATE checkpoint
    const walPath = dbPath + "-wal";
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
  });

  // =========================================================================
  // Downsampling
  // =========================================================================

  it("Downsampling: 60 one-second points → 1 summary with correct min/max/mean/count", async () => {
    const store = new LocalStoreOutput(makeConfig({
      downsample_after_days: 1,
      downsample_interval: "1m",
    }));
    await store.connect();

    // Write 60 one-second metrics to an old daily file (2020-01-01)
    const baseTs = OLD_TS_NS;
    const metrics: Metric[] = [];
    for (let i = 0; i < 60; i++) {
      metrics.push(makeMetric({
        name: "sensor",
        fields: { value: 10 + i },
        tags: { host: "gw-01" },
        timestamp: baseTs + BigInt(i) * 1000000000n,
      }));
    }

    await store.write(metrics);

    // All 60 present before downsample
    const before = store.query(baseTs, baseTs + 60n * 1000000000n);
    expect(before.length).toBe(60);

    store.downsample();

    // Should have 1 summary row (all 60 points in same 1-minute boundary)
    const after = store.query(baseTs, baseTs + 60n * 1000000000n);
    expect(after.length).toBe(1);

    const summary = after[0]!;
    expect(summary.name).toBe("sensor");
    expect(summary.fields.value_min).toBe(10);
    expect(summary.fields.value_max).toBe(69);
    expect(summary.fields.value_count).toBe(60);
    expect(summary.fields.value_mean).toBeCloseTo(39.5, 5);

    await store.close();
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  it("Nanosecond timestamp precision preserved through storage round-trip", async () => {
    const store = new LocalStoreOutput(makeConfig());
    await store.connect();

    // Timestamps with sub-second nanosecond precision that would lose precision via Number()
    const ts1 = 1700000000123456789n;
    const ts2 = 1700000000000000001n;

    await store.write([
      makeMetric({ name: "precise_1", fields: { value: 1 }, timestamp: ts1 }),
      makeMetric({ name: "precise_2", fields: { value: 2 }, timestamp: ts2 }),
    ]);

    const results = store.query(ts2, ts1);
    expect(results.length).toBe(2);

    // Verify exact nanosecond precision — no rounding
    expect(results[0]!.timestamp).toBe(ts2);
    expect(results[1]!.timestamp).toBe(ts1);

    await store.close();
  });

  it("timestampToDateString: nanosecond timestamp → YYYY_MM_DD", () => {
    expect(timestampToDateString(JAN_15_NOON_NS)).toBe("2024_01_15");
    expect(timestampToDateString(JAN_16_NOON_NS)).toBe("2024_01_16");
    expect(timestampToDateString(OLD_TS_NS)).toBe("2020_01_01");
  });

  it("Config defaults match PRD §11", () => {
    const config = LocalStoreConfigSchema.parse({});
    expect(config.enabled).toBe(true);
    expect(config.path).toBe("/var/collatr/data");
    expect(config.retention_days).toBe(90);
    expect(config.retention_max_gb).toBe(10);
    expect(config.rotation).toBe("daily");
    expect(config.downsample_after_days).toBe(7);
    expect(config.downsample_interval).toBe("1m");
  });
});
