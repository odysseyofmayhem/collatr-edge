// Integration test: S&F buffer with output
// Verifies buffer wraps output, handles failures, and recovers after simulated crash.
// PRD refs: §12 Buffers & Delivery Guarantees

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  StoreForwardBuffer,
  StoreForwardConfigSchema,
} from "@buffer/store-forward";
import { createMetric } from "@core/metric";
import type { Metric } from "@core/metric";
import type { Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock outputs
// ---------------------------------------------------------------------------

/** Mock output that always succeeds. Records delivered metrics. */
class SuccessOutput implements Output {
  delivered: Metric[][] = [];
  async connect(): Promise<void> {}
  async write(batch: Metric[]): Promise<void> {
    this.delivered.push(batch);
  }
  async close(): Promise<void> {}
}

/** Mock output that always fails. */
class FailingOutput implements Output {
  writeAttempts = 0;
  async connect(): Promise<void> {}
  async write(_batch: Metric[]): Promise<void> {
    this.writeAttempts++;
    throw new Error("Remote server unreachable");
  }
  async close(): Promise<void> {}
}

/**
 * Mock output that partially fails.
 * Accepts even-indexed metrics, rejects odd-indexed metrics.
 */
class PartialOutput implements Output {
  accepted: Metric[] = [];
  rejected: Metric[] = [];
  async connect(): Promise<void> {}
  async write(batch: Metric[]): Promise<void> {
    const acceptIndices: number[] = [];
    const rejectIndices: number[] = [];
    for (let i = 0; i < batch.length; i++) {
      if (i % 2 === 0) {
        acceptIndices.push(i);
        this.accepted.push(batch[i]!);
      } else {
        rejectIndices.push(i);
        this.rejected.push(batch[i]!);
      }
    }
    // Throw a PartialWriteError-style error with indices
    const err = new Error("Partial write failure") as Error & {
      acceptIndices: number[];
      rejectIndices: number[];
    };
    err.acceptIndices = acceptIndices;
    err.rejectIndices = rejectIndices;
    throw err;
  }
  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "collatr-buffer-int-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function dbPath(): string {
  return join(tempDir, "buffer.db");
}

function makeMetrics(count: number): Metric[] {
  return Array.from({ length: count }, (_, i) =>
    createMetric({
      name: `metric_${i}`,
      fields: { value: i * 10 },
      tags: { index: String(i) },
      timestamp: 1700000000000000000n + BigInt(i) * 1000000000n,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests — PRD §12 write transaction model with real outputs
// ---------------------------------------------------------------------------

describe("Integration: S&F buffer + output", () => {
  it("Buffer + successful output: metrics delivered and buffer drained", async () => {
    const config = StoreForwardConfigSchema.parse({ metric_batch_size: 10 });
    const buf = new StoreForwardBuffer("success_out", dbPath(), config);
    buf.open();

    const output = new SuccessOutput();
    await output.connect();

    // Add metrics to buffer
    buf.add(makeMetrics(5));
    expect(buf.length).toBe(5);

    // Simulate flush cycle: buffer → output
    const tx = buf.beginTransaction();
    await output.write(tx.metrics());
    tx.acceptAll();

    // Buffer should be drained
    expect(buf.length).toBe(0);

    // Output received all 5 metrics
    expect(output.delivered.length).toBe(1);
    expect(output.delivered[0]!.length).toBe(5);
    expect(output.delivered[0]![0]!.name).toBe("metric_0");
    expect(output.delivered[0]![4]!.name).toBe("metric_4");

    buf.close();
    await output.close();
  });

  it("Buffer + failing output: metrics retained for retry", async () => {
    const config = StoreForwardConfigSchema.parse({ metric_batch_size: 10 });
    const buf = new StoreForwardBuffer("fail_out", dbPath(), config);
    buf.open();

    const output = new FailingOutput();
    await output.connect();

    buf.add(makeMetrics(3));
    expect(buf.length).toBe(3);

    // First attempt: output fails → keepAll
    const tx1 = buf.beginTransaction();
    try {
      await output.write(tx1.metrics());
      tx1.acceptAll();
    } catch {
      tx1.keepAll();
    }

    // Metrics still in buffer
    expect(buf.length).toBe(3);
    expect(output.writeAttempts).toBe(1);

    // Second attempt: still fails → keepAll again
    const tx2 = buf.beginTransaction();
    try {
      await output.write(tx2.metrics());
      tx2.acceptAll();
    } catch {
      tx2.keepAll();
    }

    // Metrics still retained for retry
    expect(buf.length).toBe(3);
    expect(output.writeAttempts).toBe(2);

    // Metrics are the same originals (correct order, correct data)
    const tx3 = buf.beginTransaction();
    expect(tx3.metrics()[0]!.name).toBe("metric_0");
    expect(tx3.metrics()[1]!.name).toBe("metric_1");
    expect(tx3.metrics()[2]!.name).toBe("metric_2");

    buf.close();
    await output.close();
  });

  it("Buffer + partial failure: accepted removed, rejected removed, rest kept", async () => {
    const config = StoreForwardConfigSchema.parse({ metric_batch_size: 10 });
    const buf = new StoreForwardBuffer("partial_out", dbPath(), config);
    buf.open();

    const output = new PartialOutput();
    await output.connect();

    // Add 5 metrics: metric_0 through metric_4
    buf.add(makeMetrics(5));
    expect(buf.length).toBe(5);

    // Flush: partial output accepts even indices (0, 2, 4), rejects odd (1, 3)
    const tx = buf.beginTransaction();
    try {
      await output.write(tx.metrics());
      tx.acceptAll();
    } catch (e) {
      const err = e as Error & { acceptIndices: number[]; rejectIndices: number[] };
      // Accept the successful ones (remove from buffer)
      tx.accept(err.acceptIndices);
      // Reject the permanently failed ones (also remove — they'll never succeed)
      tx.reject(err.rejectIndices);
    }

    // All metrics should be removed (3 accepted + 2 rejected = 5 total)
    expect(buf.length).toBe(0);

    // Output tracked what it processed
    expect(output.accepted.length).toBe(3); // indices 0, 2, 4
    expect(output.rejected.length).toBe(2); // indices 1, 3

    buf.close();
    await output.close();
  });

  it("Crash recovery: buffer survives simulated restart", async () => {
    const config = StoreForwardConfigSchema.parse({ metric_batch_size: 10 });
    const path = dbPath();

    // Session 1: add metrics, output fails, buffer keeps them
    const buf1 = new StoreForwardBuffer("crash_out", path, config);
    buf1.open();

    const failOutput = new FailingOutput();
    await failOutput.connect();

    buf1.add(makeMetrics(4));

    const tx = buf1.beginTransaction();
    try {
      await failOutput.write(tx.metrics());
      tx.acceptAll();
    } catch {
      tx.keepAll();
    }

    expect(buf1.length).toBe(4);

    // Simulate crash: close without graceful shutdown
    buf1.close();

    // Session 2: reopen buffer and successfully deliver
    const buf2 = new StoreForwardBuffer("crash_out", path, config);
    buf2.open();

    // Metrics survived the restart
    expect(buf2.length).toBe(4);

    const successOutput = new SuccessOutput();
    await successOutput.connect();

    const tx2 = buf2.beginTransaction();
    expect(tx2.metrics().length).toBe(4);
    expect(tx2.metrics()[0]!.name).toBe("metric_0");
    expect(tx2.metrics()[3]!.name).toBe("metric_3");

    // Successfully deliver this time
    await successOutput.write(tx2.metrics());
    tx2.acceptAll();

    expect(buf2.length).toBe(0);
    expect(successOutput.delivered[0]!.length).toBe(4);

    buf2.close();
    await successOutput.close();
  });
});
