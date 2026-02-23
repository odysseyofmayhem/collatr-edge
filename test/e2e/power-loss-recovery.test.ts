// E2E test: SQLite recovery & power loss simulation
// Phase 5 task 5.1 — proves data survives crashes, WAL recovery works, corruption is detected
// PRD refs: §8 Pipeline Lifecycle (SQLite Recovery), §11 Local Data Store, §12 Buffers

import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { createMetric, type Metric } from "@core/metric";
import {
  LocalStoreOutput,
  decodeFields,
} from "@plugins/outputs/local-store";
import {
  StoreForwardBuffer,
  StoreForwardConfigSchema,
} from "@buffer/store-forward";
import { findDailyFiles, countRows, makeLocalStoreConfig } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NS_PER_MS = 1_000_000n;

function makeMetrics(count: number, namePrefix = "test_sensor"): Metric[] {
  const metrics: Metric[] = [];
  for (let i = 0; i < count; i++) {
    metrics.push(
      createMetric({
        name: namePrefix,
        fields: { value: i, temperature: 22.5 + i * 0.01 },
        tags: { host: "test-rig", line: "1" },
      }),
    );
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const openStores: LocalStoreOutput[] = [];

afterEach(() => {
  // Close any stores that weren't closed during the test
  for (const store of openStores) {
    try {
      // Use a sync close workaround: the close() is async but we just need cleanup
      store.close().catch(() => {});
    } catch {
      // Ignore
    }
  }
  openStores.length = 0;

  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `collatr-e2e-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: SQLite recovery & power loss simulation (task 5.1)", () => {
  // -------------------------------------------------------------------------
  // 5.1.1 — Local store WAL recovery after simulated crash
  // -------------------------------------------------------------------------

  it("5.1.1: WAL recovery — all 1000 metrics recovered after unclean shutdown", async () => {
    const tmpDir = makeTempDir("511");

    // Write 1000 metrics via LocalStoreOutput (the real plugin)
    const store = new LocalStoreOutput(makeLocalStoreConfig(tmpDir));
    openStores.push(store);
    await store.connect();

    for (let batch = 0; batch < 10; batch++) {
      await store.write(makeMetrics(100));
    }

    // Simulate crash: do NOT call store.close() before recovery verification.
    // No WAL checkpoint has been explicitly triggered — data is in the WAL only.
    // The internal Database handles are still open (like a process that died).
    // Data should still be recoverable from the WAL.
    // Note: store.close() is called AFTER recovery verification as cleanup only.

    // Re-open the daily file directly (simulates restart)
    const dbFiles = findDailyFiles(tmpDir);
    expect(dbFiles.length).toBe(1);

    const recoveryDb = new Database(join(tmpDir, dbFiles[0]!));
    recoveryDb.exec("PRAGMA journal_mode = WAL");

    // PRD §8 step 6: WAL checkpoint to recover uncommitted data
    recoveryDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // Count rows — all 1000 should be recovered
    const row = recoveryDb
      .prepare("SELECT COUNT(*) as cnt FROM metrics")
      .get() as { cnt: number };
    expect(row.cnt).toBe(1000);

    // Integrity check — should be "ok"
    const check = recoveryDb
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check: string };
    expect(check.integrity_check).toBe("ok");

    // Verify data is decodable
    const sample = recoveryDb
      .prepare("SELECT fields FROM metrics LIMIT 1")
      .get() as { fields: Uint8Array };
    const fields = decodeFields(sample.fields);
    expect(fields["value"]).toBeDefined();
    expect(fields["temperature"]).toBeDefined();

    recoveryDb.close();

    // Cleanup: close the original store's DB handles
    await store.close();
    openStores.length = 0;
  });

  // -------------------------------------------------------------------------
  // 5.1.2 — Store-and-forward buffer: recovery after unresolved transaction
  // -------------------------------------------------------------------------

  it("5.1.2: buffer recovery — unresolved transaction metrics survive restart", async () => {
    const tmpDir = makeTempDir("512");
    const bufferPath = join(tmpDir, "buffer.db");

    const config = StoreForwardConfigSchema.parse({
      metric_buffer_limit: 10000,
      metric_batch_size: 100,
    });

    // First session: add 500 metrics, begin transaction, don't resolve
    const buffer1 = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer1.open();

    // Add 500 metrics in batches of 100
    for (let i = 0; i < 5; i++) {
      buffer1.add(makeMetrics(100, `batch_${i}`));
    }
    expect(buffer1.length).toBe(500);

    // Begin transaction — reads oldest 100 but doesn't resolve
    const tx = buffer1.beginTransaction(100);
    const txMetrics = tx.metrics();
    expect(txMetrics.length).toBe(100);

    // Record the first metric's name for comparison after restart
    const firstMetricName = txMetrics[0]!.name;
    const firstMetricValue = txMetrics[0]!.getField("value");

    // Simulate crash: close without resolving the transaction
    // (In a real crash, the transaction is never committed to DELETE)
    buffer1.close();

    // Second session: re-open and verify all 500 metrics survived
    const buffer2 = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer2.open();

    expect(buffer2.length).toBe(500);

    // Begin new transaction — should return the same first 100 metrics (at-least-once)
    const tx2 = buffer2.beginTransaction(100);
    const tx2Metrics = tx2.metrics();
    expect(tx2Metrics.length).toBe(100);

    // Same metrics as before (same order, same data)
    expect(tx2Metrics[0]!.name).toBe(firstMetricName);
    expect(tx2Metrics[0]!.getField("value")).toBe(firstMetricValue);

    // Clean up
    tx2.acceptAll();
    buffer2.close();
  });

  // -------------------------------------------------------------------------
  // 5.1.3 — Data loss bound: ≤1 second with synchronous=NORMAL
  // -------------------------------------------------------------------------

  it("5.1.3: data loss bound — at most 1s of data lost with synchronous=NORMAL", async () => {
    // Test writes 50 batches × 100ms = ~5s of simulated collection
    const tmpDir = makeTempDir("513");

    const store = new LocalStoreOutput(makeLocalStoreConfig(tmpDir));
    openStores.push(store);
    await store.connect();

    // Write 50 batches of 10 metrics each, 100ms apart (simulates 5s of collection)
    const totalBatches = 50;
    const batchSize = 10;
    const intervalMs = 100;

    for (let batch = 0; batch < totalBatches; batch++) {
      const metrics = makeMetrics(batchSize, `batch_${batch}`);
      await store.write(metrics);
      if (batch < totalBatches - 1) {
        await Bun.sleep(intervalMs);
      }
    }

    const totalMetrics = totalBatches * batchSize;

    // Simulate crash: do NOT call store.close() — no WAL checkpoint
    // Re-open the daily file and recover
    const dbFiles = findDailyFiles(tmpDir);
    expect(dbFiles.length).toBe(1);

    const recoveryDb = new Database(join(tmpDir, dbFiles[0]!));
    recoveryDb.exec("PRAGMA journal_mode = WAL");
    recoveryDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const row = recoveryDb
      .prepare("SELECT COUNT(*) as cnt FROM metrics")
      .get() as { cnt: number };
    recoveryDb.close();

    const recovered = row.cnt;

    // At most 1 second of data can be lost with synchronous=NORMAL
    // 1 second = 10 batches × 10 metrics = 100 metrics max loss
    const maxLoss = Math.ceil(1000 / intervalMs) * batchSize;
    const minRecovered = totalMetrics - maxLoss;

    expect(recovered).toBeGreaterThanOrEqual(minRecovered);
    expect(recovered).toBeLessThanOrEqual(totalMetrics);

    // In practice, most or all data should survive because SQLite commits
    // each transaction to the WAL immediately with synchronous=NORMAL
    // (WAL pages are written to disk, just not fsync'd at every commit)

    // Cleanup
    await store.close();
    openStores.length = 0;
  }, 15_000); // 15s timeout — test writes 50 batches × 100ms = ~5s + overhead

  // -------------------------------------------------------------------------
  // 5.1.4 — Corruption detection: corrupt file moved aside, fresh DB created
  // -------------------------------------------------------------------------

  it("5.1.4: corruption detection — corrupt file moved aside, fresh DB usable", async () => {
    const tmpDir = makeTempDir("514");

    // Step 1: Create a valid local store and write some data
    const store1 = new LocalStoreOutput(makeLocalStoreConfig(tmpDir));
    await store1.connect();
    await store1.write(makeMetrics(100));
    await store1.close();

    // Verify data was written
    const dbFiles = findDailyFiles(tmpDir);
    expect(dbFiles.length).toBe(1);
    const dbPath = join(tmpDir, dbFiles[0]!);

    const beforeCount = countRows(dbPath);
    expect(beforeCount).toBe(100);

    // Step 2: Corrupt the database file (write random bytes into data pages)
    const dbBuffer = readFileSync(dbPath);
    // Corrupt bytes in the middle of the file (avoid the 100-byte header
    // so SQLite can still open the file — corruption is detected by integrity_check)
    const offset = Math.min(4096, Math.floor(dbBuffer.length / 2));
    for (let i = 0; i < 256; i++) {
      dbBuffer[offset + i] = Math.floor(Math.random() * 256);
    }
    writeFileSync(dbPath, dbBuffer);

    // Step 3: Re-open with integrity_check enabled (PRD §8)
    const store2 = new LocalStoreOutput(
      makeLocalStoreConfig(tmpDir, { integrity_check: true }),
    );
    openStores.push(store2);
    await store2.connect();

    // Step 4: Verify corrupt file was moved aside
    const allFiles = readdirSync(tmpDir);
    const corruptFiles = allFiles.filter((f) => f.includes(".corrupt."));
    expect(corruptFiles.length).toBeGreaterThanOrEqual(1);

    // Step 5: Verify a fresh DB was created and is usable
    const freshFiles = findDailyFiles(tmpDir);
    expect(freshFiles.length).toBe(1);

    // Write new data to the fresh DB — should succeed
    await store2.write(makeMetrics(50, "post_recovery"));
    await store2.close();
    openStores.length = 0;

    // Verify new data was written
    const freshCount = countRows(join(tmpDir, freshFiles[0]!));
    expect(freshCount).toBe(50);
  });
});
