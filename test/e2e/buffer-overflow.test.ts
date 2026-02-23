// E2E test: Buffer overflow & backpressure
// Phase 5 task 5.3 — proves buffer limits enforced, overflow policy works, transaction model correct
// PRD refs: §12 Buffers & Delivery Guarantees
//
// Note: The S&F buffer is NOT wired into PipelineRuntime's output flush loop.
// These tests validate the buffer in isolation. Runtime/buffer integration is
// a Phase 7 prerequisite (documented in plans/phase-5-progress.md).

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMetric, type Metric } from "@core/metric";
import {
  StoreForwardBuffer,
  StoreForwardConfigSchema,
} from "@buffer/store-forward";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(
  count: number,
  startCounter = 1,
  namePrefix = "buffer_test",
): Metric[] {
  const metrics: Metric[] = [];
  for (let i = 0; i < count; i++) {
    metrics.push(
      createMetric({
        name: namePrefix,
        fields: { counter: startCounter + i, value: (startCounter + i) * 0.1 },
        tags: { host: "test-rig" },
      }),
    );
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
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

describe("E2E: Buffer overflow & backpressure (task 5.3)", () => {
  // -------------------------------------------------------------------------
  // 5.3.1 — drop_oldest overflow: buffer limit enforced
  // -------------------------------------------------------------------------

  it("5.3.1: drop_oldest overflow — limit enforced, oldest evicted, newest retained", () => {
    const tmpDir = makeTempDir("531");
    const bufferPath = join(tmpDir, "buffer.db");

    const config = StoreForwardConfigSchema.parse({
      metric_buffer_limit: 100,
      metric_batch_size: 100,
    });

    const buffer = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer.open();

    // Add 200 metrics (counters 1-200)
    buffer.add(makeMetrics(200, 1));

    // Buffer limit enforced: oldest 100 dropped
    expect(buffer.length).toBe(100);

    // Begin transaction — should return the NEWEST 100 (counters 101-200)
    const tx = buffer.beginTransaction(100);
    const metrics = tx.metrics();
    expect(metrics.length).toBe(100);

    // Verify these are the newest metrics
    const counters = metrics.map((m) => m.getField("counter") as number);
    expect(counters[0]).toBe(101);
    expect(counters[99]).toBe(200);

    // Counters in ascending order (buffer reads oldest-first by id)
    for (let i = 1; i < counters.length; i++) {
      expect(counters[i]).toBeGreaterThan(counters[i - 1]!);
    }

    tx.acceptAll();
    expect(buffer.length).toBe(0);
    buffer.close();
  });

  // -------------------------------------------------------------------------
  // 5.3.2 — Buffer with failing output (isolation test)
  //
  // S&F buffer is not wired into PipelineRuntime flush loop — tested in
  // isolation per plan guidance. Runtime integration is a Phase 7 prerequisite.
  // -------------------------------------------------------------------------

  it("5.3.2: failing output isolation — keepAll preserves metrics for retry, acceptAll clears on success", () => {
    const tmpDir = makeTempDir("532");
    const bufferPath = join(tmpDir, "buffer.db");

    const config = StoreForwardConfigSchema.parse({
      metric_buffer_limit: 500,
      metric_batch_size: 50,
    });

    const buffer = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer.open();

    // Add 100 metrics (counters 1-100)
    buffer.add(makeMetrics(100, 1));
    expect(buffer.length).toBe(100);

    // Simulate 3 failed write attempts: begin transaction, keepAll each time
    for (let attempt = 0; attempt < 3; attempt++) {
      const tx = buffer.beginTransaction(50);
      expect(tx.metrics().length).toBe(50);

      // Simulate write failure — keep all for retry
      tx.keepAll();

      // Buffer length unchanged (nothing removed)
      expect(buffer.length).toBe(100);
    }

    // After repeated failures, same first 50 metrics still available (at-least-once)
    const tx = buffer.beginTransaction(50);
    const retryMetrics = tx.metrics();
    expect(retryMetrics.length).toBe(50);
    expect(retryMetrics[0]!.getField("counter") as number).toBe(1);
    expect(retryMetrics[49]!.getField("counter") as number).toBe(50);

    // Simulate successful write — acceptAll removes delivered metrics
    tx.acceptAll();
    expect(buffer.length).toBe(50);

    // Next transaction returns the remaining 50 (counters 51-100)
    const tx2 = buffer.beginTransaction(50);
    const remaining = tx2.metrics();
    expect(remaining.length).toBe(50);
    expect(remaining[0]!.getField("counter") as number).toBe(51);
    expect(remaining[49]!.getField("counter") as number).toBe(100);

    tx2.acceptAll();
    expect(buffer.length).toBe(0);

    buffer.close();
  });

  // -------------------------------------------------------------------------
  // 5.3.3 — Partial write: accept/reject/keep granularity
  // -------------------------------------------------------------------------

  it("5.3.3: partial write — accept/reject/keep granularity correct, subsequent transaction starts at right place", () => {
    const tmpDir = makeTempDir("533");
    const bufferPath = join(tmpDir, "buffer.db");

    const config = StoreForwardConfigSchema.parse({
      metric_buffer_limit: 10000,
      metric_batch_size: 50,
    });

    const buffer = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer.open();

    // Add 100 metrics (counters 1-100)
    buffer.add(makeMetrics(100, 1));
    expect(buffer.length).toBe(100);

    // Begin transaction: read oldest 50 (counters 1-50)
    const tx = buffer.beginTransaction(50);
    const batch = tx.metrics();
    expect(batch.length).toBe(50);
    expect(batch[0]!.getField("counter") as number).toBe(1);
    expect(batch[49]!.getField("counter") as number).toBe(50);

    // Simulate partial write:
    // - Accept indices 0-29 (counters 1-30) — successfully delivered
    // - Reject indices 30-39 (counters 31-40) — permanently failed, discard
    // - Indices 40-49 (counters 41-50) — not handled, implicitly kept for retry
    const acceptIndices = Array.from({ length: 30 }, (_, i) => i);
    const rejectIndices = Array.from({ length: 10 }, (_, i) => 30 + i);
    tx.accept(acceptIndices);
    tx.reject(rejectIndices);

    // Buffer length: 100 - 30 (accepted) - 10 (rejected) = 60
    expect(buffer.length).toBe(60);

    // Next transaction: oldest 50 should be:
    //   - 10 "kept" metrics (counters 41-50, ids lower than untouched)
    //   - 40 "untouched" metrics (counters 51-90, next oldest by id)
    // Both ranges form a contiguous counter sequence: 41, 42, ..., 90
    const tx2 = buffer.beginTransaction(50);
    const batch2 = tx2.metrics();
    expect(batch2.length).toBe(50);

    for (let i = 0; i < 50; i++) {
      expect(batch2[i]!.getField("counter") as number).toBe(41 + i);
    }

    tx2.acceptAll();
    expect(buffer.length).toBe(10); // 60 - 50 = 10 remaining (counters 91-100)

    // Verify remaining 10 are counters 91-100
    const tx3 = buffer.beginTransaction(10);
    const batch3 = tx3.metrics();
    expect(batch3.length).toBe(10);
    expect(batch3[0]!.getField("counter") as number).toBe(91);
    expect(batch3[9]!.getField("counter") as number).toBe(100);

    tx3.acceptAll();
    expect(buffer.length).toBe(0);

    buffer.close();
  });

  // -------------------------------------------------------------------------
  // 5.3.4 — Unacknowledged transaction survives restart
  // -------------------------------------------------------------------------

  it("5.3.4: unacknowledged transaction — metrics survive restart, at-least-once guarantee", () => {
    const tmpDir = makeTempDir("534");
    const bufferPath = join(tmpDir, "buffer.db");

    const config = StoreForwardConfigSchema.parse({
      metric_buffer_limit: 10000,
      metric_batch_size: 50,
    });

    // Session 1: add 100, accept first 50, add 50 more, begin transaction but don't resolve
    const buffer1 = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer1.open();

    buffer1.add(makeMetrics(100, 1));
    expect(buffer1.length).toBe(100);

    // Accept first 50 (counters 1-50)
    const tx1 = buffer1.beginTransaction(50);
    expect(tx1.metrics()[0]!.getField("counter") as number).toBe(1);
    tx1.acceptAll();
    expect(buffer1.length).toBe(50); // counters 51-100 remain

    // Add 50 more (counters 101-150)
    buffer1.add(makeMetrics(50, 101));
    expect(buffer1.length).toBe(100); // 50 remaining + 50 new

    // Begin transaction but don't resolve (simulates crash)
    const tx2 = buffer1.beginTransaction(50);
    expect(tx2.metrics().length).toBe(50);
    expect(tx2.metrics()[0]!.getField("counter") as number).toBe(51);

    // Close without resolving
    buffer1.close();

    // Session 2: re-open and verify all 100 metrics survived
    const buffer2 = new StoreForwardBuffer("test_output", bufferPath, config);
    buffer2.open();

    expect(buffer2.length).toBe(100);

    // The unresolved transaction's metrics are still there (at-least-once)
    const tx3 = buffer2.beginTransaction(100);
    const recovered = tx3.metrics();
    expect(recovered.length).toBe(100);

    // First 50: counters 51-100 (from original batch, unresolved tx)
    expect(recovered[0]!.getField("counter") as number).toBe(51);
    expect(recovered[49]!.getField("counter") as number).toBe(100);

    // Next 50: counters 101-150 (from added batch)
    expect(recovered[50]!.getField("counter") as number).toBe(101);
    expect(recovered[99]!.getField("counter") as number).toBe(150);

    tx3.acceptAll();
    expect(buffer2.length).toBe(0);

    buffer2.close();
  });
});
