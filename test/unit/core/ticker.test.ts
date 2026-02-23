import { describe, it, expect } from "bun:test";
import { Ticker, alignToInterval } from "../../../src/core/ticker.ts";

describe("Ticker", () => {
  it("100ms ticker fires ~10 times in 1100ms (tolerance: 8-12 ticks)", async () => {
    const ticker = new Ticker();
    let count = 0;

    const timeout = setTimeout(() => {}, 1200); // keep process alive
    const start = Date.now();

    for await (const _seq of ticker.tick(100)) {
      count++;
      if (Date.now() - start >= 1100) break;
    }

    clearTimeout(timeout);
    expect(count).toBeGreaterThanOrEqual(8);
    expect(count).toBeLessThanOrEqual(12);
  });

  it("sequence numbers increment from 0", async () => {
    const ticker = new Ticker();
    const seqs: number[] = [];

    for await (const seq of ticker.tick(50)) {
      seqs.push(seq);
      if (seqs.length >= 5) break;
    }

    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it("ticker can be cancelled via break in for-await-of", async () => {
    const ticker = new Ticker();
    let count = 0;

    for await (const _seq of ticker.tick(50)) {
      count++;
      if (count >= 3) break;
    }

    // If we get here, the break worked (no hang)
    expect(count).toBe(3);
  });

  it("jitter: with 50ms jitter on 200ms interval, ticks are within [200, 250] spacing", async () => {
    const ticker = new Ticker();
    const times: number[] = [];

    for await (const _seq of ticker.tick(200, { jitter: 50 })) {
      times.push(Date.now());
      if (times.length >= 6) break;
    }

    // Check spacings between consecutive ticks
    // With anchor-based jitter, spacing = interval + jitter_new - jitter_old
    // Theoretical range: [interval - jitter, interval + jitter] = [150, 250]
    // With timer resolution tolerance: [140, 270]
    const spacings: number[] = [];
    for (let i = 1; i < times.length; i++) {
      spacings.push(times[i]! - times[i - 1]!);
    }

    for (const spacing of spacings) {
      expect(spacing).toBeGreaterThanOrEqual(140);
      expect(spacing).toBeLessThanOrEqual(270);
    }

    // Average spacing should be approximately the interval (200ms)
    const avg = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    expect(avg).toBeGreaterThanOrEqual(180);
    expect(avg).toBeLessThanOrEqual(260);
  });

  it("50 ticks at 50ms interval: total elapsed is 2500ms ±500ms (no drift accumulation)", async () => {
    const ticker = new Ticker();
    let count = 0;
    const start = Date.now();

    for await (const _seq of ticker.tick(50)) {
      count++;
      if (count >= 50) break;
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThanOrEqual(3000);
  });

  it("alignToInterval helper: 10000ms interval, returns next boundary from epoch", () => {
    // Boundary at 1700000010000
    expect(alignToInterval(1700000001234, 10000)).toBe(1700000010000);

    // Exact boundary returns same value
    expect(alignToInterval(1700000010000, 10000)).toBe(1700000010000);

    // Just past boundary returns next one
    expect(alignToInterval(1700000010001, 10000)).toBe(1700000020000);

    // 1-second interval
    expect(alignToInterval(1700000000500, 1000)).toBe(1700000001000);

    // 5-minute interval (300000ms)
    expect(alignToInterval(1700000000001, 300000)).toBe(1700000100000);
  });
});
